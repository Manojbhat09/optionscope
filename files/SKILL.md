# Options Edge Analyzer

A reusable skill for performing deep quantitative analysis on any equity option position. Combines technical analysis, multi-regime Monte Carlo simulation, ARIMA time-series forecasting, ML regression models (Gradient Boosting + Random Forest), and historical pattern matching to produce a sell-vs-hold decision with expected-value calculations and Kelly criterion sizing.

## When to use

Trigger on: "analyze my option", "should I hold or sell", "what are the odds my put/call prints", "option position analysis", "Monte Carlo options", "predict stock price for expiry", "options edge", "expected value of my position".

## Required inputs

The user must provide (ask if missing):

1. **Ticker symbol** — e.g. SPCX, AAPL, TSLA
2. **Option type** — Put or Call
3. **Strike price** — e.g. $141
4. **Expiry date** — e.g. 2026-08-21
5. **Average cost** — what they paid per share, e.g. $1.05
6. **Number of contracts** — e.g. 1 (each contract = 100 shares)
7. **Current option market price** — what it's trading at now (for sell-EV)

Optional (will be inferred if missing):
- Current stock price (pull from chart or data source)
- Desired confidence level (default 95%)

## Data acquisition

Priority order for obtaining OHLCV price history:

1. **TradingView browser extraction** (if Claude-in-Chrome is available):
   ```javascript
   // Navigate to TradingView chart for the ticker, set to Daily timeframe
   // Extract via internal API:
   const series = window._exposed_chartWidgetCollection.getAll()[0].model().mainSeries();
   const bars = series.bars();
   const data = [];
   bars.each((index, bar) => {
       data.push({
           timestamp: bar[0],
           open: bar[1],
           high: bar[2],
           low: bar[3],
           close: bar[4],
           volume: bar[5]
       });
   });
   JSON.stringify(data);
   ```
   Save result to `{ticker}_daily.csv`.

2. **yfinance** (if network allows):
   ```python
   import yfinance as yf
   df = yf.download(ticker, period="6mo", interval="1d")
   df.to_csv(f"{ticker}_daily.csv")
   ```

3. **User-provided CSV** — accept any CSV with columns: date, open, high, low, close, volume.

**Minimum data requirement:** 20 daily OHLCV bars. More is better (60+ ideal for robust volatility estimation).

## Analysis pipeline

Execute each stage in order. Write all code in a single Python script. Use `numpy`, `pandas`, `scikit-learn`, `statsmodels`. Install with pip if needed.

### Stage 1: Technical indicators

Compute and report:

```python
import pandas as pd, numpy as np

df = pd.read_csv(data_file, parse_dates=['date'])
df.set_index('date', inplace=True)
df = df.sort_index()

# Log returns
df['log_ret'] = np.log(df['close'] / df['close'].shift(1))
df['ret'] = df['close'].pct_change()

# RSI (14-period)
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
df['bb_upper'] = df['bb_mid'] + 2 * df['close'].rolling(20).std()
df['bb_lower'] = df['bb_mid'] - 2 * df['close'].rolling(20).std()

# ATR (14-period and 5-period)
df['tr'] = np.maximum(
    df['high'] - df['low'],
    np.maximum(
        abs(df['high'] - df['close'].shift(1)),
        abs(df['low'] - df['close'].shift(1))
    )
)
df['atr14'] = df['tr'].rolling(14).mean()
df['atr5'] = df['tr'].rolling(5).mean()

# SMA distances
df['dist_sma5'] = df['close'] / df['close'].rolling(5).mean() - 1
df['dist_sma10'] = df['close'] / df['close'].rolling(10).mean() - 1
df['dist_sma20'] = df['close'] / df['close'].rolling(20).mean() - 1

# Support / resistance (rolling min/max)
df['support_10d'] = df['low'].rolling(10).min()
df['resist_10d'] = df['high'].rolling(10).max()
```

