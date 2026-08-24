# backend/spot_analysis.py
"""
Spot Replay — parameterized quantitative options-analysis pipeline.

This is the dynamic, reusable port of the static `crwd_analysis.py` script (see
files/generate.md / files/SKILL.md for the original one-off version). Instead of a
hardcoded CRWD position, every input is a parameter and the result is a plain
JSON-serializable dict shaped for the SpotReplay frontend report.

Pipeline stages (identical math to the original):
  1. Technical indicators   (RSI, MACD, Bollinger, ATR, SMA distances)
  2. Volatility calibration (Close-Close, Parkinson, Garman-Klass, Yang-Zhang)
  3. ATR movement analysis  (distance-to-strike in ATR units)
  4. Monte Carlo            (GBM, 8 weighted volatility regimes, 500K paths)
  5. ARIMA                  (AIC grid-search order selection + forecast CIs)
  6. ML models              (GradientBoosting + RandomForest, iterative forecast)
  7. Historical analogs     (RSI / SMA-distance pattern match)
  8. Ensemble               (P(ITM), EV hold-vs-sell, Kelly fraction, verdict)

Working principles for this build:
  "Are you sure this is the best you can do?"
  "I think you can do better, try again"
  "Take a closer look, give me 11/10 output"
  "Finish it, where there is a will there is a way"
  "Keep going, believe in yourself"

Dependencies: numpy pandas scikit-learn statsmodels (already in requirements.txt).
"""

import warnings
from datetime import datetime

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.preprocessing import StandardScaler
from statsmodels.tsa.arima.model import ARIMA

warnings.filterwarnings("ignore")

# Number of Monte Carlo paths per regime — same as the original analysis.
N_SIM = 500_000


def _trading_days_between(start: datetime, expiry: datetime) -> int:
    """Trading days between two dates (skips weekends; market holidays ignored —
    the error is at most ±1-2 days per year and doesn't move short-dated probabilities much)."""
    if expiry <= start:
        return 1
    days = 0
    cur = start
    while cur < expiry:
        cur = cur + pd.Timedelta(days=1)
        if cur.weekday() < 5:
            days += 1
    return max(1, days)


