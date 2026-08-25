#!/usr/bin/env bash
# OptionScope — one-command launcher (macOS / Linux)
#
# Clone (or download & unzip) this repo, then run:
#   ./START_HERE.sh
# A browser opens at http://localhost:5000 when everything is ready.
# No .env editing required — enter credentials and AI keys in the app's ⚙️ Setup.
set -e
cd "$(dirname "$0")"

echo "╔══════════════════════════════════════════╗"
echo "║   📊 OptionScope — starting up…          ║"
echo "╚══════════════════════════════════════════╝"

PYTHON="${PYTHON:-python3}"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "✖ Python 3 not found. Install it from https://python.org and retry."
  exit 1
fi

# ── backend deps (isolated venv, reused on later runs) ──────────────────────
if [ ! -d .venv ]; then
  echo "→ Creating Python environment (first run only)…"
  "$PYTHON" -m venv .venv
fi
echo "→ Installing/updating backend packages…"
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q -r backend/requirements.txt

# ── frontend build (skipped if already built and node_modules present) ──────
if [ ! -d node_modules ]; then
  echo "→ Installing frontend packages (first run only, a few minutes)…"
  npm install --no-audit --no-fund
fi
if [ ! -f build/index.html ] || [ src/App.js -nt build/index.html ]; then
  echo "→ Building the app…"
  npx react-scripts build
fi

# ── launch ──────────────────────────────────────────────────────────────────
echo "→ Starting server at http://localhost:5000 …"
( sleep 4
  if command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:5000
  elif command -v open >/dev/null 2>&1; then open http://localhost:5000
  else echo "   Open http://localhost:5000 in your browser"; fi ) &
PORT=5000 .venv/bin/python backend/app.py
