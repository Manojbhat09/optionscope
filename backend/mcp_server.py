#!/usr/bin/env python
"""backend/mcp_server.py — OptionScope MCP server (stdio).

Lets any MCP client (Claude Desktop/Code, opencode, custom agents) drive the
locally-running OptionScope app: navigate pages, take screenshots, and read
live structured state. Thin tool layer over the agent bridge HTTP API
(backend/agent_bridge.py) — see files/agent-mcp-design.md.

Run:  <python> backend/mcp_server.py          (stdio transport)
Env:  OPTIONSCOPE_API   default http://127.0.0.1:5000
"""

import base64
import json
import os
import sys

import requests
from mcp.server.mcpserver import MCPServer, Image

API = os.environ.get("OPTIONSCOPE_API", "http://127.0.0.1:5000").rstrip("/")
TIMEOUT = float(os.environ.get("OPTIONSCOPE_MCP_TIMEOUT", "20"))

mcp = MCPServer(
    name="optionscope",
    title="OptionScope",
    description="Drive the locally-running OptionScope trading app: navigate pages, screenshot, inspect live state.",
    instructions=(
        "OptionScope is the user's local options-trading workbench. It has three pages:\n"
        "- dashboard: portfolio analytics from fetched Robinhood history (P&L, win rate, charts)\n"
        "- replay: Trade Replay — scatter of past trades; click-through trade forensics\n"
        "- spot: Spot Replay — paste a live option position, get an AI edge analysis\n"
        "Typical loop: app_status → navigate(page) → screenshot() → get_app_state().\n"
        "The app must be RUNNING (desktop window or browser) for UI tools to work;\n"
        "app_status tells you if the UI is connected to the bridge."
    ),
)


def _get(path, **kw):
    r = requests.get(f"{API}{path}", timeout=TIMEOUT, **kw)
    r.raise_for_status()
    return r


def _command(ctype, args=None, timeout=TIMEOUT):
    """Send a bridge command and wait for the UI to answer."""
    r = requests.post(
        f"{API}/api/agent/command",
        params={"wait": 1, "timeout": timeout},
        json={"type": ctype, "args": args or {}},
        timeout=timeout + 10,
    )
    if r.status_code == 409:
        raise RuntimeError("OptionScope UI is not running/open — start the app, then retry.")
    if r.status_code == 504:
        raise RuntimeError(f"UI accepted '{ctype}' but did not answer in time.")
    r.raise_for_status()
    return r.json()


@mcp.tool()
def app_status() -> str:
    """Check the app is alive and the UI bridge is connected. Call this first."""
    out = {"api": API}
    try:
        out["health"] = _get("/api/health").json()
    except Exception as e:
        return json.dumps({"api": API, "error": f"backend unreachable: {e}"})
    try:
        out["bridge"] = _get("/api/agent/status").json()
    except Exception as e:
        out["bridge"] = {"error": str(e)}
    return json.dumps(out, indent=1)


@mcp.tool()
def list_pages() -> str:
    """List the app pages and what each one does."""
    return json.dumps({
        "dashboard": {"hash": "#/dashboard", "what": "Portfolio analytics: P&L cards, win rate, per-instrument charts, trade table. Context includes trade counts and totals."},
        "replay": {"hash": "#/replay", "what": "Trade Replay: scatter of historical option trades; select a dot for full trade forensics (candles, news, journal)."},
        "spot": {"hash": "#/spot", "what": "Spot Replay: paste a live option position; AI pipeline returns market/regime/Monte-Carlo/ML analysis and a trade verdict."},
    }, indent=1)


@mcp.tool()
def navigate(page: str) -> str:
    """Switch the visible app page. page: 'dashboard' | 'replay' | 'spot'."""
    if page not in ("dashboard", "replay", "spot"):
        return json.dumps({"error": f"unknown page '{page}' — use dashboard | replay | spot"})
    return json.dumps(_command("navigate", {"page": page}))


@mcp.tool()
def screenshot() -> Image:
    """Capture the currently visible app window as a PNG image."""
    meta = _command("screenshot")
    png = _get("/api/agent/screenshot").content
    return Image(data=png, format="png") if meta.get("stored", True) else Image(data=png, format="png")


@mcp.tool()
def get_app_state() -> str:
    """Read structured state of the visible page: title, page-specific context
    (portfolio summary / selected trade / spot form + verdict), URL, theme."""
    return json.dumps(_command("get_state"), indent=1, default=str)


@mcp.tool()
def read_chat_history(limit: int = 10) -> str:
    """List recent assistant chat sessions (id, title, page, message counts)."""
    sessions = _get("/api/chat/history/sessions").json()
    sessions = sessions.get("sessions", sessions)
    if isinstance(sessions, list):
        sessions = sessions[: max(0, limit)]
    return json.dumps(sessions, indent=1, default=str)


if __name__ == "__main__":
    if "-v" in sys.argv or "--verbose" in sys.argv:
        print(f"[optionscope-mcp] API={API}", file=sys.stderr)
    mcp.run("stdio")