def run_analysis(df: pd.DataFrame, position: dict) -> dict:
    """Run the full 8-stage pipeline.

    df: daily OHLCV DataFrame indexed by date with columns open/high/low/close/volume.
    position: {
      ticker, option_type ('Put'|'Call'), strike, expiry (datetime),
      purchase_date, avg_cost, contracts, current_option_price
    }
    Returns a JSON-ready dict for the frontend report.
    """
    ticker = position["ticker"].upper()
    option_type = position["option_type"]
    strike = float(position["strike"])
    avg_cost = float(position.get("avg_cost") or 0.0)
    contracts = int(position.get("contracts") or 1)
    opt_price = float(position.get("current_option_price") or 0.0)

    today = datetime.now()
    # Accept either a datetime or an ISO "YYYY-MM-DD" string — the SSE route
    # passes JSON-decoded strings, direct callers may pass datetimes.
    raw_expiry = position["expiry"]
    expiry = (datetime.strptime(raw_expiry, "%Y-%m-%d")
              if isinstance(raw_expiry, str) else raw_expiry)
    days_left = _trading_days_between(today, expiry)
    # A past-dated expiry can't be forecast forward — clamp to 1 day of
    # distribution but flag it so the UI can tell the user the position has
    # already expired rather than showing misleading probabilities.
    expired = expiry.date() <= today.date()
    breakeven = strike - avg_cost if option_type == "Put" else strike + avg_cost

    df = df.sort_index().dropna(subset=["open", "high", "low", "close"])
    current_price = float(df["close"].iloc[-1])

    # ── STAGE 1: technical indicators ─────────────────────────────────────────
    df["log_ret"] = np.log(df["close"] / df["close"].shift(1))
    df["ret"] = df["close"].pct_change()

    delta = df["close"].diff()
    gain = delta.where(delta > 0, 0).rolling(14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
    df["rsi"] = 100 - (100 / (1 + gain / loss))

    ema12 = df["close"].ewm(span=12).mean()
    ema26 = df["close"].ewm(span=26).mean()
    df["macd"] = ema12 - ema26
    df["macd_signal"] = df["macd"].ewm(span=9).mean()
    df["macd_hist"] = df["macd"] - df["macd_signal"]

    df["bb_mid"] = df["close"].rolling(20).mean()
    df["bb_std"] = df["close"].rolling(20).std()
    df["bb_upper"] = df["bb_mid"] + 2 * df["bb_std"]
    df["bb_lower"] = df["bb_mid"] - 2 * df["bb_std"]

    df["tr"] = np.maximum(
        df["high"] - df["low"],
        np.maximum(
            abs(df["high"] - df["close"].shift(1)),
            abs(df["low"] - df["close"].shift(1)),
        ),
    )
    df["atr14"] = df["tr"].rolling(14).mean()
    df["atr5"] = df["tr"].rolling(5).mean()

    df["dist_sma5"] = df["close"] / df["close"].rolling(5).mean() - 1
    df["dist_sma10"] = df["close"] / df["close"].rolling(10).mean() - 1
    df["dist_sma20"] = df["close"] / df["close"].rolling(20).mean() - 1

    atr14 = float(df["atr14"].iloc[-1])
    distance_to_strike = abs(current_price - strike)
    distance_in_atr = distance_to_strike / atr14 if atr14 else None

    # ── STAGE 2: multi-estimator volatility calibration ───────────────────────
    df_clean = df.dropna(subset=["log_ret"])

    df["parkinson"] = np.sqrt(np.log(df["high"] / df["low"]) ** 2 / (4 * np.log(2)))
    df["gk"] = np.sqrt(
        0.5 * np.log(df["high"] / df["low"]) ** 2
        - (2 * np.log(2) - 1) * np.log(df["close"] / df["open"]) ** 2
    )

    def _yang_zhang_vol(frame: pd.DataFrame, window: int = 10) -> pd.Series:
        n = window
        log_ho = np.log(frame["high"] / frame["open"])
        log_lo = np.log(frame["low"] / frame["open"])
        log_co = np.log(frame["close"] / frame["open"])
        log_oc = np.log(frame["open"] / frame["close"].shift(1))
        close_vol = log_oc.rolling(n).var()
        open_vol = log_co.rolling(n).var()
        window_vol = (log_ho * (log_ho - log_co) + log_lo * (log_lo - log_co)).rolling(n).mean()
        k = 0.34 / (1.34 + (n + 1) / (n - 1))
        return np.sqrt(close_vol + k * open_vol + (1 - k) * window_vol) * np.sqrt(252)

    df["yz_vol"] = _yang_zhang_vol(df, 10)
    yz_current = float(df["yz_vol"].iloc[-1]) if not np.isnan(df["yz_vol"].iloc[-1]) else None

    # Vol estimator × window table (daily sigma + annualized), for the report.
    vol_table = {}
    for name, series in (
        ("Close-Close", df_clean["log_ret"]),
        ("Parkinson", df["parkinson"]),
        ("Garman-Klass", df["gk"]),
    ):
        vol_table[name] = {
            "5d": float(series.tail(5).std() if name == "Close-Close" else series.tail(5).mean()),
            "10d": float(series.tail(10).std() if name == "Close-Close" else series.tail(10).mean()),
            "20d": float(series.tail(20).std() if name == "Close-Close" else series.tail(20).mean()),
        }
        vol_table[name]["annualized_20d"] = float(vol_table[name]["20d"] * np.sqrt(252))
    vol_table["Yang-Zhang"] = {"10d": yz_current / np.sqrt(252) if yz_current else None,
                               "annualized_10d": yz_current}

    # ── STAGE 3: ATR movement analysis ────────────────────────────────────────
    closes = df["close"].values
    nd_returns = []
    for i in range(len(closes) - days_left):
        nd_returns.append(closes[i + days_left] / closes[i] - 1)
    nd_returns = np.array(nd_returns) if len(nd_returns) else np.array([0.0])

    hist_percentiles = {
        str(p): {
            "return": float(np.percentile(nd_returns, p)),
            "implied_price": float(current_price * (1 + np.percentile(nd_returns, p))),
            "itm": bool(
                current_price * (1 + np.percentile(nd_returns, p)) <= strike
                if option_type == "Put"
                else current_price * (1 + np.percentile(nd_returns, p)) >= strike
            ),
        }
        for p in (5, 10, 25, 50, 75, 90, 95)
    }

    # ── STAGE 4: Monte Carlo — 8 regimes, 500K paths each ────────────────────
    fallback_sigma = float(df_clean["log_ret"].tail(5).std())
    regimes = {
        "A: CC 10d": {"mu": float(df_clean["log_ret"].tail(10).mean()), "sigma": float(df_clean["log_ret"].tail(10).std())},
        "B: CC 5d": {"mu": float(df_clean["log_ret"].tail(5).mean()), "sigma": float(df_clean["log_ret"].tail(5).std())},
        "C: Parkinson 5d": {"mu": float(df_clean["log_ret"].tail(5).mean()), "sigma": float(df["parkinson"].tail(5).mean())},
        "D: Garman-Klass 5d": {"mu": float(df_clean["log_ret"].tail(5).mean()), "sigma": float(df["gk"].tail(5).mean())},
        "E: Full-history": {"mu": float(df_clean["log_ret"].mean()), "sigma": float(df_clean["log_ret"].std())},
        "F: Yang-Zhang 10d": {
            "mu": float(df_clean["log_ret"].tail(10).mean()),
            "sigma": (yz_current / np.sqrt(252)) if yz_current else fallback_sigma,
        },
        "G: Bearish (3d drift)": {"mu": float(df_clean["log_ret"].tail(3).mean()), "sigma": float(df_clean["log_ret"].tail(3).std())},
        "H: Stressed (1.5x)": {"mu": float(df_clean["log_ret"].tail(5).mean()), "sigma": fallback_sigma * 1.5},
    }
    regime_weights = {
        "A: CC 10d": 0.15, "B: CC 5d": 0.15,
        "C: Parkinson 5d": 0.15, "D: Garman-Klass 5d": 0.10,
        "E: Full-history": 0.05, "F: Yang-Zhang 10d": 0.15,
        "G: Bearish (3d drift)": 0.15, "H: Stressed (1.5x)": 0.10,
    }

    mc_results = {}
    rng = np.random.default_rng(42)
    final_samples = {}
    for label, params in regimes.items():
        mu, sig = params["mu"], params["sigma"]
        Z = rng.standard_normal((N_SIM, days_left))
        log_returns = (mu - 0.5 * sig**2) + sig * Z
        cum = np.cumsum(log_returns, axis=1)
        finals = current_price * np.exp(cum[:, -1])
        final_samples[label] = finals
        itm_mask = finals <= strike if option_type == "Put" else finals >= strike
        mc_results[label] = {
            "mu": mu,
            "sigma_daily": sig,
            "sigma_annualized": sig * np.sqrt(252),
            "p_itm_pct": float(np.mean(itm_mask) * 100),
            "median_final": float(np.median(finals)),
            "pct5": float(np.percentile(finals, 5)),
            "pct95": float(np.percentile(finals, 95)),
        }

    # Blended mixture distribution (weighted sample of each regime's finals).
    blended_parts = []
    for label, weight in regime_weights.items():
        take = int(weight * 100_000)
        idx = rng.choice(len(final_samples[label]), size=take, replace=True)
        blended_parts.append(final_samples[label][idx])
    blended = np.concatenate(blended_parts)

    # ── STAGE 5: ARIMA with AIC order selection ───────────────────────────────
    best_aic, best_order, best_model = np.inf, None, None
    close_values = df["close"].values
    for p in range(5):
        for d_ord in range(2):
            for q in range(5):
                try:
                    fitted = ARIMA(close_values, order=(p, d_ord, q)).fit()
                    if fitted.aic < best_aic:
                        best_aic, best_order, best_model = fitted.aic, (p, d_ord, q), fitted
                except Exception:
                    continue
    forecast = best_model.forecast(steps=days_left) if best_model else [current_price]
    fc_obj = best_model.get_forecast(steps=days_left) if best_model else None
    ci90 = fc_obj.conf_int(alpha=0.1) if fc_obj else np.zeros((days_left, 2))
    ci95 = fc_obj.conf_int(alpha=0.05) if fc_obj else np.zeros((days_left, 2))

    def _itm_flag(price: float) -> bool:
        return price <= strike if option_type == "Put" else price >= strike

    arima_block = {
        "order": list(best_order) if best_order else None,
        "aic": float(best_aic) if np.isfinite(best_aic) else None,
        "forecast": [float(x) for x in np.atleast_1d(forecast)],
        "ci90_lower": [float(x) for x in np.atleast_1d(ci90[:, 0])],
        "ci90_upper": [float(x) for x in np.atleast_1d(ci90[:, 1])],
        "ci95_lower": [float(x) for x in np.atleast_1d(ci95[:, 0])],
        "ci95_upper": [float(x) for x in np.atleast_1d(ci95[:, 1])],
        "final_in_ci90": bool(min(np.atleast_1d(ci90[-1, 0]), np.atleast_1d(ci90[-1, 1])) <= strike <= max(np.atleast_1d(ci90[-1, 0]), np.atleast_1d(ci90[-1, 1]))) if fc_obj else False,
        "final_calls_itm": bool(_itm_flag(float(np.atleast_1d(forecast)[-1]))),
    }

    # ── STAGE 6: ML models (GB + RF), iterative multi-day forecast ───────────
    df_ml = df.copy()
    for lag in range(1, 8):
        df_ml[f"ret_lag{lag}"] = df_ml["ret"].shift(lag)
        df_ml[f"logret_lag{lag}"] = df_ml["log_ret"].shift(lag)
    df_ml["vol_3d"] = df_ml["log_ret"].rolling(3).std()
    df_ml["vol_5d"] = df_ml["log_ret"].rolling(5).std()
    df_ml["vol_10d"] = df_ml["log_ret"].rolling(10).std()
    df_ml["range_pct"] = (df_ml["high"] - df_ml["low"]) / df_ml["close"]
    df_ml["range_lag1"] = df_ml["range_pct"].shift(1)
    df_ml["gap"] = df_ml["open"] / df_ml["close"].shift(1) - 1
    df_ml["target"] = df_ml["ret"].shift(-1)

    feature_cols = (
        [f"ret_lag{i}" for i in range(1, 6)]
        + [f"logret_lag{i}" for i in range(1, 4)]
        + ["vol_3d", "vol_5d", "range_pct", "range_lag1", "gap", "rsi", "dist_sma5", "dist_sma10"]
    )
    df_ml = df_ml.dropna(subset=feature_cols + ["target"])
    X = df_ml[feature_cols].values
    y = df_ml["target"].values
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    ml_models = {}
    ml_preds = {}
    importances = {}
    for name, mdl in [
        ("GradientBoosting", GradientBoostingRegressor(n_estimators=300, max_depth=3, learning_rate=0.03, subsample=0.8, random_state=42)),
        ("RandomForest", RandomForestRegressor(n_estimators=300, max_depth=4, random_state=42)),
    ]:
        mdl.fit(X_scaled, y)
        ml_models[name] = mdl
        try:
            importances[name] = sorted(
                zip(feature_cols, mdl.feature_importances_.tolist()), key=lambda t: -t[1]
            )[:5]
        except Exception:
            importances[name] = []
        prices = [current_price]
        curr_feat = df_ml[feature_cols].iloc[-1:].values.copy()
        for _day in range(days_left):
            pred_ret = float(mdl.predict(scaler.transform(curr_feat))[0])
            prices.append(prices[-1] * (1 + pred_ret))
            new_feat = curr_feat.copy()
            for j in range(min(4, new_feat.shape[1] - 1), 0, -1):
                new_feat[0][j] = new_feat[0][j - 1]
            new_feat[0][0] = pred_ret
            curr_feat = new_feat
        ml_preds[name] = [float(p) for p in prices]

    ml_block = {
        name: {
            "path": ml_preds[name],
            "final_price": ml_preds[name][-1],
            "direction": ("BEARISH" if ml_preds[name][-1] < current_price else "BULLISH"),
            "calls_itm": bool(_itm_flag(ml_preds[name][-1])),
            "top_features": [{"feature": f, "weight": float(w)} for f, w in importances[name]],
        }
        for name in ml_models
    }

    # ── STAGE 7: historical analog pattern match ─────────────────────────────
    current_rsi = float(df["rsi"].iloc[-1])
    current_dist = float(df["dist_sma5"].iloc[-1])
    df["fwd_ret"] = df["close"].shift(-days_left) / df["close"] - 1
    analogs = df.dropna(subset=["fwd_ret", "rsi", "dist_sma5"])
    similar = analogs[
        (analogs["rsi"].between(current_rsi - 10, current_rsi + 10))
        & (analogs["dist_sma5"].between(current_dist - 0.03, current_dist + 0.03))
    ]
    widened = False
    if len(similar) < 3:
        similar = analogs[analogs["rsi"].between(current_rsi - 15, current_rsi + 15)]
        widened = True
    fwd = similar["fwd_ret"].values
    analog_implied_prices = current_price * (1 + fwd)
    analog_itm_pct = (
        float(np.mean(analog_implied_prices <= strike if option_type == "Put"
                      else analog_implied_prices >= strike) * 100)
        if len(fwd)
        else None
    )
    analog_block = {
        "count": int(len(similar)),
        "widened_search": widened,
        "forward_return_mean": float(np.mean(fwd)) if len(fwd) else None,
        "implied_itm_pct": analog_itm_pct,
        "dates": [d.strftime("%Y-%m-%d") for d in similar.index][:12],
    }

    # ── STAGE 8: ensemble & decision matrix ──────────────────────────────────
    payoffs = np.maximum(strike - blended, 0) if option_type == "Put" else np.maximum(blended - strike, 0)
    expected_payoff = float(payoffs.mean())
    prob_itm = float(np.mean(payoffs > 0) * 100)
    avg_payoff_itm = float(payoffs[payoffs > 0].mean()) if np.any(payoffs > 0) else 0.0
    prob_profit = float(
        np.mean(blended <= breakeven if option_type == "Put" else blended >= breakeven) * 100
    )

    if prob_itm > 0 and avg_payoff_itm > 0 and opt_price > 0:
        b_odds = avg_payoff_itm / opt_price
        p_win = prob_itm / 100
        kelly = (b_odds * p_win - (1 - p_win)) / b_odds
    else:
        kelly = None

    ev_hold = expected_payoff * 100 * contracts
    ev_sell = opt_price * 100 * contracts
    recommendation = "HOLD" if ev_hold > ev_sell else "SELL"

    last3 = df["ret"].tail(3).tolist()

    return {
        # position echo-back (the report header is rendered from these)
        "position": {
            "ticker": ticker,
            "option_type": option_type,
            "strike": strike,
            "expiry": expiry.strftime("%Y-%m-%d"),
            "purchase_date": position.get("purchase_date"),
            "avg_cost": avg_cost,
            "contracts": contracts,
            "current_option_price": opt_price,
            "breakeven": float(breakeven),
            "days_left": days_left,
            "expired": expired,
        },
        "market": {
            "current_price": current_price,
            "as_of": df.index[-1].strftime("%Y-%m-%d"),
            "bars_used": int(len(df)),
            "distance_to_strike": float(distance_to_strike),
            "distance_in_atr": float(distance_in_atr) if distance_in_atr is not None else None,
            "rsi": current_rsi,
            "macd_hist": float(df["macd_hist"].iloc[-1]),
            "atr14": atr14,
            "atr_pct_of_price": float(atr14 / current_price * 100),
            "bb_position": float((current_price - df["bb_lower"].iloc[-1]) /
                                 (df["bb_upper"].iloc[-1] - df["bb_lower"].iloc[-1]))
            if df["bb_upper"].iloc[-1] != df["bb_lower"].iloc[-1] else 0.5,
            "consecutive_down_days": int(sum(1 for r in reversed(last3) if r < 0)) if last3 else 0,
        },
        # chart series for the SVG candlestick + forecast overlay (last 60 bars kept lean)
        "chart": {
            "dates": [d.strftime("%Y-%m-%d") for d in df.index],
            "opens": [float(x) for x in df["open"].values],
            "highs": [float(x) for x in df["high"].values],
            "lows": [float(x) for x in df["low"].values],
            "closes": [float(x) for x in df["close"].values],
            "volumes": [int(x) for x in df["volume"].fillna(0).values],
            "sma20": [None if np.isnan(x) else float(x) for x in df["bb_mid"].values],
        },
        "monte_carlo": {
            "n_sim_per_regime": N_SIM,
            "regimes": mc_results,
            "weights": regime_weights,
            "blended_sample": [float(x) for x in blended[:8000]],
            "ensemble_prob_itm_pct": prob_itm,
            "expected_payoff_per_share": expected_payoff,
            "avg_payoff_if_itm": avg_payoff_itm,
            "prob_profit_pct": prob_profit,
        },
        "arima": arima_block,
        "ml": ml_block,
        "vol_estimators": vol_table,
        "historical_analogs": analog_block,
        "history_percentiles": hist_percentiles,
        "decision": {
            "ev_hold": float(ev_hold),
            "ev_sell": float(ev_sell),
            "ev_advantage": float(ev_hold - ev_sell),
            "recommendation": recommendation,
            "kelly_fraction": kelly,
        },
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def summarize_analysis(result: dict) -> str:
    """Plain-text summary block printed/streamed after a run — mirrors the
    original script's console summary format."""
    pos = result["position"]
    mkt = result["market"]
    mc = result["monte_carlo"]
    gb = result["ml"]["GradientBoosting"]["final_price"]
    rf = result["ml"]["RandomForest"]["final_price"]
    fc = result["arima"]["forecast"][-1]
    lines = [
        "=" * 60,
        f"{pos['ticker']} ${pos['strike']} {pos['option_type'].upper()} — SUMMARY",
        "=" * 60,
        f"Current: ${mkt['current_price']:.2f} | Strike: ${pos['strike']:.2f} "
        f"| Distance: {mkt['distance_in_atr']:.1f} ATR | RSI: {mkt['rsi']:.1f}",
        f"P(ITM): {mc['ensemble_prob_itm_pct']:.1f}% | P(profit): {mc['prob_profit_pct']:.1f}%",
        f"EV hold: ${result['decision']['ev_hold']:.2f} | EV sell: ${result['decision']['ev_sell']:.2f}"
        f" | Kelly: {(result['decision']['kelly_fraction'] or 0) * 100:.1f}%",
        f"GB day-{pos['days_left']}: ${gb:.2f} ({result['ml']['GradientBoosting']['direction']}) | "
        f"RF: ${rf:.2f} | ARIMA: ${fc:.2f}",
        f">>> {result['decision']['recommendation']}",
    ]
    return "\n".join(lines)


# Allow running as a quick self-test against a local CSV:
#   python backend/spot_analysis.py files/crwd_daily.csv
if __name__ == "__main__":
    import sys
    csv_path = sys.argv[1] if len(sys.argv) > 1 else "../files/crwd_daily.csv"
    frame = pd.read_csv(csv_path)
    frame["date"] = pd.to_datetime(frame["timestamp"], unit="s")
    frame = frame.set_index("date")
    test_position = {
        "ticker": "CRWD",
        "option_type": "Put",
        "strike": 190.0,
        "expiry": datetime(2026, 8, 21),
        "purchase_date": "2026-08-19",
        "avg_cost": 0.69,
        "contracts": 1,
        "current_option_price": 0.57,
    }
    print(summarize_analysis(run_analysis(frame, test_position)))
