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
.venv\Scripts\python -m pip install -q --upgrade pip
.venv\Scripts\python -m pip install -q -r backend\requirements.txt

REM npm only needed if frontend isn't already built (portable zip ships prebuilt build/)
set NEED_NPM=0
if not exist node_modules set NEED_NPM=1
if not exist build\index.html set NEED_NPM=1
if %NEED_NPM%==1 (
  where npm >nul 2>nul
  if errorlevel 1 (
    if exist "C:\Program Files\nodejs\npm.cmd" set "PATH=C:\Program Files\nodejs;%PATH%"
    if exist "C:\Program Files (x86)\nodejs\npm.cmd" set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
    where npm >nul 2>nul
    if errorlevel 1 (
      echo Node.js/npm needed to build the app but not found.
      echo   1. Install Node 20+ from https://nodejs.org  (check "Add to PATH")
      echo   2. Close ALL terminals / reboot, then double-click again
      echo   3. Test:  node --version  ^&  npm --version
      pause & exit /b 1
    )
  )
)
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
