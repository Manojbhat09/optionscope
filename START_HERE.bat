@echo off
REM OptionScope - one-double-click launcher (Windows)
REM Enter credentials and AI keys in the app's Setup (gear) - no .env editing needed.
setlocal
cd /d "%~dp0"

echo ==========================================
echo    OptionScope - starting up...
echo ==========================================

where python >nul 2>nul
if errorlevel 1 (
  echo Python 3 not found. Install it from https://python.org and retry.
  pause & exit /b 1
)

if not exist .venv (
  echo Creating Python environment ^(first run only^)...
  python -m venv .venv
)
echo Installing/updating backend packages...
.venv\Scripts\pip install -q --upgrade pip
.venv\Scripts\pip install -q -r backend\requirements.txt

if not exist node_modules (
  echo Installing frontend packages ^(first run only, a few minutes^)...
  call npm install --no-audit --no-fund
)
if not exist build\index.html (
  echo Building the app...
  call npx react-scripts build
)

echo Starting server at http://localhost:5000 ...
start "" http://localhost:5000
set PORT=5000
.venv\Scripts\python backend\app.py
pause
