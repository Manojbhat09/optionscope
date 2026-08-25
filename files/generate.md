# Options Edge Analyzer — Agent Execution Guide

You are an agent tasked with producing a quantitative options analysis report. Follow every step in order. Do not skip stages. The output is a self-contained HTML report delivered to the user.

## 1. Parse inputs

Extract these from the user's message (ask for any that are missing):

```
TICKER          = ""       # e.g. "CRWD"
OPTION_TYPE     = ""       # "Put" or "Call"
STRIKE          = 0.0      # e.g. 190.0
EXPIRY          = ""       # e.g. "2026-08-21"
AVG_COST        = 0.0      # per-share cost, e.g. 0.69
CONTRACTS       = 1        # number of contracts
CURRENT_OPT_PRICE = 0.0   # current market price per share, e.g. 0.57
```

Compute derived values:
- `FORECAST_DAYS` = trading days between today and expiry (skip weekends/holidays)
- `BREAKEVEN` = `STRIKE - AVG_COST` for puts, `STRIKE + AVG_COST` for calls

## 2. Acquire OHLCV data

You need **daily OHLCV bars** — at least 60, ideally 120+.

### Option A: TradingView (if browser tools available)

1. Navigate to `https://www.tradingview.com/chart/` and enter the ticker
2. Switch to **Daily (1D)** timeframe via the timeframe dropdown
3. Extract bars via JavaScript:

```javascript
const series = window._exposed_chartWidgetCollection.getAll()[0].model().mainSeries();
const bars = series.bars();
const data = [];
bars.each((index, bar) => {
    data.push([bar[0], bar[1], bar[2], bar[3], bar[4], bar[5]]);
    // [timestamp, open, high, low, close, volume]
});
window.__data = data;
data.length + " bars loaded"
```

4. Extract in batches of 15 (the JS tool truncates at ~2000 chars):

```javascript
const d = window.__data, r = v => Math.round(v*100)/100;
d.slice(-120, -105).map(x => [x[0],r(x[1]),r(x[2]),r(x[3]),r(x[4]),x[5]].join(",")).join("\n")
```

Repeat with `slice(-105,-90)`, `slice(-90,-75)`, ... until you have all bars.

5. Save to CSV with header: `timestamp,open,high,low,close,volume`

### Option B: yfinance (if network allows)

```python
import yfinance as yf
df = yf.download(TICKER, period="6mo", interval="1d")
df.to_csv(f"{TICKER.lower()}_daily.csv")
```

### Option C: User-provided CSV

Accept any CSV with columns: date/timestamp, open, high, low, close, volume.

## 3. Research catalysts

Run web searches for context. Search for:
- `"{TICKER} stock news today {current_year}"`
- `"{TICKER} earnings date {current_year}"`
- `"{TICKER} short interest insider selling"`
- `"{TICKER} analyst price target"`

Extract and note: upcoming earnings, insider activity, short interest %, recent analyst actions, sector news, any binary events (lockups, FDA decisions, etc.). These go into the Catalysts table in the report.

## 4. Run the analysis script

Write and execute a Python script with this exact structure. Install dependencies first:

```bash
pip install numpy pandas scikit-learn statsmodels --break-system-packages -q
```

The script has 8 stages. Here is the complete template — substitute the `INPUT PARAMETERS` block at the top:

```python
import pandas as pd
import numpy as np
from datetime import datetime
from statsmodels.tsa.arima.model import ARIMA
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.preprocessing import StandardScaler
import json, warnings
warnings.filterwarnings('ignore')
np.random.seed(42)

# ============================================================
# INPUT PARAMETERS — FILL THESE IN
# ============================================================
TICKER = "CRWD"
OPTION_TYPE = "Put"          # "Put" or "Call"
STRIKE = 190.0
EXPIRY = datetime(2026, 8, 21)
AVG_COST = 0.69
CONTRACTS = 1
CURRENT_OPTION_PRICE = 0.57
TODAY = datetime.now()
FORECAST_DAYS = 2            # trading days to expiry
DATA_FILE = "crwd_daily.csv" # path to the OHLCV CSV

if OPTION_TYPE == "Put":
    BREAKEVEN = STRIKE - AVG_COST
else:
    BREAKEVEN = STRIKE + AVG_COST

# ============================================================
# LOAD DATA
# ============================================================
df = pd.read_csv(DATA_FILE)
# Handle both 'date' and 'timestamp' columns
if 'timestamp' in df.columns:
    df['date'] = pd.to_datetime(df['timestamp'], unit='s')
elif 'date' in df.columns:
    df['date'] = pd.to_datetime(df['date'])
df.set_index('date', inplace=True)
df = df.sort_index()

current_price = df['close'].iloc[-1]

# ============================================================
# STAGE 1: TECHNICAL INDICATORS
# ============================================================
df['log_ret'] = np.log(df['close'] / df['close'].shift(1))
df['ret'] = df['close'].pct_change()

# RSI (14)
delta = df['close'].diff()
gain = delta.where(delta > 0, 0).rolling(14).mean()
loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
df['rsi'] = 100 - (100 / (1 + gain / loss))

# MACD (12, 26, 9)
ema12 = df['close'].ewm(span=12).mean()
ema26 = df['close'].ewm(span=26).mean()
df['macd'] = ema12 - ema26
df['macd_signal'] = df['macd'].ewm(span=9).mean()
df['macd_hist'] = df['macd'] - df['macd_signal']

# Bollinger Bands (20, 2)
df['bb_mid'] = df['close'].rolling(20).mean()
df['bb_std'] = df['close'].rolling(20).std()
df['bb_upper'] = df['bb_mid'] + 2 * df['bb_std']
df['bb_lower'] = df['bb_mid'] - 2 * df['bb_std']

# ATR (14 and 5)
df['tr'] = np.maximum(
    df['high'] - df['low'],
    np.maximum(abs(df['high'] - df['close'].shift(1)),
               abs(df['low'] - df['close'].shift(1)))
)
df['atr14'] = df['tr'].rolling(14).mean()
df['atr5'] = df['tr'].rolling(5).mean()

# SMA distances
df['dist_sma5'] = df['close'] / df['close'].rolling(5).mean() - 1
df['dist_sma10'] = df['close'] / df['close'].rolling(10).mean() - 1
df['dist_sma20'] = df['close'] / df['close'].rolling(20).mean() - 1

# ============================================================
# STAGE 2: VOLATILITY CALIBRATION — 4 ESTIMATORS
# ============================================================
df_clean = df.dropna(subset=['log_ret'])

# Parkinson (high-low range)
df['parkinson'] = np.sqrt(np.log(df['high'] / df['low'])**2 / (4 * np.log(2)))

# Garman-Klass (OHLC)
df['gk'] = np.sqrt(
    0.5 * np.log(df['high'] / df['low'])**2 -
    (2 * np.log(2) - 1) * np.log(df['close'] / df['open'])**2
)

# Yang-Zhang (overnight-gap aware)
def yang_zhang_vol(df_in, window=10):
    n = window
    log_ho = np.log(df_in['high'] / df_in['open'])
    log_lo = np.log(df_in['low'] / df_in['open'])
    log_co = np.log(df_in['close'] / df_in['open'])
    log_oc = np.log(df_in['open'] / df_in['close'].shift(1))
    close_vol = log_oc.rolling(n).var()
    open_vol = log_co.rolling(n).var()
    window_vol = (log_ho * (log_ho - log_co) + log_lo * (log_lo - log_co)).rolling(n).mean()
    k = 0.34 / (1.34 + (n + 1) / (n - 1))
    return np.sqrt(close_vol + k * open_vol + (1 - k) * window_vol) * np.sqrt(252)

df['yz_vol'] = yang_zhang_vol(df, 10)

# ============================================================
# STAGE 3: ATR MOVEMENT ANALYSIS
# ============================================================
atr14 = df['atr14'].iloc[-1]

# Historical N-day return distribution
dd_nd = []
closes = df['close'].values
for i in range(len(closes) - FORECAST_DAYS):
    dd_nd.append(closes[i + FORECAST_DAYS] / closes[i] - 1)
dd_nd = np.array(dd_nd)

# ============================================================
# STAGE 4: MONTE CARLO — 8 REGIMES, 500K PATHS
# ============================================================
N_SIM = 500_000
yz_current = df['yz_vol'].iloc[-1]

regimes = {
    'A: CC 10d': {
        'mu': df_clean['log_ret'].tail(10).mean(),
        'sigma': df_clean['log_ret'].tail(10).std()
    },
    'B: CC 5d': {
        'mu': df_clean['log_ret'].tail(5).mean(),
        'sigma': df_clean['log_ret'].tail(5).std()
    },
    'C: Parkinson 5d': {
        'mu': df_clean['log_ret'].tail(5).mean(),
        'sigma': df['parkinson'].tail(5).mean()
    },
    'D: Garman-Klass 5d': {
        'mu': df_clean['log_ret'].tail(5).mean(),
        'sigma': df['gk'].tail(5).mean()
    },
    'E: Full-history': {
        'mu': df_clean['log_ret'].mean(),
        'sigma': df_clean['log_ret'].std()
    },
    'F: Yang-Zhang 10d': {
        'mu': df_clean['log_ret'].tail(10).mean(),
        'sigma': yz_current / np.sqrt(252) if not np.isnan(yz_current) else df_clean['log_ret'].std()
    },
    'G: Bearish (3d drift)': {
        'mu': df_clean['log_ret'].tail(3).mean(),
        'sigma': df_clean['log_ret'].tail(3).std()
    },
    'H: Stressed (1.5x)': {
        'mu': df_clean['log_ret'].tail(5).mean(),
        'sigma': df_clean['log_ret'].tail(5).std() * 1.5
    }
}

regime_weights = {
    'A: CC 10d': 0.15, 'B: CC 5d': 0.15,
    'C: Parkinson 5d': 0.15, 'D: Garman-Klass 5d': 0.10,
    'E: Full-history': 0.05, 'F: Yang-Zhang 10d': 0.15,
    'G: Bearish (3d drift)': 0.15, 'H: Stressed (1.5x)': 0.10
}

mc_results = {}
for label, params in regimes.items():
    mu, sig = params['mu'], params['sigma']
    Z = np.random.standard_normal((N_SIM, FORECAST_DAYS))
    log_returns = (mu - 0.5 * sig**2) + sig * Z
    cum_returns = np.cumsum(log_returns, axis=1)
    final_prices = current_price * np.exp(cum_returns[:, -1])
    mc_results[label] = {
        'mu': mu, 'sigma': sig,
        'p_strike': float(np.mean(final_prices <= STRIKE) * 100) if OPTION_TYPE == "Put"
                    else float(np.mean(final_prices >= STRIKE) * 100),
        'median': float(np.median(final_prices)),
        'final_prices': final_prices,
        'pct5': float(np.percentile(final_prices, 5)),
        'pct95': float(np.percentile(final_prices, 95)),
    }

# Blended distribution
blended = np.concatenate([
    np.random.choice(mc_results[k]['final_prices'], size=int(regime_weights[k]*100000), replace=True)
    for k in regime_weights
])

# ============================================================
# STAGE 5: ARIMA FORECAST
# ============================================================
best_aic, best_order, best_model = np.inf, None, None
for p in range(5):
    for d_ord in range(2):
        for q in range(5):
            try:
                model = ARIMA(df['close'].values, order=(p, d_ord, q))
                fitted = model.fit()
                if fitted.aic < best_aic:
                    best_aic = fitted.aic
                    best_order = (p, d_ord, q)
                    best_model = fitted
            except:
                continue

forecast = best_model.forecast(steps=FORECAST_DAYS)
fc_obj = best_model.get_forecast(steps=FORECAST_DAYS)
ci_90 = fc_obj.conf_int(alpha=0.1)
ci_95 = fc_obj.conf_int(alpha=0.05)

# ============================================================
# STAGE 6: ML MODELS (GB + RF)
# ============================================================
df_ml = df.copy()
for lag in range(1, 8):
    df_ml[f'ret_lag{lag}'] = df_ml['ret'].shift(lag)
    df_ml[f'logret_lag{lag}'] = df_ml['log_ret'].shift(lag)
df_ml['vol_3d'] = df_ml['log_ret'].rolling(3).std()
df_ml['vol_5d'] = df_ml['log_ret'].rolling(5).std()
df_ml['vol_10d'] = df_ml['log_ret'].rolling(10).std()
df_ml['range_pct'] = (df_ml['high'] - df_ml['low']) / df_ml['close']
df_ml['range_lag1'] = df_ml['range_pct'].shift(1)
df_ml['gap'] = df_ml['open'] / df_ml['close'].shift(1) - 1
df_ml['target'] = df_ml['ret'].shift(-1)

feature_cols = [f'ret_lag{i}' for i in range(1,6)] + \
               [f'logret_lag{i}' for i in range(1,4)] + \
               ['vol_3d', 'vol_5d', 'range_pct', 'range_lag1',
                'gap', 'rsi', 'dist_sma5', 'dist_sma10']

df_ml = df_ml.dropna()
X = df_ml[feature_cols].values
y = df_ml['target'].values
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X)

ml_preds = {}
for name, mdl in [
    ('GradientBoosting', GradientBoostingRegressor(
        n_estimators=300, max_depth=3, learning_rate=0.03, subsample=0.8, random_state=42)),
    ('RandomForest', RandomForestRegressor(
        n_estimators=300, max_depth=4, random_state=42))
]:
    mdl.fit(X_scaled, y)
    prices = [current_price]
    curr_feat = df_ml[feature_cols].iloc[-1:].values.copy()
    for day in range(FORECAST_DAYS):
        pred_ret = mdl.predict(scaler.transform(curr_feat))[0]
        prices.append(prices[-1] * (1 + pred_ret))
        new_feat = curr_feat.copy()
        for j in range(4, 0, -1):
            new_feat[0][j] = new_feat[0][j-1]
        new_feat[0][0] = pred_ret
        curr_feat = new_feat
    ml_preds[name] = prices

# ============================================================
# STAGE 7: HISTORICAL ANALOG
# ============================================================
current_rsi = df['rsi'].iloc[-1]
current_dist = df['dist_sma5'].iloc[-1]
df['fwd_ret'] = df['close'].shift(-FORECAST_DAYS) / df['close'] - 1
analogs = df.dropna(subset=['fwd_ret', 'rsi', 'dist_sma5'])
similar = analogs[
    (analogs['rsi'].between(current_rsi - 10, current_rsi + 10)) &
    (analogs['dist_sma5'].between(current_dist - 0.03, current_dist + 0.03))
]
if len(similar) < 3:
    similar = analogs[analogs['rsi'].between(current_rsi - 15, current_rsi + 15)]

# ============================================================
# STAGE 8: ENSEMBLE & DECISION MATRIX
# ============================================================
if OPTION_TYPE == "Put":
    payoffs = np.maximum(STRIKE - blended, 0)
else:
    payoffs = np.maximum(blended - STRIKE, 0)

expected_payoff = payoffs.mean()
prob_itm = np.mean(payoffs > 0) * 100
avg_payoff_itm = payoffs[payoffs > 0].mean() if np.any(payoffs > 0) else 0

if OPTION_TYPE == "Put":
    prob_profit = np.mean(blended <= BREAKEVEN) * 100
else:
    prob_profit = np.mean(blended >= BREAKEVEN) * 100

# Kelly criterion
if prob_itm > 0 and avg_payoff_itm > 0:
    b = avg_payoff_itm / CURRENT_OPTION_PRICE
    p = prob_itm / 100
    kelly = (b * p - (1 - p)) / b
else:
    kelly = -1.0

ev_hold = expected_payoff * 100 * CONTRACTS
ev_sell = CURRENT_OPTION_PRICE * 100 * CONTRACTS
recommendation = "HOLD" if ev_hold > ev_sell else "SELL"

# ============================================================
# SAVE RESULTS TO JSON
# ============================================================
output = {
    'ticker': TICKER,
    'option_type': OPTION_TYPE,
    'current_price': float(current_price),
    'strike': float(STRIKE),
    'breakeven': float(BREAKEVEN),
    'avg_cost': float(AVG_COST),
    'current_option_price': float(CURRENT_OPTION_PRICE),
    'forecast_days': FORECAST_DAYS,
    'rsi': float(df['rsi'].iloc[-1]),
    'macd_hist': float(df['macd_hist'].iloc[-1]),
    'atr14': float(atr14),
    'bb_position': float((current_price - df['bb_lower'].iloc[-1]) /
                         (df['bb_upper'].iloc[-1] - df['bb_lower'].iloc[-1])),
    'ensemble_prob': float(prob_itm),
    'prob_profit': float(prob_profit),
    'expected_payoff': float(expected_payoff),
    'avg_payoff_itm': float(avg_payoff_itm),
    'ev_hold': float(ev_hold),
    'ev_sell': float(ev_sell),
    'kelly': float(kelly),
    'arima_order': list(best_order),
    'arima_forecast': forecast.tolist(),
    'arima_ci90_lower': ci_90[:, 0].tolist(),
    'arima_ci90_upper': ci_90[:, 1].tolist(),
    'arima_ci95_lower': ci_95[:, 0].tolist(),
    'arima_ci95_upper': ci_95[:, 1].tolist(),
    'gb_prices': ml_preds.get('GradientBoosting', []),
    'rf_prices': ml_preds.get('RandomForest', []),
    'blended_sample': blended[:8000].tolist(),
    'daily_dates': [d.strftime('%Y-%m-%d') for d in df.index],
    'daily_closes': df['close'].values.tolist(),
    'daily_highs': df['high'].values.tolist(),
    'daily_lows': df['low'].values.tolist(),
    'daily_opens': df['open'].values.tolist(),
    'vol_regimes': {k: {
        'mu': float(v['mu']), 'sigma': float(v['sigma']),
        'p_strike': float(v['p_strike']), 'median': float(v['median']),
        'pct5': float(v['pct5']), 'pct95': float(v['pct95'])
    } for k, v in mc_results.items()},
    'recommendation': recommendation,
    'last_3_returns': df['ret'].tail(3).tolist(),
    'consecutive_down': all(r < 0 for r in df['ret'].tail(3).values),
}

output_file = f'{TICKER.lower()}_chart_data.json'
with open(output_file, 'w') as f:
    json.dump(output, f)
print(f"Results saved to {output_file}")

# Print summary
print(f"\n{'='*60}")
print(f"{TICKER} ${STRIKE} {OPTION_TYPE} — SUMMARY")
print(f"{'='*60}")
print(f"Current: ${current_price:.2f} | Strike: ${STRIKE}")
print(f"Distance: ${abs(current_price-STRIKE):.2f} ({abs(current_price-STRIKE)/atr14:.1f} ATR)")
print(f"ITM Prob: {prob_itm:.1f}% | Profit Prob: {prob_profit:.1f}%")
print(f"EV Hold: ${ev_hold:.2f} | EV Sell: ${ev_sell:.2f}")
print(f"Kelly: {kelly*100:.1f}%")
print(f"GB Day-{FORECAST_DAYS}: ${ml_preds['GradientBoosting'][-1]:.2f}")
print(f"RF Day-{FORECAST_DAYS}: ${ml_preds['RandomForest'][-1]:.2f}")
print(f"ARIMA Day-{FORECAST_DAYS}: ${forecast[-1]:.2f}")
print(f">>> {recommendation}")
```

