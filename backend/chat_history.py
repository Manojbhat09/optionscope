"""Persistent chat-history store for the trading assistant.

Append-only JSONL database (see files/assistant-history-design.md): every
mutation is a new line in backend/data/chat_sessions.jsonl, so the file is
both the durable source of truth and an audit log. Reads fold the event log
into session views; results are cached by (size, mtime) so listing stays O(1)
between writes.

Events:
  {"type":"msg","session_id":…,"role":"user"|"assistant","content":…,…}
  {"type":"clear","session_id":…}      — user pressed Clear: empties that session
  {"type":"deleted","session_id":…}    — removed from the History UI; excluded forever

Motivations honored here: nothing is ever rewritten or lost (append-only),
the store is trivially inspectable by eye, and a crash mid-write can damage
at most one trailing line — which the reader skips.
"""

import json
import os
import threading
import time
import uuid

from flask import Blueprint, jsonify, request

# Frozen (PyInstaller) binaries extract to a temp dir — persist data next to
# the executable instead so chat history survives restarts.
if getattr(__import__("sys"), "frozen", False):
    HISTORY_DIR = os.path.join(os.path.dirname(os.path.abspath(__import__("sys").executable)), "data")
else:
    HISTORY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
HISTORY_FILE = os.path.join(HISTORY_DIR, "chat_sessions.jsonl")

_lock = threading.Lock()          # serializes appends within this process
_cache = {"key": None, "sessions": {}}


def _append_event(evt):
    evt["ts"] = int(evt.get("ts") or time.time() * 1000)
    line = json.dumps(evt, ensure_ascii=False)
    with _lock:
        os.makedirs(HISTORY_DIR, exist_ok=True)
        with open(HISTORY_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
            f.flush()
            os.fsync(f.fileno())
    _cache["key"] = None  # invalidate read cache
    return evt


def _load_sessions():
    """Fold the JSONL event log into {sid: {created_at, updated_at, title,
    messages[], deleted}}. Cached until the file changes."""
    try:
        st = os.stat(HISTORY_FILE)
        key = (st.st_size, st.st_mtime_ns)
    except OSError:
        return {}
    if _cache["key"] == key:
        return _cache["sessions"]

    sessions = {}
    with _lock:
        try:
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                raw_lines = f.readlines()
        except OSError:
            raw_lines = []
    for raw in raw_lines:
        raw = raw.strip()
        if not raw:
            continue
        try:
            e = json.loads(raw)
        except json.JSONDecodeError:
            continue  # torn final line from a crash — skip it
        sid = e.get("session_id")
        if not sid:
            continue
        s = sessions.setdefault(sid, {
            "created_at": e.get("ts"), "updated_at": e.get("ts"),
            "title": "", "messages": [], "deleted": False,
        })
        s["created_at"] = min(s["created_at"] or e["ts"], e["ts"])
        s["updated_at"] = max(s["updated_at"] or e["ts"], e["ts"])
        etype = e.get("type")
        if etype == "msg":
            s["messages"].append({
                "role": e.get("role", "user"), "content": e.get("content", ""),
                "ts": e.get("ts"), "page": e.get("page"), "pageTitle": e.get("pageTitle"),
                "provider": e.get("provider"), "model": e.get("model"),
                "isError": bool(e.get("error")), "stopped": bool(e.get("stopped")),
            })
            if not s["title"] and e.get("role") == "user":
                s["title"] = (e.get("content") or "").strip().replace("\n", " ")[:60]
        elif etype == "clear":
            s["messages"] = []
        elif etype == "deleted":
            s["deleted"] = True

    _cache["key"] = key
    _cache["sessions"] = sessions
    return sessions


history_bp = Blueprint("chat_history", __name__)


@history_bp.route("/api/chat/history/sessions", methods=["GET"])
def list_sessions():
    sessions = _load_sessions()
    out = []
    for sid, s in sessions.items():
        if s["deleted"]:
            continue
        pages = [m.get("page") for m in s["messages"] if m.get("page")]
        out.append({
            "session_id": sid,
            "title": s["title"] or "(untitled chat)",
            "created_at": s["created_at"],
            "updated_at": s["updated_at"],
            "message_count": len(s["messages"]),
            "last_page": pages[-1] if pages else None,
        })
    out.sort(key=lambda x: x["updated_at"] or 0, reverse=True)
    return jsonify({"sessions": out})


@history_bp.route("/api/chat/history/sessions/<sid>", methods=["GET"])
def get_session(sid):
    s = _load_sessions().get(sid)
    if not s or s["deleted"]:
        return jsonify({"error": "not found"}), 404
    return jsonify({"session_id": sid, "messages": s["messages"]})


@history_bp.route("/api/chat/history/messages", methods=["POST"])
def append_messages():
    from flask import request
    body = request.get_json(silent=True) or {}
    msgs = body.get("messages") or []
    sid = body.get("session_id") or uuid.uuid4().hex[:12]
    page = body.get("page")
    page_title = body.get("pageTitle")
    saved = 0
    for m in msgs:
        role = "assistant" if m.get("role") == "assistant" else "user"
        content = (m.get("content") or "").strip()
        if not content and role == "assistant":
            continue  # don't persist empty pending bubbles
        _append_event({
            "type": "msg", "session_id": sid, "role": role, "content": content,
            "page": m.get("page") or page, "pageTitle": m.get("pageTitle") or page_title,
            "provider": m.get("provider"), "model": m.get("model"),
            "error": bool(m.get("isError")), "stopped": bool(m.get("stopped")),
            "ts": m.get("timestamp"),
        })
        saved += 1
    return jsonify({"ok": True, "session_id": sid, "saved": saved})


@history_bp.route("/api/chat/history/clear", methods=["POST"])
def clear_session():
    from flask import request
    body = request.get_json(silent=True) or {}
    sid = body.get("session_id")
    if not sid:
        return jsonify({"error": "session_id required"}), 400
    _append_event({"type": "clear", "session_id": sid})
    return jsonify({"ok": True})


@history_bp.route("/api/chat/history/clear-all", methods=["POST"])
def clear_all_sessions():
    """Danger zone: mark every session deleted (Settings → Preferences)."""
    sessions = _load_sessions()
    n = 0
    for sid, s in sessions.items():
        if not s["deleted"]:
            _append_event({"type": "deleted", "session_id": sid})
            n += 1
    return jsonify({"ok": True, "deleted": n})


@history_bp.route("/api/chat/history/sessions/<sid>", methods=["DELETE"])
def delete_session(sid):
    _append_event({"type": "deleted", "session_id": sid})
    return jsonify({"ok": True})


@history_bp.route("/api/chat/history/trim", methods=["POST"])
def trim_sessions():
    """Retention: keep only the newest `keep` sessions (Settings → Preferences)."""
    from flask import request, jsonify
    body = request.get_json(silent=True) or {}
    try:
        keep = int(body.get("keep") or 0)
    except (TypeError, ValueError):
        keep = 0
    if keep <= 0:
        return jsonify({"ok": True, "dropped": 0})
    sessions = _load_sessions()
    order = sorted(
        ((sid, s) for sid, s in sessions.items() if not s["deleted"]),
        key=lambda kv: kv[1].get("updated_at") or 0,
        reverse=True,
    )
    drop = [sid for sid, _ in order[keep:]]
    for sid in drop:
        _append_event({"type": "deleted", "session_id": sid})
    return jsonify({"ok": True, "dropped": len(drop)})
