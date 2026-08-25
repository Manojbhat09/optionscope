# Agent Control Plane — MCP Server + In-App Bridge

Goal: let ANY agent (Claude, opencode, custom) autonomously drive the local
OptionScope app — navigate pages, take screenshots, read live app state —
through standard MCP tools, with zero browser-automation dependencies.

## Architecture

```
┌──────────────┐   stdio (JSON-RPC)   ┌────────────────────┐
│  Any agent   │◄────────────────────►│  backend/          │
│  (MCP client)│                      │  mcp_server.py     │
└──────────────┘                      │  (MCPServer, tools)│
                                      └─────────┬──────────┘
                                                │ HTTP (localhost)
                                                ▼
                                      ┌────────────────────┐
                                      │  Flask backend     │
                                      │  agent_bridge.py   │
                                      │  /api/agent/*      │
                                      └─────────┬──────────┘
                                    SSE commands│ results/screenshots (HTTP POST)
                                                ▼
                                      ┌────────────────────┐
                                      │  React app (UI)    │
                                      │  src/agentBridge.js│
                                      │  + hash routing    │
                                      └────────────────────┘
```

Key insight: the app's pages are React state, not URLs — an external driver
can't "navigate" without help. So the UI itself becomes the actuator:

1. **Hash routing** (`#/dashboard`, `#/replay`, `#/spot`) — pages become
   deep-linkable for humans and browser drivers alike.
2. **In-app bridge** (`src/agentBridge.js`) — opens one SSE stream to
   `/api/agent/stream`. The backend pushes commands; the UI executes them
   (navigate via hash, screenshot via html2canvas — already a dependency,
   state via the assistant context registry) and POSTs results back.
3. **MCP server** (`backend/mcp_server.py`) — thin tool layer over the
   bridge's HTTP API. Tools return text or PNG image content blocks.

## Command flow

```
agent ──tools/call navigate──► MCP ──POST /api/agent/command──► bridge
                                                                    │ SSE "command" event
   ◄──image/text content── MCP ◄──GET result── bridge ◄──POST /api/agent/result/<id>── UI
```

- Commands carry an id; `?wait=1&timeout=N` makes the POST block until the
  UI answers (or timeout → clear error).
- UI not open? `status.ui_connected: false` — tools say so instead of hanging.
- Screenshots: UI uploads PNG data-URL to `/api/agent/screenshot` BEFORE
  resolving the command, so the tool can fetch bytes race-free.

## Tools (MCP)

| tool               | args            | returns                                   |
|--------------------|-----------------|-------------------------------------------|
| app_status         | —               | backend health, bridge connected, page     |
| list_pages         | —               | the 3 pages + what lives on each           |
| navigate           | page            | ack {page} (UI switched)                   |
| screenshot         | —               | PNG image content of the visible app       |
| get_app_state      | —               | active page + structured context JSON      |
| read_chat_history  | limit           | assistant session list / recent messages   |

## Files

- `backend/agent_bridge.py` — SSE hub, command/result endpoints, status
- `backend/mcp_server.py` — MCPServer (mcp SDK ≥2.0), stdio transport
- `src/agentBridge.js` — UI-side executor (SSE → html2canvas / navigate / state)
- `src/App.js` — hash routing + bridge bootstrap
- `skills/optionscope-app/SKILL.md` — agent-facing manual + install one-liners

## Install story

```
claude mcp add optionscope -- <python> <repo>/backend/mcp_server.py
```

No build step, no ports beyond the app's own; stdio only.
