#!/usr/bin/env bash
# OptionScope — desktop app launcher (macOS / Linux)
#
# Double-click or run:   ./APP_START_HERE.sh
# Opens the native Electron window (same UI as the browser).
# For the browser-only version, use ./START_HERE.sh instead.
#
# macOS: clone the repo on your Mac mini and run this script — it uses the
#        same source the .dmg installer is built from. The packaged .dmg
#        (macOS x64 + arm64) and Linux .AppImage/.deb appear in the GitHub
#        Release once billing is unlocked (tag v* → Actions → Release).
set -e
cd "$(dirname "$0")"

echo "╔══════════════════════════════════════════╗"
echo "║   OptionScope — desktop app             ║"
echo "╚══════════════════════════════════════════╝"

PYTHON_BIN="${PYTHON:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "✖ Python 3 not found. Install it from https://python.org and retry."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "✖ Node.js/npm not found. Install Node 20+ from https://nodejs.org and retry."
  exit 1
fi

# ── backend deps (isolated venv, reused) ───────────────────────────────────
if [ ! -d .venv ]; then
  echo "→ Creating Python environment (first run only)…"
  "$PYTHON_BIN" -m venv .venv
fi
echo "→ Installing/updating backend packages…"
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q -r backend/requirements.txt

# ── frontend build (skipped if already built) ──────────────────────────────
if [ ! -d node_modules ]; then
  echo "→ Installing frontend packages (first run only, a few minutes)…"
  npm install --no-audit --no-fund
fi
if [ ! -f build/index.html ] || [ src/App.js -nt build/index.html ]; then
  echo "→ Building the web UI…"
  npx react-scripts build
fi

# ── desktop shell ──────────────────────────────────────────────────────────
if [ ! -d desktop/node_modules ]; then
  echo "→ Installing desktop app packages (first run only)…"
  (cd desktop && npm install --no-audit --no-fund)
fi

# Electron's Python fallback needs the venv python
export PYTHON="$(pwd)/.venv/bin/python"
export BACKEND_DIR="$(pwd)/backend"
# WSLg auto-display handled by desktop/launch.js; on macOS no DISPLAY needed
exec npm --prefix desktop start
