# backend/agent_bridge.py
#
# Agent control plane (see files/agent-mcp-design.md): lets an external agent
# drive the live UI. The React app holds one SSE connection open; this module
# broadcasts commands to it and collects results. The MCP server
# (backend/mcp_server.py) is just a tool layer over these HTTP endpoints.
#
#   UI ──GET /api/agent/stream──► subscriber queue ◄──POST /api/agent/command── agent
#   UI ──POST /api/agent/result/<id>──────────────► waiting agent (or polled later)
#   UI ──POST /api/agent/screenshot───────────────► latest PNG bytes for tools

import json
import os
import queue
import threading
import time
import uuid

from flask import Blueprint, Response, jsonify, request

agent_bp = Blueprint("agent_bridge", __name__)

# ── enable/disable switch (Settings → Preferences → MCP) ────────────────────
# Persists to backend/data/agent_settings.json so "off" survives restarts;
# OPTIONSCOPE_MCP_ENABLED seeds the default when no file exists yet.
_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
_SETTINGS_PATH = os.path.join(_DATA_DIR, "agent_settings.json")


def _load_enabled():
    try:
        with open(_SETTINGS_PATH) as f:
            return bool(json.load(f).get("enabled", True))
    except Exception:
        env = os.environ.get("OPTIONSCOPE_MCP_ENABLED")
        if env is not None:
            return env.strip().lower() not in ("0", "false", "no", "off")
        return True


_enabled = _load_enabled()


def _disabled_response():
    return jsonify(error="agent bridge is disabled — re-enable it in "
                         "OptionScope Settings → Preferences"), 403

_lock = threading.Lock()
_subscribers = set()          # set[queue.Queue] — one per connected UI tab
_results = {}                 # command_id -> {"ok":..., "data"/"error":..., "ts"}
_waiters = {}                 # command_id -> threading.Event
_active_page = None
_last_ui_seen = 0.0
_latest_shot = None           # {"png": bytes, "ts": float, "meta": {...}}
MAX_RESULTS = 64

# Persisted alongside `enabled` in data/agent_settings.json; read by the
# Electron launcher at spawn time (0.0.0.0 vs loopback-only Flask binding).
def _load_settings_file():
    try:
        with open(_SETTINGS_PATH) as f:
            return json.load(f) or {}
    except Exception:
        return {}


_allow_lan = bool(_load_settings_file().get("allow_lan", False))


def _broadcast(payload):
    data = json.dumps(payload)
    with _lock:
        subs = list(_subscribers)
    for q in subs:
        q.put(("command", data))


