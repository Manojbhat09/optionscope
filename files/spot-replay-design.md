# Spot Replay — Design

> Working principles for this build:
> "Are you sure this is the best you can do?" · "I think you can do better, try again" ·
> "Take a closer look, give me 11/10 output" · "Finish it, where there is a will there is a way" ·
> "Keep going, believe in yourself"

## What it is

A dynamic, interactive version of `crwd_analysis_report.html`. Instead of regenerating static
HTML per position, the user enters a position once (structured form or the markdown-ish block
format), an agent pipeline runs (data + research + quant models + LLM/VLM analysis), and the
same report UI re-renders from JSON. Re-run with different inputs; compare verdicts.

## Architecture

```
Browser (SpotReplay.js)                Backend (spot_replay_service.py)
┌──────────────────────────┐   POST    ┌────────────────────────────────────┐
│ input panel              │──────────▶│ 1. parse position (regex + LLM     │
│ settings drawer          │  /analyze │    fallback for ambiguous text)    │
│ agent activity log       │◀──SSE─────│ 2. OHLCV: yfinance → Alpaca        │
│ dynamic report:          │  stage    │    (cached via FileCacheStore)     │
│  summary / tiles /       │  events   │ 3. research loop:                  │
│  candles+forecasts SVG / │           │    LLM picks queries →             │
│  MC histogram / tables / │           │    SearchAPI.io DuckDuckGo         │
│  catalysts / narrative   │           │    (fallback ddgs) → results back  │
└──────────────────────────┘           │ 4. quant: spot_analysis.py         │
                                       │    (8 stages: indicators, vol      │
                                       │    estimators, ATR, 8-regime MC,   │
                                       │    ARIMA, GB+RF, analogs, ensemble)│
                                       │ 5. synthesis: provider LLM writes  │
                                       │    narrative + sanity-check pass   │
                                       │    ("is this the best we can do?") │
                                       │ 6. optional VLM chart-image read   │
                                       └────────────────────────────────────┘
```

## Settings sharing contract (the intelligent bit)

Two surfaces need overlapping-but-distinct settings: the chat assistant sidebar and Spot
Replay. Rule: **credentials are global singletons; preferences are namespaced.**

| Setting | Storage key | Shared? |
|---|---|---|
| Provider API keys | `provider_key_<id>` (seeded from legacy `chat_key_*`) | YES — same keys serve both |
| Custom base URL/model | `provider_custom_base_url` / `provider_custom_model` | YES |
| Selected provider | `chat_provider` vs `spot_provider` | no |
| Model | `chat_model` vs `spot_model` | no |
| Timeout | `chat_timeout_sec` vs `spot_timeout_sec` | no |
| Surface extras (font size, dark mode, streaming…) | `chat_*` only | no |

`src/components/settings/useProviderSettings.js` implements this as one hook both surfaces can
adopt (Chatbot keeps its legacy keys until refactored onto the hook).

## Data sources

- Daily OHLCV: yfinance primary, Alpaca fallback/reconcile (user keys), cached in `backend/stock_cache/`
- News/catalysts: SearchAPI.io DuckDuckGo engine (`SEARCHAPI_API_KEY` in backend/.env, seeded
  from ~/duckduckgokey), fallback to the `ddgs` package
- Quant: numpy/pandas/scikit-learn/statsmodels (no new deps)
- LLM/VLM: whatever provider is configured in settings (reuses chatbot_service providers)

## Report parity checklist (vs crwd_analysis_report.html)

summary card + HOLD/SELL badge · stat tiles · candlestick chart w/ strike line + GB/RF/ARIMA
forecast lines · blended MC histogram · regime table · model predictions table · decision
matrix · catalysts · disclaimer footer — all live-rendered from the analyze response.
