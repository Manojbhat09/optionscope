@echo off
REM OptionScope - desktop app launcher (Windows)
REM Double-click to open the native Electron window.
REM For the browser-only version, use START_HERE.bat instead.
setlocal
cd /d "%~dp0"

echo ==========================================
echo    OptionScope - desktop app
echo ==========================================

where python >nul 2>nul
if errorlevel 1 (
  echo Python 3 not found. Install it from https://python.org and retry.
  pause & exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js/npm not found. Install Node 20+ from https://nodejs.org and retry.
  pause & exit /b 1
)

if not exist .venv (
  echo Creating Python environment ^(first run only^)...
  python -m venv .venv
)
echo Installing/updating backend packages...
.venv\Scripts\python -m pip install -q --upgrade pip
.venv\Scripts\python -m pip install -q -r backend\requirements.txt

if not exist node_modules (
  echo Installing frontend packages ^(first run only, a few minutes^)...
  call npm install --no-audit --no-fund
)
if not exist build\index.html (
  echo Building the web UI...
  call npx react-scripts build
)

if not exist desktop\node_modules (
  echo Installing desktop app packages ^(first run only^)...
  pushd desktop
  call npm install --no-audit --no-fund
  popd
)

REM Electron fallback uses this Python when frozen sidecar not present
set PYTHON=%~dp0.venv\Scripts\python
set BACKEND_DIR=%~dp0backend
call npm --prefix desktop start
pause
