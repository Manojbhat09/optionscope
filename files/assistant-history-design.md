# Assistant Sidebar v2 — Persistence, Sessions & JSONL History

Status: **IMPLEMENTED** (supersedes §"out of scope" items in `persistent-assistant-design.md`)

## 1. Requirements

1. Sidebar persists across ALL pages (dashboard, Trade Replay, Spot Replay) — one continuous conversation.
2. The assistant automatically receives the **current page's** context (data + screenshot target).
3. **New Chat** button — start a blank conversation without losing old ones.
4. **Chat history** — nothing forgotten: every message appended to a server-side **JSONL** database.
5. **History button** (top-right of sidebar) — browse past chats, select one to continue it.
6. Fix header UX: the floating open/close button overlapped "Clear".

## 2. Mount architecture (persistence)

```
App.js
│
│   const registry = createAssistantRegistry()        ┌──────────────────────────┐
│   const [chatOpen, setChatOpen] = useState(false)   │  <Chatbot                │
│                                                     │    open={chatOpen}       │
├─── page switch (siblings — mounting/unmounting      │    onOpenChange=…        │
│    these no longer touches the assistant)           │    registry={registry}/> │
│    ├─ OptionsAnalysisApp ── useAssistantContext ─┐  └──────────────────────────┘
│    ├─ TradeReplayDemo ───── useAssistantContext ─┼─▶ registry Map<id, entry>
│    └─ SpotReplay ─────────── useAssistantContext ┘         ▲
│                                                            │ .active read at SEND time
└─── FABs shift by chatOpen (now always accurate — sidebar never unmounts)
```

Key invariant: `<Chatbot>` renders **once, above the page switch**. React never
unmounts it during navigation → conversation state, in-flight streams, and
scroll position survive page changes for free. Each page registers
`{id, title, getContext(), screenshotTarget}` into the registry on mount and
is removed on unmount, so the *active* entry is always the visible page.

## 3. View + session state machine

Two orthogonal slices of state:

- `open`: boolean — sidebar visibility (owned by App for FAB shifting)
- `view`: `'chat' | 'history'` — what the sidebar body shows
- `sessionId` + `messages[]` — the active conversation

```
                       TOGGLE (Ctrl+/)
   ┌──────────┐  ─────────────────────────►  ┌─────────────────────────────┐
   │  CLOSED  │                              │            OPEN             │
   │ view=chat│  ◄─────────────────────────  │  ┌─────────┐  ┌──────────┐  │
   └──────────┘          CLOSE (✕ in header) │  │  CHAT   │⇄│ HISTORY  │  │
                                             │  └─────────┘  └──────────┘  │
                                             └─────────────────────────────┘

 CHAT sub-state transitions:                 HISTORY sub-state transitions:

  NEW_CHAT ──► fresh sessionId,               OPEN_HISTORY ──► GET /sessions
  messages=[], view stays 'chat'              SELECT(sid) ──► GET /sessions/sid
                                              │                → load msgs,
 SELECT_FROM_HISTORY ──► sessionId=sid,       │                  view='chat'
   messages=loaded, view='chat'               DELETE(sid) ──► tombstone event,
                                              │                row disappears
 SEND ──► STREAMING ──► done|stopped|error    BACK ◄────────── view='chat'
   └─ on settle: auto-append pair to JSONL
```

Decisions (deliberate):
- Reopening the sidebar resumes the last conversation (industry standard —
  ChatGPT/Claude behavior); **New Chat** is the explicit fresh-start action.
- Opening History never mutates the conversation; selecting a session is the
  only transition that swaps `messages`.
- Switching pages mid-stream is safe: the stream belongs to the mounted
  Chatbot, not the page.

## 4. JSONL database (append-only)

File: `backend/data/chat_sessions.jsonl`. One JSON object per line, written
append-only with a process lock — history can never be corrupted by a crash
mid-write, and the file doubles as an audit log ("nothing is forgotten").

```
{"type":"msg",  "session_id":"a1b2…","role":"user","content":"…","page":"dashboard","ts":1724300000000}
{"type":"msg",  "session_id":"a1b2…","role":"assistant","content":"…","provider":"inferx","model":"Qwen3.8-27B-FP8","ts":…}
{"type":"clear","session_id":"a1b2…","ts":…}                      ← Clear pressed
{"type":"deleted","session_id":"a1b2…","ts":…}                    ← row removed in History UI
```

Grouping on read (cached by file size+mtime):

```
lines ──► fold over sessions Map:
  msg      → sessions[sid].msgs.push(e)
  clear    → sessions[sid].msgs = []
  deleted  → sessions[sid].deleted = true   (excluded everywhere)
title = first user message, trimmed to 60 chars
```

REST surface (blueprint in `backend/chat_history.py`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/chat/history/sessions` | list `{session_id,title,created,updated,count,last_page}[]` |
| GET | `/api/chat/history/sessions/<sid>` | full message list (post-clear) |
| POST | `/api/chat/history/messages` | append batch `{session_id?, messages:[…]}` → assigns uuid |
| POST | `/api/chat/history/clear` | append clear marker |
| DELETE | `/api/chat/history/sessions/<sid>` | append delete tombstone |

localStorage remains the instant-restore cache for the active conversation;
the JSONL store is the durable source of truth shared across reloads.

## 5. Header redesign (overlap fix)

Before: floating toggle (`top-right, z-index 1001`) sat ON TOP of the sidebar
header, covering Clear. After: the toggle FAB renders **only when closed**;
when open, a uniform icon toolbar owns the top-right corner:

```
┌──────────────────────────────────────────────────┐
│ 💬 Trading Assistant      ⚙  🕘  ➕  🧹  ✕       │  ← all 28px icon buttons,
├──────────────────────────────────────────────────┤     even gaps, no absolutes
│ (chat view)                        (history view)│
└──────────────────────────────────────────────────┘
   ⚙ settings   🕘 history ⇄   ➕ new chat   🧹 clear   ✕ close
```

Each assistant/user bubble also gains a tiny page badge (`Dashboard`,
`Trade Replay`, `Spot Replay`) recording where the question was asked.

## 6. Files

| File | Change |
|---|---|
| `backend/chat_history.py` **new** | JSONL store + blueprint above |
| `backend/app.py` | register blueprint |
| `src/components/chatbot/assistantContext.js` **new** | registry + `useAssistantContext` |
| `src/App.js` | registry, single `<Chatbot>` mount, `chatOpen` ownership |
| `src/components/chatbot/Chatbot.js` | controlled `open`; view FSM; sessions; header toolbar; page badges |
| `src/components/chatbot/styles.css` | toolbar styles, history list styles |
| `src/OptionsAnalysisApp.js` | drop local Chatbot/open wiring; register context |
| `src/TradeReplayDemo.js`, `src/SpotReplay.js` | register contexts + screenshot refs |