Report current values of RSI, MACD histogram sign, Bollinger position, ATR as % of price, and distance to strike in ATR units.

### Stage 2: Multi-estimator volatility calibration

Compute four distinct daily volatility estimators across multiple lookback windows. Each captures different price dynamics:

```python
# 1. Close-Close (standard)
# Simple standard deviation of log returns
for window in [5, 10, 20, 'full']:
    rets = df['log_ret'].tail(window) if window != 'full' else df['log_ret']
    cc_vol = rets.std()  # daily
    cc_ann = cc_vol * np.sqrt(252)  # annualized

# 2. Parkinson (High-Low range-based, 5x more efficient than CC)
df['parkinson'] = np.sqrt(np.log(df['high'] / df['low'])**2 / (4 * np.log(2)))
# Use .tail(window).mean() for windowed estimates

# 3. Garman-Klass (OHLC, most statistically efficient)
df['gk'] = np.sqrt(
    0.5 * np.log(df['high'] / df['low'])**2 -
    (2 * np.log(2) - 1) * np.log(df['close'] / df['open'])**2
)

# 4. Yang-Zhang (best for stocks with overnight gaps)
def yang_zhang_vol(df, window=10):
    n = window
    log_ho = np.log(df['high'] / df['open'])
    log_lo = np.log(df['low'] / df['open'])
    log_co = np.log(df['close'] / df['open'])
    log_oc = np.log(df['open'] / df['close'].shift(1))
    close_vol = log_oc.rolling(n).var()
    open_vol = log_co.rolling(n).var()
    window_vol = (log_ho * (log_ho - log_co) + log_lo * (log_lo - log_co)).rolling(n).mean()
    k = 0.34 / (1.34 + (n + 1) / (n - 1))
    return np.sqrt(close_vol + k * open_vol + (1 - k) * window_vol) * np.sqrt(252)
```

Report a table: estimator x window, showing daily sigma and annualized vol. Flag when estimators diverge significantly (suggests regime change or gap-heavy trading).

### Stage 3: ATR movement analysis

Quantify how far the stock can realistically move in the remaining days:

```python
atr14 = df['atr14'].iloc[-1]
current_price = df['close'].iloc[-1]
days_left = (expiry_date - today).days  # trading days

distance_to_strike = abs(current_price - strike)
distance_in_atr = distance_to_strike / atr14

# Historical N-day return distribution
n_day_returns = []
closes = df['close'].values
for i in range(len(closes) - days_left):
    ret = closes[i + days_left] / closes[i] - 1
    n_day_returns.append(ret)
n_day_returns = np.array(n_day_returns)

# Report percentiles and implied prices
for pct in [5, 10, 25, 50, 75, 90, 95]:
    implied = current_price * (1 + np.percentile(n_day_returns, pct))
    itm = "ITM" if (option_type == "Put" and implied <= strike) or \
                   (option_type == "Call" and implied >= strike) else "OTM"
    print(f"{pct}th pct: {np.percentile(n_day_returns, pct)*100:.2f}% -> ${implied:.2f} ({itm})")
```

Key insight: if distance_in_atr < 1.5, the strike is well within reach. If > 3.0, it's a lottery ticket.

### Stage 4: Monte Carlo simulation (multi-regime, 500K paths)

This is the core probability engine. Run Geometric Brownian Motion (GBM) under 8 different volatility regimes, then blend with explicit weights:

```python
N_SIM = 500_000

# Define 8 regimes with different drift (mu) and volatility (sigma) inputs
regimes = {
    'A: Close-Close 10d': {
        'mu': df['log_ret'].tail(10).mean(),
        'sigma': df['log_ret'].tail(10).std()
    },
    'B: Close-Close 5d': {
        'mu': df['log_ret'].tail(5).mean(),
        'sigma': df['log_ret'].tail(5).std()
    },
    'C: Parkinson 5d': {
        'mu': df['log_ret'].tail(5).mean(),
        'sigma': df['parkinson'].tail(5).mean()
    },
    'D: Garman-Klass 5d': {
        'mu': df['log_ret'].tail(5).mean(),
        'sigma': df['gk'].tail(5).mean()
    },
    'E: Full-history': {
        'mu': df['log_ret'].mean(),
        'sigma': df['log_ret'].std()
    },
    'F: Yang-Zhang 10d': {
        'mu': df['log_ret'].tail(10).mean(),
        'sigma': yang_zhang_vol(df, 10).iloc[-1] / np.sqrt(252)
    },
    'G: Bearish scenario (3d drift)': {
        'mu': df['log_ret'].tail(3).mean(),
        'sigma': df['log_ret'].tail(3).std()
    },
    'H: Stressed vol (1.5x recent)': {
        'mu': df['log_ret'].tail(5).mean(),
        'sigma': df['log_ret'].tail(5).std() * 1.5
    }
}

# Regime weights (recent vol measures get more weight)
regime_weights = {
    'A': 0.15, 'B': 0.15, 'C': 0.15, 'D': 0.10,
    'E': 0.05, 'F': 0.15, 'G': 0.15, 'H': 0.10
}

# Run GBM for each regime
for label, params in regimes.items():
    mu, sig = params['mu'], params['sigma']
    Z = np.random.standard_normal((N_SIM, days_left))
    log_returns = (mu - 0.5 * sig**2) + sig * Z
    cum_returns = np.cumsum(log_returns, axis=1)
    final_prices = current_price * np.exp(cum_returns[:, -1])
    # Store p_strike, median, percentiles

# Build blended distribution (mixture model)
blended = np.concatenate([
    np.random.choice(regime_finals[k], size=int(weight * 100000), replace=True)
    for k, weight in regime_weights.items()
])
```

Report per-regime: P(ITM), median final price, 5th/95th percentile range. Then report blended ensemble probability.

### Stage 5: ARIMA time-series forecast

Automatic order selection via AIC grid search:

```python
from statsmodels.tsa.arima.model import ARIMA
import warnings; warnings.filterwarnings('ignore')

best_aic, best_order, best_model = np.inf, None, None
for p in range(5):
    for d in range(2):
        for q in range(5):
            try:
                model = ARIMA(df['close'].values, order=(p, d, q))
                fitted = model.fit()
                if fitted.aic < best_aic:
                    best_aic = fitted.aic
                    best_order = (p, d, q)
                    best_model = fitted
            except:
                continue

forecast = best_model.forecast(steps=days_left)
ci_90 = best_model.get_forecast(steps=days_left).conf_int(alpha=0.1)
ci_95 = best_model.get_forecast(steps=days_left).conf_int(alpha=0.05)
```

Report: best order, AIC, point forecast for each day, and whether strike falls within the 90%/95% confidence interval. ARIMA often forecasts flat (random walk) for short-horizon stocks — that's expected and informative: it means the directional signal is weak.

### Stage 6: ML regression models (Gradient Boosting + Random Forest)

Train on lagged features, forecast iteratively:

```python
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.preprocessing import StandardScaler

# Feature engineering
for lag in range(1, 8):
    df[f'ret_lag{lag}'] = df['ret'].shift(lag)
    df[f'logret_lag{lag}'] = df['log_ret'].shift(lag)

df['vol_3d'] = df['log_ret'].rolling(3).std()
df['vol_5d'] = df['log_ret'].rolling(5).std()
df['vol_10d'] = df['log_ret'].rolling(10).std()
df['range_pct'] = (df['high'] - df['low']) / df['close']
df['range_lag1'] = df['range_pct'].shift(1)
df['gap'] = df['open'] / df['close'].shift(1) - 1
df['target'] = df['ret'].shift(-1)  # next-day return

feature_cols = [f'ret_lag{i}' for i in range(1,6)] + \
               [f'logret_lag{i}' for i in range(1,4)] + \
               ['vol_3d', 'vol_5d', 'range_pct', 'range_lag1',
                'gap', 'rsi', 'dist_sma5', 'dist_sma10']

# Train
X = df.dropna()[feature_cols].values
y = df.dropna()['target'].values
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X)

gb = GradientBoostingRegressor(n_estimators=300, max_depth=3,
                                learning_rate=0.03, subsample=0.8)
rf = RandomForestRegressor(n_estimators=300, max_depth=4)
gb.fit(X_scaled, y)
rf.fit(X_scaled, y)

# Iterative multi-day forecast
# For each day: predict return, compute new price, shift features forward
```