## 5. Build the HTML report

After the analysis JSON is saved, build a self-contained HTML report. The report uses these design rules (from the dataviz skill's validated palette):

### Color system

```css
/* Light mode */
--surface-1: #fcfcfb;
--page-plane: #f9f9f7;
--text-primary: #0b0b0b;
--text-secondary: #52514e;
--text-muted: #898781;
--gridline: #e1e0d9;
--baseline: #c3c2b7;
--border: rgba(11,11,11,0.10);
--series-1: #2a78d6;  /* blue — ARIMA, primary */
--series-2: #eb6834;  /* orange — Gradient Boosting */
--series-3: #1baf7a;  /* green — bullish candles */
--series-7: #4a3aa7;  /* violet — Random Forest */
--series-8: #e34948;  /* red — bearish candles, ITM zone */
--good: #006300;       /* hold/positive */
--critical: #d03b3b;   /* sell/negative */

/* Dark mode — same structure, dark-stepped hex values */
```

### Required report sections

1. **Summary card** — ticker, strike, current price, distance, days to expiry, HOLD/SELL badge
2. **Stat tiles row** — ITM probability, EV Hold, Kelly criterion, ATR distance, RSI
3. **Price chart (SVG)** — last 60 days of candlesticks, strike line (dashed red), ML forecast lines (GB orange dashed, RF violet dashed, ARIMA blue dashed)
4. **MC histogram (SVG)** — blended final price distribution, bars colored red below strike / blue above, vertical strike line
5. **Regime table** — all 8 MC regimes with daily sigma, mu, P(ITM), median, 5th/95th percentiles
6. **Model predictions table** — GB, RF, ARIMA day-by-day forecasts with ITM badge
7. **Decision matrix** — Sell now vs Hold→OTM vs Hold→ITM with probabilities, values, EVs
8. **Catalysts table** — findings from web research (earnings, insider activity, short interest, etc.)
9. **Footer** — "Quantitative analysis, not financial advice" disclaimer

### Chart construction rules

- Candlesticks: green body if close >= open, red body if close < open. Thin wicks, rounded body ends.
- Strike line: dashed, red (`--critical`), labeled at right edge
- ML forecasts: dashed lines extending from the last data point, each in its series color
- Histogram: 50 bins, bars below strike colored red (ITM zone), bars above colored blue
- All text in `system-ui, -apple-system, "Segoe UI", sans-serif`
- Tabular numbers for all data values: `font-variant-numeric: tabular-nums`
- Support both light and dark mode via `prefers-color-scheme` media query

### Building the HTML

Write a Python script that reads the JSON output and generates the HTML. Use string concatenation (not f-strings with `{{}}`) when embedding JavaScript. Inline all CSS. The file must be fully self-contained — no external dependencies.

Save to `{ticker}_analysis_report.html` and deliver via `SendUserFile`.

## 6. Present findings

After delivering the report, write a concise summary for the user covering:

1. Current price and distance to strike (in dollars and ATR units)
2. MC ensemble ITM probability
3. The EV comparison (hold vs sell) and Kelly fraction
4. Which ML model is most bearish/bullish and its prediction
5. Key catalysts from research
6. Final recommendation with one-sentence reasoning

Always end with: "This is quantitative analysis, not financial advice."

## 7. Post-mortem mode

If the user returns after expiry and asks "what happened" or "which model was right":

1. Get the actual closing price on expiry
2. Compare each model's prediction vs actual: absolute error, direction correctness, whether it called ITM
3. Identify which volatility regime was closest to realized vol
4. Score each model in a table
5. Search for news catalysts that drove the move
6. Report which model won and why

## Dependencies

```bash
pip install numpy pandas scikit-learn statsmodels --break-system-packages -q
```

No other libraries are required. The HTML report uses inline SVG — no charting library needed.

## Example invocation

User provides:
```
Ticker: AAPL
Option: Call
Strike: $250
Expiry: 2026-09-18
Average cost: $2.30
Contracts: 2
Current option price: $1.85
```

Agent executes:
1. Extracts AAPL daily OHLCV (TradingView or yfinance)
2. Searches web for AAPL news, earnings, analyst sentiment
3. Runs the analysis script with `TICKER="AAPL"`, `OPTION_TYPE="Call"`, `STRIKE=250`, etc.
4. Builds the HTML report from the JSON output
5. Delivers report + summary to user

## Notes for agents

- The Monte Carlo uses GBM (Geometric Brownian Motion) — `S_t = S_0 * exp((mu - 0.5*sigma^2)*t + sigma*W_t)`. This is vectorized with numpy for speed.
- The 8 regimes exist because no single volatility estimate is "right" — each captures different dynamics. The weighted blend gives a robust probability.
- Gradient Boosting tends to capture momentum/mean-reversion patterns best. Random Forest tends toward the mean. ARIMA often predicts flat (random walk) for stocks — that's expected and informative.
- Kelly > 0 means positive expected edge. Kelly < 0 means the bet has negative expectation.
- When models disagree on direction, flag high uncertainty to the user.
- The historical analog search may find few matches on short-history stocks — note the confidence level.
- Always compute for both Put and Call correctly: Put payoff = max(strike - price, 0), Call payoff = max(price - strike, 0).
