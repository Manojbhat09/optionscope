# v1.2.0 — Mac double-click launchers, Electron + fixes

*Release notes draft — GitHub Release will append auto-generated commit notes below these.*

## v1.2.0
- **Double-click anywhere**: `START_HERE.command` / `APP_START_HERE.command` for macOS Finder (same as `.bat` on Windows) — `APP_*` opens the native Electron window, `START_*` the browser at `/`.
- **Electron in the portable zip**: `desktop/` ships inside `optionscope-*-portable.zip` so `APP_START_HERE` works out of the box.
- **Launch fixes**: `python -m pip` on Windows/macOS (fixes `To modify pip…python.exe -m pip` error), app served at `/` (not `/Manojbhat09/optionscope`), PyInstaller sidecar spec + frozen-build no-reloader fix.
- Packaging for `.exe` / `.dmg` (x64+arm64) / `.AppImage+.deb` builds via `release.yml:42` once billing is unlocked.

## v1.1.0 — Multi-select Trade Replay, Spot Replay polish, Settings Center, MCP control

## ✨ Multi-select Trade Replay
- **Multi-select** toggle on the Gain Ratio card (plus Ctrl/Cmd+click any time): build a set of trades and the whole page reflects it — orange toolbar (count · W/L · P&L), `SELECTED n` badges on the Win/Loss fingerprints, subset stats everywhere.
- **Price-Action charts** with two exclusive layouts:
  - **Single-plot** — per-ticker lines (% change when several tickers), trade markers, VIX, RSI when exactly one ticker is selected.
  - **Multi-ticker** — one separate card per ticker: per-trade detail table (Gain Ratio · P&L · Buy/Sell $/contract · Buy/Sell time · Held), Line/Area/Candle chart, VIX on every card, RSI panel, drag-zoom per card.
- **Day-trade aware**: same-day selections auto-escalate to 1m/5m/15m candles so ▲BUY/▼SELL markers land on separate bars; all timestamps now show seconds.
- Win/Loss fingerprint cards are now persistent (explicit empty states instead of disappearing).
- Top Profitable/Loss tables: scrollable with a **Limit** input (default 100).

## 🎯 Spot Replay
- Pre-filled example position + remembered inputs — a first run is one click away.
- Shared Trading Notes strip; night-theme safe throughout.

## ⚙️ Settings Center (Setup ⚙)
- New **Preferences** tab: Day/Night/**Auto** theme (19:00–07:00), remember-login, auto-load on launch, default lookback, force-yfinance, filter memory, P/L decimals & compact format, assistant temperature/max-tokens, web-research default, chat retention + export/clear, MCP switch, **Allow LAN**, screenshot redaction, **env-file persistence** (write settings to `backend/.env`, seed defaults on startup), market-data keys (Alpaca/Polygon), and a danger-zone full wipe.
- The Setup modal itself is now night-theme aware.

## 🧩 Agent / MCP
- Agent bridge can be switched off from Settings (persists across restarts, 403s external tools).
- Optional LAN exposure (applies next launch) and screenshot redaction of credential fields.
- Bundled MCP server + skill: see `skills/optionscope-app/SKILL.md`.

## 🐛 Fixes
- Trade Replay: inline Robinhood login moved behind a gear button (credentials dialog, saved on write).
- Night mode: Total Trades stat, scatter dot outlines, hint texts, Buy/Sell price KPIs, Setup modal — all theme-token based now.
- Chart Line/Area/Candle modes are truly exclusive; removed the stray shaded band.
- Trading Notes card alignment on the dashboard; emoji icons replaced with SVG set.
- Desktop launcher: the Flask sidecar can no longer outlive the app (the orphan-process bug that broke Fetch Data).

## 🚀 For the web app
- Production build served by the Flask backend at `/`; portable zip contains the prebuilt app + `desktop/` Electron shell (`START_HERE.*` / `APP_START_HERE.*` for Win/mac/Linux).
