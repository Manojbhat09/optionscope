// desktop/main.js — OptionScope Electron shell
//
// Native window around the exact same React UI + Flask backend you run in a
// browser today (files/desktop-app-design.md §3):
//   1. pick a free localhost port
//   2. spawn the frozen backend sidecar (or python app.py in dev)
//   3. poll /api/health until ready
//   4. open a BrowserWindow pointed at the local server
//   5. kill the sidecar when the app quits
//
// Dev:      cd desktop && npm install && BACKEND_DIR=../backend npm start
// Package:  cd desktop && npx electron-builder   (CI does this per-OS)

const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

let win = null;
let backend = null;
let backendPid = null;

// ── free-port probe ──────────────────────────────────────────────────────────
function findFreePort(start) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

// ── sidecar lifecycle ────────────────────────────────────────────────────────
function startBackend(port) {
  const isWin = process.platform === 'win32';
  let bin, args = [], env = { ...process.env, PORT: String(port), PYTHONUNBUFFERED: '1' };

  if (app.isPackaged) {
    // PyInstaller one-file dropped into resources/backend by electron-builder
    bin = path.join(process.resourcesPath, 'backend', isWin ? 'optionscope-backend.exe' : 'optionscope-backend');
    fs.chmodSync(bin, 0o755); // no-op on Windows; fixes exec bit on mac/linux
    env.OPTIONSCOPE_BUILD_DIR = path.join(process.resourcesPath, 'build');
    args = [];
  } else {
    // dev fallback: run the Flask app from source with whatever python exists
    const backendDir = path.resolve(__dirname, process.env.BACKEND_DIR || '../backend');
    bin = process.env.PYTHON || (isWin ? 'python' : 'python3');
    args = ['-m', 'flask', 'run', '--port', String(port)];
    // Settings → Preferences → "Expose agent bridge beyond 127.0.0.1" persists
    // allow_lan here; it needs a rebind, so it applies on the next launch.
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(backendDir, 'data', 'agent_settings.json'), 'utf8'));
      if (cfg.allow_lan) args.push('--host', '0.0.0.0');
    } catch { /* no settings file yet — loopback only */ }
    env.OPTIONSCOPE_BUILD_DIR = path.resolve(__dirname, '../build');
    env.FLASK_APP = path.join(backendDir, 'app.py');
    env.PYTHONPATH = backendDir;
  }

  console.log(`[desktop] spawning backend: ${bin} ${args.join(' ')}`);
  backend = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  backendPid = backend.pid;
  backend.stdout.on('data', d => process.stdout.write(`[backend] ${d}`));
  backend.stderr.on('data', d => process.stderr.write(`[backend] ${d}`));
  backend.on('exit', (code) => console.log(`[desktop] backend exited (${code})`));
}

function stopBackend() {
  const pid = backendPid;
  backend = null;
  backendPid = null;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); // kill the tree
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    // Backup in case SIGTERM is ignored — must outlive app.quit() teardown,
    // hence short delay; the synchronous 'exit' handler below is the real
    // guarantee that the sidecar never outlives the app (the old orphan bug).
    setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, 800);
  }
}

// Last-chance synchronous kill on any quit path — timers may never fire
// during teardown, but 'exit' handlers always run.
process.on('exit', () => {
  if (backendPid) { try { process.kill(backendPid, 'SIGKILL'); } catch {} }
});

function waitHealthy(port, timeoutMs = 45000) {
  const url = `http://127.0.0.1:${port}/api/health`;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (!backend) return reject(new Error('backend died during startup'));
      const req = http.get(url, { timeout: 1500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) return reject(new Error('backend not healthy in time'));
      setTimeout(tick, 350);
    };
    tick();
  });
}

// ── window ───────────────────────────────────────────────────────────────────
async function createWindow() {
  const port = await findFreePort(57631);
  startBackend(port);
  try {
    await waitHealthy(port);
  } catch (err) {
    const { dialog } = require('electron');
    dialog.showErrorBox('OptionScope backend failed to start', String(err));
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    backgroundColor: '#0d1220',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
    show: false,
  });

  // open external links (docs, research sources) in the real browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('http://127.0.0.1')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(`http://127.0.0.1:${port}/Manojbhat09/optionscope`);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

app.whenReady().then(createWindow);
app.on('before-quit', stopBackend);
app.on('window-all-closed', () => { stopBackend(); app.quit(); });
app.on('activate', () => { if (!win && app.isReady()) createWindow(); });
