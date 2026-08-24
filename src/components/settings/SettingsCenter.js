// src/components/settings/SettingsCenter.js
//
// OptionScope Settings Center — one centered modal over a dimmed, blurred
// page where every app setting lives: Robinhood credentials + date range,
// all AI provider keys (same localStorage slots the assistant sidebar and
// Spot Replay read), general preferences (theme incl. time-based auto,
// data & startup, analysis defaults, assistant sampling, MCP/agent control,
// env-file persistence, danger zone), and an About tab. Designed so a user
// who just cloned the repo never needs to touch a .env file — unless they
// want the env persistence feature, which writes it for them.
//
// Pattern notes (files/modern-ux-release-design.md §2): "responsible
// glassmorphism" — translucency only on the overlay itself; solid surfaces
// inside so text contrast stays WCAG-safe. Surfaces/text use the shared
// --os-* tokens so the modal respects day & night themes.

import React, { useEffect, useRef, useState } from 'react';
import {
  GearIcon, CloseIcon, KeyIcon, SunIcon, MoonIcon, MonitorIcon, DownloadIcon,
} from '../icons';
import { createPortal } from 'react-dom';
import { PROVIDERS } from './useProviderSettings';
import { SETTINGS, getSetting, setSetting, getAllSettings } from '../../appSettings';
import { API_BASE } from '../../apiBase';

const PROVIDER_FIELDS = [
  { id: 'anthropic', label: 'Anthropic (Claude)', placeholder: 'sk-ant-...' },
  { id: 'openai', label: 'OpenAI (GPT-4o)', placeholder: 'sk-...' },
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-...' },
  { id: 'inferx', label: 'InferX', placeholder: 'ix_...' },
  { id: 'zai', label: 'Z.ai (coding plan)', placeholder: 'API key…' },
  { id: 'commandcode', label: 'CommandCode (Provider plan+)', placeholder: 'user_…' },
  { id: 'custom', label: 'Custom / Local (optional)', placeholder: 'leave blank if none required' },
];

// Market-data credentials — the exact localStorage slots Trade Replay reads
// for intraday charts/news (alpaca_key / alpaca_secret / polygon_key).
const MARKET_KEY_FIELDS = [
  { id: 'alpaca_key', label: 'Alpaca key', placeholder: 'PK…' },
  { id: 'alpaca_secret', label: 'Alpaca secret', placeholder: '••••••••' },
  { id: 'polygon_key', label: 'Polygon key', placeholder: 'API key…' },
];

const inputStyle = {
  width: '100%', padding: '9px 12px', border: '1px solid var(--os-border)',
  borderRadius: 10, fontSize: 13.5, background: 'var(--os-surface)', color: 'var(--os-text)',
  boxSizing: 'border-box', outline: 'none', transition: 'border-color .15s, box-shadow .15s',
};

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--os-text-2)', marginBottom: 5 }}>
        {label}
        {hint && <span style={{ fontWeight: 400, color: 'var(--os-text-3)', marginLeft: 6 }}>{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function GroupTitle({ icon: Icon, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700,
      color: 'var(--os-accent, #1565c0)', margin: '18px 0 10px',
      borderTop: '1px solid var(--os-border)', paddingTop: 14,
    }}>
      <Icon size={13} /> {children}
    </div>
  );
}