Report: day-by-day price forecasts from each model, top-5 feature importances. GB tends to pick up momentum/mean-reversion patterns; RF captures non-linear interactions. When GB and RF disagree on direction, flag that uncertainty is high.

### Stage 7: Historical pattern matching (analog search)

Find past periods with similar technical setups:

```python
# Current state vector
current_rsi = df['rsi'].iloc[-1]
current_dist_sma5 = df['dist_sma5'].iloc[-1]

# Forward N-day returns from each historical point
df['fwd_ret'] = df['close'].shift(-days_left) / df['close'] - 1

# Find analogs: RSI within +/-10, SMA distance within +/-3%
similar = df[
    (df['rsi'].between(current_rsi - 10, current_rsi + 10)) &
    (df['dist_sma5'].between(current_dist_sma5 - 0.03, current_dist_sma5 + 0.03))
].dropna(subset=['fwd_ret'])

# If too few matches (<3), widen to RSI +/-15, dist +/-5%
# Report: count of analogs, forward return distribution, implied P(ITM)
```

With limited history (e.g. recent IPO < 6 months), analogs will be sparse. Report the count and note the confidence level.

### Stage 8: Final ensemble and option valuation

Combine all signals into a single probability and decision matrix:

```python
# Expected payoff from blended MC distribution
if option_type == "Put":
    payoffs = np.maximum(strike - blended_prices, 0)
elif option_type == "Call":
    payoffs = np.maximum(blended_prices - strike, 0)

expected_payoff = payoffs.mean()  # per share
prob_itm = np.mean(payoffs > 0) * 100
avg_payoff_itm = payoffs[payoffs > 0].mean() if np.any(payoffs > 0) else 0
breakeven = strike - option_cost if option_type == "Put" else strike + option_cost
prob_profit = np.mean(blended_prices <= breakeven if option_type == "Put"
                      else blended_prices >= breakeven) * 100

# Kelly criterion
b = avg_payoff_itm / option_cost  # odds ratio
p = prob_itm / 100
kelly = (b * p - (1 - p)) / b
# Kelly > 0 means positive edge; Kelly < 0 means negative edge

# Decision matrix
ev_hold = expected_payoff * 100 * num_contracts  # total contract value
ev_sell = current_option_price * 100 * num_contracts
ev_advantage = "HOLD" if ev_hold > ev_sell else "SELL"
```

## Output format

Present results in this structure:

### Summary card (always show first)
```
TICKER $STRIKE PUT/CALL — EXPIRY DATE
Current: $XXX.XX | Strike: $XXX | Cost: $X.XX | Breakeven: $XXX.XX
Days to expiry: N | Distance: X.XX ATR | RSI: XX.X
```

### Model predictions table
```
Model                   | Day-N Price | Direction | Calls ITM?
Gradient Boosting       | $XXX.XX     | BEARISH   | YES/NO
Random Forest           | $XXX.XX     | BULLISH   | YES/NO
ARIMA                   | $XXX.XX     | FLAT      | YES/NO
MC Ensemble (8-regime)  | XX.X% prob  | —         | —
Historical Analog       | XX.X% prob  | —         | —
```

