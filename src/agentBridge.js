// src/agentBridge.js
//
// UI half of the agent control plane (files/agent-mcp-design.md): keeps one
// SSE connection open to the backend bridge and executes commands from any
// connected agent — navigate (hash routing), screenshot (html2canvas, already
// a dependency via the assistant), get_state (assistant context registry).
// Results are POSTed back before the command resolves server-side.

import html2canvas from 'html2canvas';
import { API_BASE } from './apiBase';

let started = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function startAgentBridge({ getPage, navigate, getActiveContext }) {
  if (started || typeof window === 'undefined' || !window.EventSource) return;
  started = true;

  const post = (url, body) => fetch(`${API_BASE}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});

  async function handle(cmd) {
    const args = cmd.args || {};
    switch (cmd.type) {
      case 'ping':
        return { pong: Date.now() };

      case 'navigate': {
        const page = String(args.page || '');
        if (!['dashboard', 'replay', 'spot'].includes(page)) {
          throw new Error(`unknown page '${args.page}' (dashboard | replay | spot)`);
        }
        navigate(page);
        await sleep(400); // let the render settle so a follow-up screenshot is current
        return { page, hash: window.location.hash };
      }

      case 'screenshot': {
        const root = document.querySelector('.App') || document.body;
        // Settings → Preferences → redaction: mask login/password fields so
        // credentials never leave the machine inside an agent screenshot.
        const redact = localStorage.getItem('mcp_redact') === 'true';
        const rects = [];
        if (redact) {
          const rootBox = root.getBoundingClientRect();
          document.querySelectorAll('input').forEach(el => {
            const t = (el.type || '').toLowerCase();
            const secret = t === 'password' || t === 'email' || (el.value || '').includes('@');
            if (!secret || !el.offsetWidth || !el.offsetHeight) return;
            const b = el.getBoundingClientRect();
            rects.push({ x: b.left - rootBox.left, y: b.top - rootBox.top, w: b.width, h: b.height });
          });
        }
        const canvas = await html2canvas(root, {
          scale: Math.min(window.devicePixelRatio || 1, 2),
          useCORS: true, logging: false,
          windowWidth: Math.max(document.documentElement.scrollWidth, window.innerWidth),
          windowHeight: Math.max(document.documentElement.scrollHeight, window.innerHeight),
        });
        if (rects.length) {
          const g = canvas.getContext('2d');
          const sx = canvas.width / root.offsetWidth;
          const sy = canvas.height / root.offsetHeight;
          g.fillStyle = '#000';
          rects.forEach(r => g.fillRect(r.x * sx, r.y * sy, r.w * sx, r.h * sy));
        }
        const dataUrl = canvas.toDataURL('image/png');
        const up = await post('/api/agent/screenshot', {
          dataUrl, width: canvas.width, height: canvas.height, page: getPage(),
        });
        const upBody = up && up.ok ? await up.json().catch(() => ({})) : {};
        return { stored: !!upBody.ok, bytes: upBody.bytes, width: canvas.width, height: canvas.height,
                 redacted: rects.length };
      }

      case 'get_state': {
        const ctx = getActiveContext ? getActiveContext() : null;
        return {
          page: getPage(),
          title: ctx?.title ? ctx.title() : null,
          context: ctx?.getContext ? ctx.getContext() : null,
          url: window.location.href,
          theme: document.documentElement.dataset.theme || null,
          viewport: { w: window.innerWidth, h: window.innerHeight },
        };
      }

      default:
        throw new Error(`unknown command '${cmd.type}'`);
    }
  }

  const es = new EventSource(`${API_BASE}/api/agent/stream`);
  es.addEventListener('command', async (e) => {
    let cmd;
    try { cmd = JSON.parse(e.data); } catch { return; }
    let result;
    try {
      result = { ok: true, data: await handle(cmd) };
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) };
    }
    post(`/api/agent/result/${cmd.id}`, result);
  });
  es.onerror = () => { /* EventSource auto-reconnects */ };

  // Report the active page so /api/agent/status is meaningful without polling
  window.__osReportPage = () => post('/api/agent/page', { page: getPage() });
  window.__osReportPage();
}