function Hint({ children }) {
  return (
    <div style={{ fontSize: 11.5, color: 'var(--os-text-3)', lineHeight: 1.5, marginTop: 6 }}>
      {children}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 13, color: 'var(--os-text)', cursor: 'pointer', marginBottom: 10 }}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
      <span>
        {label}
        {hint && (
          <span style={{ display: 'block', fontSize: 11.5, color: 'var(--os-text-3)', lineHeight: 1.5, marginTop: 2 }}>
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}

function NumInput({ value, onChange, min, max, width = 110, suffix }) {
  return (
    <span>
      <input type="number" value={value} min={min} max={max}
             onChange={(e) => onChange(e.target.value)}
             style={{ ...inputStyle, width, padding: '6px 9px', fontSize: 13 }} />
      {suffix && <span style={{ fontSize: 11.5, color: 'var(--os-text-3)', marginLeft: 6 }}>{suffix}</span>}
    </span>
  );
}

export default function SettingsCenter({ open, onClose, credentials, onSaveCredentials, osTheme }) {
  const [tab, setTab] = useState('account');
  const [form, setForm] = useState(credentials);
  const [apiKeys, setApiKeys] = useState({});
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [showPw, setShowPw] = useState(false);
  const firstRef = useRef(null);

  // ── preferences state (seeded from the appSettings registry) ────────────────
  const [prefs, setPrefs] = useState({});
  const setP = (k, v) => setPrefs(prev => ({ ...prev, [k]: v }));
  const [themeChoice, setThemeChoice] = useState('light');
  const [marketKeys, setMarketKeys] = useState({ alpaca_key: '', alpaca_secret: '', polygon_key: '' });
  const [asstProvider, setAsstProvider] = useState('');
  const [asstModel, setAsstModel] = useState('');
  const [asstTimeout, setAsstTimeout] = useState(120);
  const [mcpEnabled, setMcpEnabled] = useState(() => {
    try { return JSON.parse(localStorage.getItem('mcp_enabled') ?? 'true'); } catch { return true; }
  });
  const [mcpAllowLan, setMcpAllowLan] = useState(false);
  const [mcpConnected, setMcpConnected] = useState(false);
  const [envInfo, setEnvInfo] = useState(null);

  // Re-seed the form each time the modal opens; pull AI keys live from their
  // canonical localStorage slots (shared with Chatbot / Spot Replay).
  useEffect(() => {
    if (!open) return;
    setForm(credentials);
    const keys = {};
    PROVIDER_FIELDS.forEach(({ id }) => { keys[id] = localStorage.getItem(`chat_key_${id}`) || ''; });
    setApiKeys(keys);
    setCustomBaseUrl(localStorage.getItem('chat_custom_base_url') || '');
    setCustomModel(localStorage.getItem('chat_custom_model') || '');

    setThemeChoice(osTheme?.saved || localStorage.getItem('os_theme') || 'light');
    setPrefs(getAllSettings());
    setMarketKeys({
      alpaca_key: localStorage.getItem('alpaca_key') || '',
      alpaca_secret: localStorage.getItem('alpaca_secret') || '',
      polygon_key: localStorage.getItem('polygon_key') || '',
    });
    setAsstProvider(localStorage.getItem('chat_provider') || '');
    setAsstModel(localStorage.getItem('chat_model') || '');
    const t = parseInt(localStorage.getItem('chat_timeout_sec'), 10);
    setAsstTimeout(Number.isFinite(t) && t > 0 ? t : 120);

    // MCP switch + LAN flag + live connectivity, straight from the backend.
    setMcpAllowLan(getSetting('mcp_allow_lan'));
    fetch(`${API_BASE}/api/agent/settings`)
      .then(r => r.json())
      .then(d => {
        if (typeof d.enabled === 'boolean') setMcpEnabled(d.enabled);
        if (typeof d.allow_lan === 'boolean') setMcpAllowLan(d.allow_lan);
        setMcpConnected(!!d.ui_connected);
      })
      .catch(() => {});
    // env-file status (what would be seeded / when it was last written)
    fetch(`${API_BASE}/api/app-settings/env`)
      .then(r => r.json())
      .then(d => setEnvInfo(d))
      .catch(() => setEnvInfo(null));

    setTab('account');
    setTimeout(() => firstRef.current?.focus(), 60);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc closes; focus trap is intentionally light (tab cycles are fine for a
  // short form) — but we keep focus out of the page behind via the overlay.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  // Collect every persisted value worth surviving a browser wipe.
  const buildEnvValues = () => {
    const lsKeys = [
      'os_theme', ...SETTINGS.map(s => s.key),
      'chat_provider', 'chat_model', 'chat_timeout_sec',
      'alpaca_key', 'alpaca_secret', 'polygon_key',
    ];
    if (prefs.rh_persist) lsKeys.push('dash_user', 'dash_pass'); // opt-in plaintext, warned in UI
    const values = {};
    lsKeys.forEach(k => {
      const v = localStorage.getItem(k);
      if (v !== null && v !== '') values[`OS_LS_${k}`] = v;
    });
    return values;
  };

  const writeEnv = async () => {
    try {
      const r = await fetch(`${API_BASE}/api/app-settings/env`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: buildEnvValues(), seed: !!prefs.env_seed_defaults }),
      });
      const d = await r.json();
      setEnvInfo({ ...(envInfo || {}), values: buildEnvValues(), seed: !!prefs.env_seed_defaults, path: d.path, justWritten: true });
    } catch { /* offline — Save still applied locally */ }
  };

  const save = async () => {
    onSaveCredentials(form);
    Object.entries(apiKeys).forEach(([id, v]) => localStorage.setItem(`chat_key_${id}`, v));
    if (customBaseUrl) localStorage.setItem('chat_custom_base_url', customBaseUrl);
    if (customModel) localStorage.setItem('chat_custom_model', customModel);

    // Preferences (registry) — theme handled separately (needs the hook)
    SETTINGS.forEach(({ key }) => setSetting(key, prefs[key]));
    MARKET_KEY_FIELDS.forEach(({ id }) => localStorage.setItem(id, (marketKeys[id] || '').trim()));
    localStorage.setItem('chat_provider', asstProvider);
    localStorage.setItem('chat_model', asstModel);
    localStorage.setItem('chat_timeout_sec', String(asstTimeout));
    osTheme?.setMode?.(themeChoice);
    localStorage.setItem('mcp_enabled', JSON.stringify(mcpEnabled));

    // MCP switch + LAN flag — one call; LAN applies on next launch (rebind).
    fetch(`${API_BASE}/api/agent/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: mcpEnabled, allow_lan: mcpAllowLan }),
    }).catch(() => {});

    // Chat retention — trim now so the choice takes effect immediately.
    const keepN = parseInt(prefs.chat_keep_last_n, 10) || 0;
    if (keepN > 0) {
      fetch(`${API_BASE}/api/chat/history/trim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keep: keepN }),
      }).catch(() => {});
    }

    // Env-file persistence
    if (prefs.env_write_on_save) writeEnv();

    onClose();
  };

  const exportChats = async () => {
    try {
      const r = await fetch(`${API_BASE}/api/chat/history/sessions`);
      const { sessions } = await r.json();
      const out = [];
      for (const s of sessions || []) {
        const m = await fetch(`${API_BASE}/api/chat/history/sessions/${s.session_id}`).then(x => x.json()).catch(() => ({}));
        out.push({ ...s, messages: m.messages || [] });
      }
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `optionscope-chats-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch { /* offline */ }
  };

  const clearAllLocalData = async () => {
    if (!window.confirm('Wipe ALL local OptionScope data — logins, API keys, chat history, notes, preferences? This cannot be undone.')) return;
    const prefixes = ['os_', 'dash_', 'tr_', 'chat_', 'provider_', 'spot_', 'mcp_', 'alpaca_',
      'polygon_', 'remember_', 'auto_', 'default_', 'data_', 'pl_', 'compact_', 'ai_', 'research_', 'env_'];
    Object.keys(localStorage)
      .filter(k => prefixes.some(p => k.startsWith(p)))
      .forEach(k => localStorage.removeItem(k));
    fetch(`${API_BASE}/api/chat/history/clear-all`, { method: 'POST' }).catch(() => {});
    fetch(`${API_BASE}/api/clear-cache`, { method: 'POST' }).catch(() => {});
    setTimeout(() => window.location.reload(), 300);
  };

  const tabBtn = (id, label) => (
    <button
      onClick={() => setTab(id)}
      style={{
        border: 'none', background: tab === id ? 'rgba(25,118,210,0.12)' : 'transparent',
        color: tab === id ? 'var(--os-accent, #1565c0)' : 'var(--os-text-2)',
        fontWeight: 600, fontSize: 13,
        padding: '8px 16px', borderRadius: 999, cursor: 'pointer', transition: 'background .15s',
      }}
    >
      {label}
    </button>
  );

  const choiceBtn = (value, label, Icon) => (
    <button
      onClick={() => setThemeChoice(value)}
      aria-pressed={themeChoice === value}
      style={{
        flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        padding: '8px 0', fontSize: 13, fontWeight: 600, cursor: 'pointer',
        borderRadius: 10, transition: 'all .15s',
        background: themeChoice === value ? 'rgba(25,118,210,0.14)' : 'var(--os-bg)',
        color: themeChoice === value ? 'var(--os-accent, #1565c0)' : 'var(--os-text-2)',
        border: `1px solid ${themeChoice === value ? 'var(--os-accent, #1565c0)' : 'var(--os-border)'}`,
      }}
    >
      <Icon size={14} /> {label}
    </button>
  );

  const smallBtn = {
    border: '1px solid var(--os-border)', background: 'var(--os-surface)', color: 'var(--os-text)',
    padding: '7px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
  };

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 3000,
        background: 'rgba(15, 23, 42, 0.55)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'sc-fade .18s ease',
      }}
      role="dialog" aria-modal="true" aria-label="OptionScope settings"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(680px, calc(100vw - 40px))', maxHeight: 'calc(100vh - 64px)',
          background: 'var(--os-surface)', color: 'var(--os-text)', borderRadius: 20, overflow: 'hidden',
          boxShadow: '0 24px 70px rgba(2, 8, 23, 0.45)',
          display: 'flex', flexDirection: 'column',
          animation: 'sc-pop .18s ease',
        }}
      >
        {/* header */}
        <div style={{
          padding: '18px 22px 12px', borderBottom: '1px solid var(--os-border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--os-text)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <GearIcon size={16} /> OptionScope Setup
            </div>
            <div style={{ fontSize: 12, color: 'var(--os-text-3)', marginTop: 2 }}>
              Everything in one place — saved privately in your browser
            </div>
          </div>
          <button onClick={onClose} aria-label="Close settings" title="Close (Esc)" style={{
            border: 'none', background: 'var(--os-bg)', width: 32, height: 32,
            borderRadius: 10, cursor: 'pointer', color: 'var(--os-text-2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><CloseIcon size={15} /></button>
        </div>

        {/* tabs */}
        <div style={{ padding: '10px 22px 0', display: 'flex', gap: 6 }}>
          {tabBtn('account', 'Account & Data')}
          {tabBtn('ai', 'AI Providers')}
          {tabBtn('prefs', 'Preferences')}
          {tabBtn('about', 'About')}
        </div>

        {/* body */}
        <div style={{ padding: '16px 22px', overflowY: 'auto' }}>
          {tab === 'account' && (
            <>
              <Field label="Robinhood username">
                <input ref={firstRef} style={inputStyle} value={form.username || ''}
                       onChange={(e) => setForm({ ...form, username: e.target.value })}
                       placeholder="your@email.com" autoComplete="username" />
              </Field>
              <Field label="Password">
                <div style={{ position: 'relative' }}>
                  <input style={{ ...inputStyle, paddingRight: 44 }} type={showPw ? 'text' : 'password'}
                         value={form.password || ''}
                         onChange={(e) => setForm({ ...form, password: e.target.value })}
                         placeholder="••••••••" autoComplete="current-password" />
                  <button onClick={() => setShowPw(v => !v)} aria-label="Toggle password visibility"
                          style={{ position: 'absolute', right: 10, top: 7, border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--os-text-2)' }}>
                    {showPw ? 'Hide' : 'Show'}
                  </button>
                </div>
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Default start date">
                  <input type="date" style={inputStyle} value={form.startDate || ''}
                         onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
                </Field>
                <Field label="Default end date">
                  <input type="date" style={inputStyle} value={form.endDate || ''}
                         onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
                </Field>
              </div>
              <Hint>
                Credentials stay in this browser's local storage and are sent only to your
                locally-running backend when you press “Fetch Data”. Nothing is uploaded anywhere else.
                Preferences → “Remember Robinhood login” saves them after each successful fetch.
              </Hint>
            </>
          )}

          {tab === 'ai' && (
            <>
              <Hint>
                Used by the trading assistant, Spot Replay analysis and chart reading.
                Any keys you paste here work everywhere — no need to enter them twice.
              </Hint>
              <div style={{ height: 8 }} />
              {PROVIDER_FIELDS.map(({ id, label, placeholder }) => (
                <Field key={id} label={label}>
                  <input style={inputStyle} type="password" value={apiKeys[id] || ''} placeholder={placeholder}
                         onChange={(e) => setApiKeys({ ...apiKeys, [id]: e.target.value })}
                         autoComplete="off" />
                </Field>
              ))}
              <Field label="Custom / Local base URL" hint="Ollama, LM Studio, vLLM…">
                <input style={inputStyle} value={customBaseUrl} placeholder="http://localhost:11434/v1"
                       onChange={(e) => setCustomBaseUrl(e.target.value)} />
              </Field>
              <Field label="Custom model name">
                <input style={inputStyle} value={customModel} placeholder="llama3.2, qwen2.5:0.5b, …"
                       onChange={(e) => setCustomModel(e.target.value)} />
              </Field>
            </>
          )}

          {tab === 'prefs' && (
            <>
              <GroupTitle icon={SunIcon}>Appearance</GroupTitle>
              <div style={{ display: 'flex', gap: 8 }}>
                {choiceBtn('light', 'Day', SunIcon)}
                {choiceBtn('dark', 'Night', MoonIcon)}
                {choiceBtn('auto', 'Auto', MonitorIcon)}
              </div>
              <Hint>
                Auto follows your computer's clock: night theme between 19:00 and 07:00 local
                time, day theme the rest of the day — switching hands-free while the app runs.
              </Hint>

              <GroupTitle icon={DownloadIcon}>Data &amp; startup</GroupTitle>
              <Toggle
                label="Remember Robinhood login after a successful fetch"
                hint="Saves your login in this browser after data loads successfully, so restarts don't ask again."
                checked={prefs.rh_persist} onChange={v => setP('rh_persist', v)}
              />
              <Toggle
                label="Auto-load trades on launch"
                hint="Fetches automatically when the app opens and a login is saved (served from cache — usually instant)."
                checked={prefs.auto_load_trades} onChange={v => setP('auto_load_trades', v)}
              />
              <Field label="Default date-range lookback" hint="0 = fixed 2023-01-01 start">
                <NumInput value={prefs.default_lookback_days ?? 0} min={0} max={3650}
                          onChange={v => setP('default_lookback_days', v)} suffix="days back from today" />
              </Field>
              <Field label="Chart data source">
                <select value={prefs.data_provider || 'auto'} onChange={e => setP('data_provider', e.target.value)} style={inputStyle}>
                  <option value="auto">Auto — use available API keys, yfinance fallback</option>
                  <option value="force_yfinance">Force yfinance (ignore Alpaca/Polygon keys)</option>
                </select>
              </Field>

              <GroupTitle icon={GearIcon}>Analysis defaults</GroupTitle>
              <Toggle
                label="Remember analysis filters between sessions"
                hint="Keeps the top-tables limit, Trade Replay gain-ratio and ticker filters across restarts."
                checked={prefs.remember_filters} onChange={v => setP('remember_filters', v)}
              />
              <Field label="P/L decimal places">
                <NumInput value={prefs.pl_decimals ?? 2} min={0} max={2}
                          onChange={v => setP('pl_decimals', v)} suffix="decimals" />
              </Field>
              <Toggle
                label="Compact thousands in P/L figures"
                hint="Shows $1.2k instead of $1,200.00 in the stat cards."
                checked={prefs.compact_numbers} onChange={v => setP('compact_numbers', v)}
              />

              <GroupTitle icon={GearIcon}>Assistant &amp; AI</GroupTitle>
              <Field label="Temperature" hint="blank = provider default">
                <NumInput value={prefs.ai_temperature ?? ''} min={0} max={2} step="0.1"
                          onChange={v => setP('ai_temperature', v)} />
              </Field>
              <Field label="Max tokens" hint="0 = provider default">
                <NumInput value={prefs.ai_max_tokens ?? 0} min={0} max={32000}
                          onChange={v => setP('ai_max_tokens', v)} suffix="tokens" />
              </Field>
              <Toggle
                label="Web research on by default (Spot Replay)"
                hint="Pre-checks the DuckDuckGo research option for new runs."
                checked={prefs.research_default} onChange={v => setP('research_default', v)}
              />
              <Field label="Chat history retention" hint="0 = keep everything">
                <NumInput value={prefs.chat_keep_last_n ?? 0} min={0} max={500}
                          onChange={v => setP('chat_keep_last_n', v)} suffix="most recent sessions kept" />
              </Field>
              <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                <button onClick={exportChats} style={smallBtn}><DownloadIcon size={12} /> Export chat history</button>
                <button onClick={async () => {
                  if (!window.confirm('Delete ALL assistant chat history? This cannot be undone.')) return;
                  await fetch(`${API_BASE}/api/chat/history/clear-all`, { method: 'POST' }).catch(() => {});
                }} style={smallBtn}>Clear chat history</button>
              </div>

              <GroupTitle icon={MonitorIcon}>MCP / agent control</GroupTitle>
              <Toggle
                label="Let AI agents control this app while it runs"
                hint="Exposes navigation, reading UI state, screenshots and data queries over the local agent bridge (paired with the bundled OptionScope MCP server). Takes effect immediately and stays off/on across restarts."
                checked={mcpEnabled} onChange={setMcpEnabled}
              />
              <Toggle
                label="Expose the bridge beyond 127.0.0.1 (allow LAN)"
                hint="Rebinds the backend to 0.0.0.0 so agents on other devices can connect. Applies on next app launch — only do this on trusted networks."
                checked={mcpAllowLan} onChange={setMcpAllowLan}
              />
              <Toggle
                label="Redact login & password fields in agent screenshots"
                hint="Paints over any credential input before the image is stored or served to an agent."
                checked={prefs.mcp_redact} onChange={v => setP('mcp_redact', v)}
              />
              <Hint>
                Bridge is currently <b>{mcpEnabled ? 'enabled' : 'disabled'}</b> · app UI connected: <b>{mcpConnected ? 'yes' : 'no'}</b> ·
                agents reach it at <code>{API_BASE}/api/agent</code> via the bundled <code>optionscope-mcp</code> server.
              </Hint>

              <GroupTitle icon={DownloadIcon}>Env-file persistence</GroupTitle>
              <Toggle
                label="Write settings to backend/.env on Save"
                hint="Exports preferences (and, if “Remember login” is on, your Robinhood login — in plain text) to the OS_* section of backend/.env. Manually-added .env entries are preserved."
                checked={prefs.env_write_on_save} onChange={v => setP('env_write_on_save', v)}
              />
              <Toggle
                label="Use .env values as defaults on startup"
                hint="On the next launch, any setting with no saved value is seeded from the env file. Choices made in the app always win over the file."
                checked={prefs.env_seed_defaults} onChange={v => setP('env_seed_defaults', v)}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 6px' }}>
                <button onClick={writeEnv} style={smallBtn}>Write now</button>
                <span style={{ fontSize: 11.5, color: 'var(--os-text-3)' }}>
                  {envInfo
                    ? `${envInfo.path || 'backend/.env'} · ${Object.keys(envInfo.values || {}).length} settings stored${envInfo.seed ? ' · seeding ON' : ''}${envInfo.justWritten ? ' · just written ✓' : ''}`
                    : 'backend not reachable — status unavailable'}
                </span>
              </div>

              <GroupTitle icon={CloseIcon}>Danger zone</GroupTitle>
              <button onClick={clearAllLocalData} style={{
                border: '1px solid #e53935', background: 'rgba(229,57,53,0.08)', color: '#e53935',
                padding: '8px 16px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
              }}>
                Clear ALL local data (logins, keys, chats, notes, preferences)
              </button>
              <Hint>Wipes browser storage, the backend order-history cache and every chat session, then reloads.</Hint>
            </>
          )}

          {tab === 'about' && (
            <div style={{ fontSize: 13, color: 'var(--os-text)', lineHeight: 1.75 }}>
              <p style={{ marginTop: 0 }}><b>OptionScope</b> — options trade analysis dashboard with a
              persistent AI assistant, Trade Replay, and Spot Replay (dynamic options-edge reports).</p>
              <p><b>Where things live</b></p>
              <ul style={{ paddingLeft: 20 }}>
                <li>AI provider keys &amp; credentials → your browser's local storage (this device only)</li>
                <li>Assistant chat history → <code>backend/data/chat_sessions.jsonl</code> (append-only)</li>
                <li>MCP agent-control switch → <code>backend/data/agent_settings.json</code></li>
                <li>Optional settings export → <code>backend/.env</code> (Preferences → env persistence)</li>
              </ul>
              <p><b>Shortcuts</b> — <code>Ctrl+/</code> toggle assistant · <code>Esc</code> close dialogs</p>
              <p style={{ color: 'var(--os-text-3)', fontSize: 11.5 }}>
                Quantitative research tooling. Not financial advice.
              </p>
            </div>
          )}
        </div>

        {/* footer */}
        <div style={{
          padding: '14px 22px', borderTop: '1px solid var(--os-border)',
          display: 'flex', justifyContent: 'flex-end', gap: 10, background: 'var(--os-bg)',
        }}>
          <button onClick={onClose} style={{
            border: '1px solid var(--os-border)', background: 'var(--os-surface)', color: 'var(--os-text)',
            padding: '9px 18px', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={save} className="sc-primary-btn" style={{
            border: 'none', background: 'linear-gradient(135deg,#1976d2,#1565c0)', color: '#fff',
            padding: '9px 22px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(21,101,192,.35)',
          }}>Save settings</button>
        </div>
      </div>

      <style>{`
        @keyframes sc-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes sc-pop { from { opacity: 0; transform: translateY(10px) scale(.98) } to { opacity: 1; transform: none } }
        .sc-primary-btn:hover { filter: brightness(1.07); }
        input:focus, select:focus { border-color: #1976d2 !important; box-shadow: 0 0 0 3px rgba(25,118,210,.15); }
      `}</style>
    </div>,
    document.body
  );
}