@agent_bp.get("/stream")
def stream():
    q = queue.Queue(maxsize=32)

    def gen():
        global _last_ui_seen
        try:
            with _lock:
                _subscribers.add(q)
            _last_ui_seen = time.time()
            # hello tells the UI (and status checks) the bridge is live
            yield f"event: hello\ndata: {json.dumps({'ok': True, 'ts': time.time()})}\n\n"
            while True:
                try:
                    kind, data = q.get(timeout=15)
                    yield f"event: {kind}\ndata: {data}\n\n"
                except queue.Empty:
                    yield ": keep-alive\n\n"  # comment ping keeps proxies quiet
        finally:
            with _lock:
                _subscribers.discard(q)

    resp = Response(gen(), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"
    return resp


def _ui_connected():
    with _lock:
        n = len(_subscribers)
    return n > 0, n


@agent_bp.post("/command")
def post_command():
    global _results, _waiters
    if not _enabled:
        return _disabled_response()
    body = request.get_json(silent=True) or {}
    ctype = body.get("type")
    if not ctype:
        return jsonify(error="missing 'type'"), 400
    connected, n = _ui_connected()
    if not connected:
        return jsonify(error="no app UI connected to the agent bridge — open OptionScope first",
                       ui_connected=False), 409

    cmd = {"id": uuid.uuid4().hex[:12], "type": ctype, "args": body.get("args") or {},
           "ts": time.time()}
    wait = request.args.get("wait") in ("1", "true")
    timeout = min(float(request.args.get("timeout", 15)), 60)

    ev = None
    if wait:
        ev = threading.Event()
        with _lock:
            _waiters[cmd["id"]] = ev

    _broadcast(cmd)

    if not wait:
        return jsonify(queued=True, id=cmd["id"])

    if ev.wait(timeout):
        with _lock:
            res = _results.get(cmd["id"])
            _waiters.pop(cmd["id"], None)
        status = 200 if res and res.get("ok") else 500
        return jsonify((res or {}).get("data") or {"error": (res or {}).get("error", "command failed")}), status
    with _lock:
        _waiters.pop(cmd["id"], None)
    return jsonify(error=f"UI did not answer command '{ctype}' within {timeout}s"), 504


@agent_bp.post("/result/<cmd_id>")
def post_result(cmd_id):
    body = request.get_json(silent=True) or {}
    res = {"ok": bool(body.get("ok")), "data": body.get("data"),
           "error": body.get("error"), "ts": time.time()}
    with _lock:
        _results[cmd_id] = res
        if len(_results) > MAX_RESULTS:
            for k in sorted(_results, key=lambda k: _results[k]["ts"])[:-MAX_RESULTS]:
                _results.pop(k, None)
        ev = _waiters.get(cmd_id)
    if ev:
        ev.set()
    return jsonify(ok=True)


@agent_bp.get("/result/<cmd_id>")
def get_result(cmd_id):
    if not _enabled:
        return _disabled_response()
    with _lock:
        res = _results.get(cmd_id)
    if not res:
        return jsonify(error="unknown or pending command id"), 404
    return jsonify(res)


@agent_bp.post("/screenshot")
def post_screenshot():
    global _latest_shot
    body = request.get_json(silent=True) or {}
    data_url = body.get("dataUrl") or ""
    if not data_url.startswith("data:image/png;base64,"):
        return jsonify(error="expected {dataUrl: 'data:image/png;base64,…'}"), 400
    import base64
    png = base64.b64decode(data_url.split(",", 1)[1])
    _latest_shot = {"png": png, "ts": time.time(),
                    "meta": {"width": body.get("width"), "height": body.get("height"),
                             "page": body.get("page")}}
    return jsonify(ok=True, bytes=len(png))


@agent_bp.get("/screenshot")
def get_screenshot():
    if not _enabled:
        return _disabled_response()
    if not _latest_shot:
        return jsonify(error="no screenshot taken yet — call the screenshot tool first"), 404
    meta = dict(_latest_shot["meta"] or {})
    meta["age_sec"] = round(time.time() - _latest_shot["ts"], 1)
    resp = Response(_latest_shot["png"], mimetype="image/png")
    resp.headers["X-Optionscope-Meta"] = json.dumps(meta)
    return resp


@agent_bp.post("/page")
def post_page():
    global _active_page, _last_ui_seen
    body = request.get_json(silent=True) or {}
    _active_page = body.get("page")
    _last_ui_seen = time.time()
    return jsonify(ok=True)


@agent_bp.get("/status")
def status():
    if not _enabled:
        return _disabled_response()
    connected, n = _ui_connected()
    return jsonify(ui_connected=connected, ui_tabs=n, active_page=_active_page,
                   last_ui_seen=_last_ui_seen or None,
                   screenshot_available=bool(_latest_shot),
                   commands_in_flight=len(_waiters))


# ── settings read/write (not gated — the app's own Settings UI reads this) ──

@agent_bp.get("/settings")
def get_settings():
    connected, n = _ui_connected()
    return jsonify(enabled=_enabled, allow_lan=_allow_lan, ui_connected=connected, ui_tabs=n)


@agent_bp.post("/settings")
def post_settings():
    global _enabled, _allow_lan
    body = request.get_json(silent=True) or {}
    if "enabled" not in body and "allow_lan" not in body:
        return jsonify(error="expected {'enabled': true|false, 'allow_lan': true|false}"), 400
    if "enabled" in body:
        _enabled = bool(body["enabled"])
    if "allow_lan" in body:
        _allow_lan = bool(body["allow_lan"])
    try:
        os.makedirs(_DATA_DIR, exist_ok=True)
        current = _load_settings_file()
        current["enabled"] = _enabled
        current["allow_lan"] = _allow_lan
        with open(_SETTINGS_PATH, "w") as f:
            json.dump(current, f)
    except OSError:
        pass  # keep the runtime switch even if the disk write fails
    return jsonify(ok=True, enabled=_enabled, allow_lan=_allow_lan)
