---
name: optionscope-app
description: Drive the user's locally-running OptionScope trading app autonomously — navigate its pages (dashboard / trade replay / spot replay), take screenshots, and read live structured state through MCP tools or plain HTTP endpoints. Use when the user asks to inspect, automate, test, or control OptionScope, or wants an agent to see and operate the app.
---

# OptionScope App Control

OptionScope is a local options-trading workbench (Flask backend + React UI +
optional Electron desktop shell). An MCP server ships with it so any agent
can operate the live app like a human would: switch pages, look at them,
and read their state — no browser automation needed.

## Prerequisites

The app must be running (its UI holds the control bridge open):

```bash
# desktop app (Windows/macOS/Linux)
cd desktop && BACKEND_DIR=../backend PYTHON=<python-with-deps> npm start
# or plain web: backend on :5000, UI served at /
cd backend && python -m flask run --port 5000   # then open http://127.0.0.1:5000
```

## Quick MCP install

```bash
# Claude Code / opencode
claude mcp add optionscope -- /home/mbhat/miniconda3/envs/tradebot/bin/python /home/mbhat/optionscope/backend/mcp_server.py

# Claude Desktop / any JSON-config client (claude_desktop_config.json / mcp config)
{ "mcpServers": { "optionscope": {
    "command": "/home/mbhat/miniconda3/envs/tradebot/bin/python",
    "args": ["/home/mbhat/optionscope/backend/mcp_server.py"],
    "env": { "OPTIONSCOPE_API": "http://127.0.0.1:5000" } } } }
```

`pip install mcp` is the only dependency (already in the tradebot env).
Override the backend URL with `OPTIONSCOPE_API` if not on :5000.

## Tools

| tool | args | does |
|---|---|---|
| `app_status` | — | Backend health + is the UI connected to the bridge + active page. **Call first.** |
| `list_pages` | — | The three pages and what each contains. |
| `navigate` | `page` | Switch the visible page: `dashboard` \| `replay` \| `spot`. |
| `screenshot` | — | PNG of the visible app, returned as an image content block. |
| `get_app_state` | — | Structured JSON: active page, title, page context (portfolio summary / selected trade / spot form+verdict), URL, theme. |
| `read_chat_history` | `limit` | Recent assistant chat sessions (id, title, page, counts). |

## Recommended loop

1. `app_status` → confirm `bridge.ui_connected: true` and note `active_page`.
2. `navigate` where you need; `screenshot` to *see* it; `get_app_state` to *read* it.
3. State beats pixels: prefer `get_app_state` for facts (numbers, verdicts),
   screenshots for layout/visual checks.

## Direct HTTP endpoints (no MCP needed)

Base: `http://127.0.0.1:5000` (backend). The UI executes commands; results
arrive synchronously when `?wait=1`.

```
GET  /api/health                      backend liveness
GET  /api/agent/status                {ui_connected, active_page, screenshot_available}
GET  /api/agent/stream                SSE: hello / command events (UI consumes this)
POST /api/agent/command?wait=1        {type, args} → result JSON
     types: navigate{page} | screenshot{} | get_state{} | ping{}
POST /api/agent/result/<id>           UI posts command results (internal)
GET  /api/agent/screenshot            latest screenshot PNG (X-Optionscope-Meta header)
GET  /api/chat/history/sessions       assistant session list
```

Example:

```bash
curl -s -X POST 'http://127.0.0.1:5000/api/agent/command?wait=1' \
  -H 'Content-Type: application/json' \
  -d '{"type":"navigate","args":{"page":"spot"}}'
curl -s http://127.0.0.1:5000/api/agent/screenshot -o shot.png
```

## Pages & their state (what `get_app_state.context` returns)

- **dashboard** — trade counts, total P&L, win rate, date range, notes.
- **replay** — loaded trade count, filters (ticker/min gain ratio), selected trade details.
- **spot** — form (ticker/strike/expiry/…), paste buffer, last analysis verdict if run.

## Troubleshooting

- `409 no app UI connected` → the app window/browser tab is closed; start it.
- `504 did not answer` → UI tab is asleep (background tab throttling); focus it.
- Screenshot 404 → no screenshot taken yet in this backend session.
- Deep links work too: `http://127.0.0.1:5000/#/replay`.
