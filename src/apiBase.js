// src/apiBase.js
//
// Backend base URL resolved at RUNTIME:
//   - Desktop/packaged app: the page is served BY the Flask backend that
//     launch.js spawned (port varies per launch), so same-origin is always
//     correct — no dependency on a hardcoded port or a stray server.
//   - Dev server (react-scripts on :3000): there is no backend behind :3000,
//     so keep the documented dev convention of a manually-run Flask on :5000.
// This replaces the old hardcoded "http://localhost:5000" everywhere, so the
// app works identically when the browser reaches it via:
//   - http://localhost:3000/...        (WSL2 localhost forwarding)
//   - http://<WSL-IP>:3000/...         (mirrored / NAT networking mode)

const isDevServer = window.location.port === '3000';

export const API_BASE = isDevServer
  ? `${window.location.protocol}//${window.location.hostname}:5000`
  : window.location.origin;
