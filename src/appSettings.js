// src/appSettings.js
//
// Central registry for OptionScope's general preferences (Settings →
// Preferences). Every setting lives in localStorage under its own key with a
// declared default; writes dispatch a window event so live surfaces (e.g. the
// dashboard's number formatting) can re-render without a reload.
//
// The same keys are what "Write settings to env file" exports (as OS_LS_<key>
// lines in backend/.env) and what "Use defaults from env file" seeds back at
// boot — see backend/app.py /api/app-settings/env and src/index.js.

import { useEffect, useState } from 'react';

export const SETTINGS = [
  // Data & startup
  { key: 'rh_persist',          type: 'bool', def: true,  label: 'Remember Robinhood login after a successful fetch' },
  { key: 'auto_load_trades',    type: 'bool', def: true,  label: 'Auto-load trades on launch (when login is saved)' },
  { key: 'default_lookback_days', type: 'num', def: 0,    label: 'Default date-range lookback (days; 0 = fixed 2023-01-01)' },
  { key: 'data_provider',       type: 'str',  def: 'auto', label: 'Chart data source: auto | force_yfinance' },

  // Analysis defaults
  { key: 'remember_filters',    type: 'bool', def: true,  label: 'Remember analysis filters between sessions' },
  { key: 'pl_decimals',         type: 'num',  def: 2,     label: 'P/L decimal places (0–2)' },
  { key: 'compact_numbers',     type: 'bool', def: false, label: 'Compact thousands in P/L figures ($1.2k)' },

  // Assistant & AI
  { key: 'ai_temperature',      type: 'num',  def: '',    label: 'Assistant temperature (blank = provider default)' },
  { key: 'ai_max_tokens',       type: 'num',  def: 0,     label: 'Assistant max tokens (0 = provider default)' },
  { key: 'research_default',    type: 'bool', def: true,  label: 'Web research on by default (Spot Replay)' },
  { key: 'chat_keep_last_n',    type: 'num',  def: 0,     label: 'Keep only the last N chat sessions (0 = unlimited)' },

  // Agent / MCP
  { key: 'mcp_allow_lan',       type: 'bool', def: false, label: 'Expose agent bridge beyond 127.0.0.1 (applies next launch)' },
  { key: 'mcp_redact',          type: 'bool', def: false, label: 'Redact login/password fields in agent screenshots' },

  // Env-file persistence
  { key: 'env_write_on_save',   type: 'bool', def: false, label: 'Write settings to backend/.env on Save' },
  { key: 'env_seed_defaults',   type: 'bool', def: false, label: 'Use .env values as defaults on startup' },
];

const INDEX = Object.fromEntries(SETTINGS.map(s => [s.key, s]));

export function getSetting(key) {
  const spec = INDEX[key];
  const raw = localStorage.getItem(key);
  if (raw === null) return spec ? spec.def : undefined;
  if (!spec || spec.type === 'str') return raw;
  if (spec.type === 'bool') return raw === 'true';
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : spec.def;
}

// Write + notify live consumers (they subscribe with useSettingsVersion).
export function setSetting(key, value) {
  localStorage.setItem(key, String(value));
  try { window.dispatchEvent(new CustomEvent('os-settings', { detail: { key } })); } catch { /* old browsers */ }
}

// Snapshot of every registered setting (for env export).
export function getAllSettings() {
  return Object.fromEntries(SETTINGS.map(s => [s.key, getSetting(s.key)]));
}

// Re-render trigger: bump this in any component that renders setting-dependent
// values (dashboard number formats, etc.).
export function useSettingsVersion() {
  const [v, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV(x => x + 1);
    window.addEventListener('os-settings', bump);
    return () => window.removeEventListener('os-settings', bump);
  }, []);
  return v;
}
