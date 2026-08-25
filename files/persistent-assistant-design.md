# Persistent Assistant Across Pages — Design

Status: **APPROVED → IMPLEMENTED** (session/history features continue in `assistant-history-design.md`)
Related: `files/spot-replay-design.md`

## 1. Problem

Today the trading assistant sidebar lives **inside the main dashboard**
(`OptionsAnalysisApp`). Switching to Trade Replay or Spot Replay unmounts it,
so the assistant only ever sees dashboard context. The user wants one
persistent conversation that follows them across every page, with the
assistant automatically fed **whatever page they're currently looking at**.

## 2. Core idea

Move the `<Chatbot>` up to `App.js` so it renders **once, outside the page
switch** — React then never unmounts it during navigation, and the
conversation (state + streaming + localStorage history) survives page changes
for free.

Per-page context is supplied through a tiny **registry**: each page registers
"here is my context supplier + screenshot target" on mount and deregisters on
unmount. When the user hits send, the Chatbot asks the registry for the
*active page's* supplier. Pages never talk to the Chatbot directly; the
Chatbot never imports page code.

## 3. Component tree

```
BEFORE                                   AFTER
─────────────────────────────            ─────────────────────────────────────────
App                                      App
│  page: 'dashboard'|'replay'|'spot'     │  page state  ──┐
│                                        │                │
├─ OptionsAnalysisApp                    ├─ AssistantRegistry (ref store)
│  │  getChatContext(), dashboardRef     │  │  {activeEntry} ← registered by pages
│  │  …owns <Chatbot> ❌                 │  │
│  ├─ <Chatbot                           ├─ page switch (all siblings now)
│  │   dashboardRef getContext/>         │  ├─ OptionsAnalysisApp ──┐
│  └─ (dies on navigation)               │  │    useAssistantContext┤ registers
├─ TradeReplayDemo                       │  ├─ TradeReplayDemo ─────┤ own ctx +
│  (no assistant)                        │  ├─ SpotReplay ──────────┘ screenshot ref
│                                        │  │
└─ (FAB buttons)                         │  ├─ <Chatbot  ✅ mounted ONCE, above pages
                                         │  │    registry activePage/>
                                         │  └─ FAB buttons (chat-open shift simplifies:
                                         │      App sees onOpenChange directly)
```

## 4. Registry flow

```
OptionsAnalysisApp   TradeReplayDemo   SpotReplay        App.js              Chatbot.js
      │                    │                │               │                    │
      │ useAssistantContext({               │               │                    │
      │   id:'dashboard', title:'Dashboard',│               │                    │
      │   getContext, targetRef })          │               │                    │
      ├─── set entry ───────────────────────┼──────────────▶│                    │
      │              (same on mount,        │               │                    │
      │               clear on unmount)     │               │                    │
      │                    │ register ▶ activeEntry = mine  │                    │
      │                    │                │               │                    │
      │                    │                │   user hits SEND                   │
      │                    │                │               │─── buildRequest ─▶│
      │                    │                │               │   registry.active │
      │                    │                │               │   .getContext()   │
      │◀───────────────── context JSON for CURRENT page ────│◀──────────────────│
```

Only the mounted page can be active — unmounting clears its entry, so there is
never ambiguity about whose context to send. Navigation mid-stream does not
abort the stream (the Chatbot isn't remounted).

## 5. What each page contributes

| Page | `getContext()` returns | Screenshot target |
|---|---|---|
| Dashboard | existing `getChatContext()` JSON (summary, plByInstrument, allTrades…) | existing `dashboardRef` |
| Trade Replay | selected trade (ticker/strike/expiry/buy/sell/P&L/gainRatio), visible-positions stats, active filters/date range | new root-div ref |
| Spot Replay | position inputs, quant verdict block (P(ITM), EV hold/sell, Kelly, recommendation, models' final prices), research source count | new report-area ref |

Every context payload carries `page` + `pageTitle`, so the model knows where
the question is being asked from, and past messages stay interpretable:

```json
{ "page": "spot-replay", "pageTitle": "Spot Replay",
  "position": {...}, "verdict": {...}, "researchSourceCount": 29 }
```

Backend needs **no changes**: `_build_query_with_context` already serializes
whatever JSON arrives. (Optional later: mention `page` in SYSTEM_PROMPT.)

## 6. Message tagging

Each stored message gains `page: entryId` at send time; the bubble header shows
e.g. `InferX · Qwen3.8 · 🎯 Spot Replay`. Scrolling back, users see exactly
which surface each answer came from.

## 7. Files changed

| File | Change |
|---|---|
| `src/components/chatbot/assistantContext.js` **(new)** | registry store + `useAssistantContext()` hook (~60 lines, commented) |
| `src/App.js` | create registry; render `<Chatbot>` once above the page switch; pass `registry`+`activePage`; absorb `onChatOpenChange` directly |
| `src/components/chatbot/Chatbot.js` | props: `registry, activePage` replace `dashboardRef, getContext`; resolve both per-send from the active entry; tag messages with page |
| `src/OptionsAnalysisApp.js` | remove `<Chatbot>` render, `isOpen`/`handleOpenChange`, `onChatOpenChange` threading; add `useAssistantContext` |
| `src/TradeReplayDemo.js` | add `useAssistantContext` + root ref |
| `src/SpotReplay.js` | add `useAssistantContext` + report-area ref |

## 8. Risks & mitigations

- **Screenshot scope** — each page passes its own root ref; if a page forgets,
  the Chatbot falls back to no-screenshot rather than crashing.
- **z-index/layout clashes** — sidebar is already `position:fixed; z-index:1000`;
  works over full-page layouts (proven by Trade Replay's floating buttons).
- **ThemeProvider nesting** — Chatbot currently sits inside the dashboard's MUI
  theme; moving it out is safe (it uses inline styles + its own CSS file).
- **Stale closures** — registry entries store functions in a `ref` map; the
  Chatbot reads `.current` at send time, so context always reflects live state.

## 9. Out of scope (later)

- Per-page conversation threads / history switcher
- Letting the assistant trigger actions (navigate pages, run analyses)

---

**Approval checklist** — reply with any adjustments, or "approved" to proceed.