### Monte Carlo regime table
```
Regime                  | Daily sigma | P(ITM)  | Median final
Close-Close 10d         | X.XXX%      | XX.X%   | $XXX.XX
Parkinson 5d            | X.XXX%      | XX.X%   | $XXX.XX
... (all 8 regimes)
BLENDED ENSEMBLE        | weighted    | XX.X%   | $XXX.XX
```

### Decision matrix
```
Action          | Probability | Value         | EV
Sell now        | 100%        | $XX.XX        | $XX.XX
Hold -> OTM     | XX.X%       | $0.00         | $0.00
Hold -> ITM     | XX.X%       | $XX.XX (avg)  | $XX.XX
                |             | HOLD TOTAL EV | $XX.XX
EV advantage: HOLD/SELL by $XX.XX
Kelly fraction: XX.X%
```

### Recommendation
State clearly: SELL or HOLD, with the quantitative reasoning. Include caveats:
- If Kelly < 0, note negative edge even if EV favors hold
- If ensemble probability < 15%, note it's a low-probability lottery
- If ensemble probability > 40%, note strong conviction
- If models disagree on direction, note high uncertainty
- Always remind: this is quantitative analysis, not financial advice

## Generating the visual report

After the analysis, build an HTML report with inline SVG charts. Include:

1. **Candlestick / line chart** of price history with strike line and SMA overlays
2. **Monte Carlo histogram** of blended final price distribution with strike marked
3. **Regime comparison table** with color-coded ITM probabilities
4. **ML forecast lines** (GB, RF, ARIMA) projected from current price
5. **Decision matrix** formatted as a styled table

Use the `dataviz` skill's palette if available. Send the HTML to the user via `SendUserFile`.

## Post-mortem mode

If the user asks "what happened" or "which model was right" after expiry or a large move:

1. Compare each model's prediction vs actual outcome
2. Compute absolute error and direction accuracy for each model
3. Identify which volatility regime was closest to realized vol
4. Search for news catalysts (lockup expirations, earnings, short interest changes, macro events)
5. Report a scorecard:
   ```
   Model               | Predicted  | Actual  | Error  | Direction | Called ITM?
   Gradient Boosting   | $XXX.XX    | $XXX.XX | $X.XX  | CORRECT   | YES
   ...
   ```

## Lessons from the SPCX case study (Aug 2026)

Key findings that should inform future analyses:

1. **Gradient Boosting was the most accurate model** — it correctly predicted the bearish direction AND called ITM ($140.25 predicted vs $139.89 actual, 0.3% error). GB excels at capturing short-term momentum/mean-reversion.

2. **Random Forest had bullish bias** — it predicted $145.51 (4.0% error, wrong direction). RF tends to average out signals, which biases toward continuation of recent trends.

3. **ARIMA predicted flat** ($144.17, random walk) — this is expected for short-horizon stock price prediction. ARIMA's value is its confidence intervals, not point forecasts.

4. **Monte Carlo ensemble probability (29%) was well-calibrated** — the ITM event materialized. A 29% probability is not "unlikely"; it's roughly 1-in-3. The EV calculation correctly identified HOLD as the better action ($118 vs $43).

5. **Catalysts that drove the move** (found via news research):
   - 319M share lockup expiration (massive supply increase)
   - 29% short interest (heavy bearish positioning)
   - Extreme valuation (P/S 125x on a pre-revenue company)
   - These are the kind of binary catalysts that vol models alone can't capture — always supplement quantitative analysis with fundamental/event research.

6. **The stressed-vol and bearish-drift regimes were the accurate ones** — this validates including tail-risk scenarios in the regime mix, even when they seem extreme.

7. **Distance-in-ATR was the most intuitive quick check** — when the strike was < 1 ATR away, the put had a realistic chance. When it was > 3 ATR, it was a lottery ticket.

## Dependencies

```
pip install numpy pandas scikit-learn statsmodels
```

All other tools (matplotlib, plotly) are optional — the HTML report uses inline SVG for zero-dependency visualization.