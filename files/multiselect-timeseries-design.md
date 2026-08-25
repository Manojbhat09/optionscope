# Multi-Select + Time-Series Modes — Main Dashboard

Status: PROPOSED (design only — awaiting approval before implementation)
Supersedes the earlier multiselect sketch; now grounded in the current
OptionsAnalysisApp.js and the user's 2026-08-24 request.

Note: the request said "in the trade replay", but every named surface —
the Gain Ratio scatter, the Top Profitable/Loss-Making tables, and the
cumulative time-series card — lives on the MAIN DASHBOARD
(OptionsAnalysisApp.js). This design targets the dashboard.

---

## 1. Part A — Multi-select on the Gain Ratio scatter

### UI

```
┌ Gain Ratio (Buy/Sell price) Over Time ────────────────[ ⬒ Multi-select ]┐
│  (mode OFF)  Click any dot to open Trade Replay for that ticker         │
│      ● ● ● ● ●            ← unchanged behavior                          │
└──────────────────────────────────────────────────────────────────────────┘

┌ Gain Ratio (Buy/Sell price) Over Time ────────────────[ ⬒ Multi-select ]┐
│  (mode ON)   Click dots to build a selection                            │
│      ● ◉ ● ◉ ●            ◉ = selected (accent fill + ring)             │
├──────────────────────────────────────────────────────────────────────────┤
│ ⬒ 3 selected · 2W / 1L · P/L +$812.44      [ Clear ✕ ]  [ Replay ↗ ]   │
└──────────────────────────────────────────────────────────────────────────┘
```

- Toggle button (top-right of card header). Exclusive, simple boolean.
- OFF → exactly today's behavior (click = jump to Trade Replay).
- ON → clicking a dot toggles it in/out of the selection set; no navigation.
- Selection toolbar (only when mode ON and n ≥ 1):
  - live count + W/L + summed P/L of the selection
  - `Clear` empties the set
  - `Replay ↗` opens Trade Replay scoped to the selection
    (ticker = common ticker if all equal, else "All"; date range = min/max
    close dates of the selection)

### Logic

```
multiSelectMode : bool                  (toggle)
selectedKeys    : Set<tradeKey>         (dot clicks; toggle in/out)
tradeKey        = the profitLoss map key already used at line ~214
                  (ticker|type|expiry|strike|closeDate — stable per trade)

activeTrades    = (multiSelectMode && selectedKeys.size > 0)
                    ? profitLossData.filter(t => selectedKeys.has(t.key))
                    : profitLossData    // mode off, or nothing picked yet
```

Everything downstream switches from `profitLossData` → `activeTrades`:

| Consumer                       | Today                    | After                     |
|--------------------------------|--------------------------|---------------------------|
| Stat cards (Total P/L, W/L…)   | profitLossData           | activeTrades + "SELECTED" |
| Top Profitable / Loss tables   | sorted slice             | activeTrades slice + badge|
| P/L by Instrument / Type / Pie | reduce over all          | reduce over activeTrades  |
| PnL Calendar                   | slicedData               | sliced(activeTrades)      |
| Cumulative P/L Over Time       | all trades, one line     | see Part B                |
| Scatter itself                 | all dots                 | all dots (never filtered —|
|                                |                          |  selection highlights on) |

- Zero cost: everything is client-side filtering of already-loaded rows —
  no new fetches anywhere in Part A.
- Scatter dots get a custom shape (same pattern as Trade Replay's
  ScatterDot) so selected dots render accent-filled with a ring; hover
  tooltip unchanged.
- Edge cases:
  - mode ON, 0 selected → downstream shows ALL data, toolbar hidden, and a
    dimmed hint "selecting… click dots" under the card header.
  - mode toggled OFF → selection kept in memory (so toggling back restores),
    downstream immediately returns to all trades.
  - new fetch replaces data → keys recomputed; selection self-prunes to
    surviving keys.

### Stats-row / tables badge

```
┌ Total P/L ──┐┌ Total Profit ┐┌ Total Loss ┐┌ Total Trades ┐┌ Win Rate ┐
│  +$1,234    ││              ││            ││  3 ▸ SELECTED ││  66.7%   │
└─────────────┘└──────────────┘└────────────┘└───────────────┘└──────────┘
   Top Profitable Trades (selected 3 · limit 100) ▏ Limit [100] ▐
```

