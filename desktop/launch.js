#!/usr/bin/env node
// desktop/launch.js — display-aware Electron launcher
//
// Electron dies with a cryptic SIGSEGV when started without any display
// (SSH/tmux/container sessions). This wrapper detects that case, tries the
// usual default display, and exits with actionable instructions instead.

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

function findFreePort(start) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => srv.listen(start + 1, '127.0.0.1'));
    srv.once('listening', () => srv.close(() => resolve(start)));
    srv.listen(start, '127.0.0.1');
  });
}

(async () => {
  // Linux: make sure we ACTUALLY have a usable display before spawning
  // Electron — otherwise it SIGSEGVs with a cryptic ozone error.
  // Two X transports exist: unix sockets (/tmp/.X11-unix/Xn — what WSLg and
  // most desktops use) and TCP (127.0.0.1:6000+n — SSH forwarding).
  const xAliveUnix = (n) => fs.existsSync(`/tmp/.X11-unix/X${n}`);
  const xAliveTcp = (n) => new Promise((resolve) => {
    const s = net.connect(6000 + n, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 400);
  });
  const xAlive = async (n) => xAliveUnix(n) || (await xAliveTcp(n));
  const extraArgs = [];

  if (process.platform === 'linux') {
    if (process.env.DISPLAY) {
      const m = process.env.DISPLAY.match(/:(\d+)/);
      const alive = m ? await xAlive(Number(m[1])) : false;
      if (!alive) {
        console.log(`[launch] $DISPLAY=${process.env.DISPLAY} points at a dead/stale X server — clearing it`);
        delete process.env.DISPLAY; // fall through to auto-detection below
      }
    }
    if (!process.env.DISPLAY && !extraArgs.length) {
      let found = null;
      for (const n of [0, 1]) {
        if (await xAlive(n)) { found = `:${n}`; break; }
      }
      if (found) {
        console.log(`[launch] found live X server on ${found}`);
        process.env.DISPLAY = found;
      } else if (process.env.WAYLAND_DISPLAY || fs.existsSync(path.join(process.env.XDG_RUNTIME_DIR || '/run/user/0', 'wayland-0'))) {
        console.log('[launch] no X server, but Wayland socket present — using native Wayland');
        extraArgs.push('--ozone-platform-hint=auto');
      } else {
        console.error(`
✖ No graphical display available on this machine.

  Electron needs a desktop session (X11 or Wayland). Options:

  · WSL2 (Windows): make sure WSLg is enabled, then from a WSL terminal:
      export DISPLAY=:0 && npm start
  · Use the app in your normal browser instead:
      http://<this-host>:3000/Manojbhat09/optionscope   (dev)
      http://<this-host>:5000/Manojbhat09/optionscope   (production build)
  · Run Electron on your own desktop/laptop once installers are built
      (tag v* → GitHub Release → OptionScope-Setup.exe / .dmg / .AppImage)
  · SSH from a machine WITH a display:   ssh -X user@host
  · Off-screen testing only:             xvfb-run -a npm start
`);
        process.exit(1);
      }
    }
  }

  const dbgPort = await findFreePort(9333);
  const electronBin = path.join(__dirname, 'node_modules', '.bin', 'electron');
  const child = spawn(
    fs.existsSync(electronBin) ? electronBin : 'npx',
    fs.existsSync(electronBin) ? ['.', `--remote-debugging-port=${dbgPort}`, ...extraArgs] : ['electron', '.', `--remote-debugging-port=${dbgPort}`, ...extraArgs],
    { cwd: __dirname, stdio: 'inherit', env: process.env }
  );
  child.on('exit', (code) => process.exit(code ?? 0));
})().catch((e) => { console.error(e); process.exit(1); });
