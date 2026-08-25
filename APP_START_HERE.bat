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
  REM Try common install locations (installer without PATH, nvm, fnm)
  if exist "C:\Program Files\nodejs\npm.cmd" set "PATH=C:\Program Files\nodejs;%PATH%"
  if exist "C:\Program Files (x86)\nodejs\npm.cmd" set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
  if exist "%APPDATA%\nvm\current\npm.cmd" set "PATH=%APPDATA%\nvm\current;%PATH%"
  where npm >nul 2>nul
  if errorlevel 1 (
    echo Node.js/npm not found.
    echo   1. Install Node 20+ from https://nodejs.org  (check "Add to PATH" during setup)
    echo   2. Close ALL terminals / reboot, then double-click again
    echo   3. Test in a new cmd:  node --version  ^&  npm --version
    echo.
    echo PATH=%PATH%
    pause & exit /b 1
  )
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