When the selection is active the "Total Trades" card shows `n ▸ SELECTED`
(click it = jump to the scatter), and both top tables get a
`(selected n)` suffix. Global numbers are one `Clear` away.

---

## 2. Part B — Time-series card modes

The toggle lives on the **Cumulative Profit/Loss Over Time** card header —
a two-state segmented control, mutually exclusive by construction:

```
┌ Cumulative Profit/Loss Over Time ────────┤ Single-plot ▏Multi-ticker ├─┐
└──────────────────────────────────────────────────────────────────────────┘
```

### SINGLE-PLOT (default)

One chart, every ticker in scope gets its own colored cumulative-P/L line
(computed from that ticker's trades only), plus a bold overall line for the
combined total:

```
        P/L ▲        ╭──╮  AAPL (blue)
            │     ╭──╯  ╰──── SPY (green)
            │  ╭──╯─────── TSLA (orange)
            └──┴────────────────────▶ date
               ━━━ bold grey = overall (all in-scope trades)
```

- Legend: ticker → color (palette cycles at 8, lines thin out).
- One ticker in scope → identical to today's single line (no visual change).
- Tooltip: per-ticker cumulative value at hovered date + overall.

### MULTI-TICKER

One chart per ticker, stacked vertically (full width, ~160px each), in
order of first trade date. Each chart shows that ticker's cumulative P/L
for its own in-scope trades; trade events are dotted markers on the line:

```
┌ AAPL ── 2 trades · P/L +$310 ──────────────────────────────────────────┐
│   ╭●────╮●────╮        ● = a selected trade's close event              │
└────────────────────────────────────────────────────────────────────────┘
┌ SPY ─── 1 trade · P/L −$95 ────────────────────────────────────────────┐
│   ╭───●╮                                                              │
└────────────────────────────────────────────────────────────────────────┘
```

- Header of each mini-chart: ticker, trade count, net P/L (green/red).
- A ticker with multiple in-scope trades shows them on ONE plot (its own);
  one trade → one marker. Matches "multiple trades on one time series or
  one on each".
- Cap: first 12 tickers rendered, then a "+N more tickers" footer
  (keeps DOM/Recharts cost bounded).

### Logic

```
tsMode          : 'single' | 'multi'    (segmented control; exclusive)
scope           = activeTrades from Part A (selection-aware)

perTicker       = groupBy(scope, t => t.ticker)
single-plot     → recharts LineChart, one <Line> per ticker keyed
                  cumulative-by-date + overall <Line strokeWidth={3}>
multi-ticker    → perTicker order-by-first-date → stack of small charts
cumulative      = running sum of pl sorted by close date (existing
                  timeSeriesData logic, reused per group)
```

- Still zero fetches: cumulative P/L derives from trade rows only. (The
  separate "Stock Price and Option Transactions" card is NOT touched by
  this toggle — it keeps its manual ticker/date inputs.)
- Mode + selection compose: selecting 2 AAPL + 1 SPY then switching to
  Multi-ticker yields exactly two stacked charts.

---

## 3. State & wiring summary

```
NEW state in OptionsTradingDashboard:
  multiSelectMode : bool = false
  selectedKeys    : Set = new Set()
  tsMode          : 'single' | 'multi' = 'single'

NEW derived:
  activeTrades    = selection-aware trade list (see Part A)
  perTickerGroups = groupBy(activeTrades, ticker)

CHANGED consumers: stat cards, top tables, plByInstrument/plByType/pie,
  PnLCalendar data, cumulative chart — all read activeTrades.
UNCHANGED: All Trades table (always the full ledger), row-range slicer,
  Stock Price card, assistant context (gains a `selectedCount` field).
```

## 4. Decisions to confirm before implementing

1. Target page = main dashboard (this doc) — confirm, or adapt to the
   Trade Replay page's scatter instead?
2. Stats row + tables: REPLACE global numbers with selection numbers
   (badge + one-click clear) — recommended — or show side-by-side?
3. Single-plot with several tickers: colored per-ticker lines + bold
   overall (recommended) — or one merged line only?
4. In multi-select mode the dot click no longer jumps to Trade Replay
   (toolbar `Replay ↗` instead) — OK?
5. Multi-ticker charts plot cumulative P/L per ticker (no fetches,
   recommended) — or per-ticker stock PRICE series (pretty, but one
   history fetch per ticker and slower)?
