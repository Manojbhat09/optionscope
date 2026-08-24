// src/osTheme.js
//
// Global day/night theme (files/desktop-app-design.md §1 companion).
// One <html data-theme> attribute drives every CSS variable in index.css;
// MUI palettes are rebuilt from the same value in OptionsAnalysisApp.
// Toggling also syncs the assistant sidebar's own dark-mode flag so the
// two surfaces never disagree.
//
// Modes: 'light' | 'dark' | 'auto'. Auto resolves by local clock —
// night theme from 19:00 through 06:59 — re-checked every minute so
// the switch happens hands-free while the app stays open.

import { useCallback, useEffect, useState } from 'react';

const KEY = 'os_theme';

// The auto window: evening/night hours use the dark theme.
export function autoResolved() {
  const h = new Date().getHours();
  return h >= 19 || h < 7 ? 'dark' : 'light';
}

function initialSaved() {
  const saved = localStorage.getItem(KEY);
  if (saved === 'dark' || saved === 'light' || saved === 'auto') return saved;
  // First visit: follow the OS preference
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(m) {
  document.documentElement.dataset.theme = m;
  // keep the assistant sidebar in agreement (it reads this key itself)
  localStorage.setItem('chat_darkMode', String(m === 'dark'));
}

export function useOsTheme() {
  const [saved, setSaved] = useState(initialSaved);
  const [resolved, setResolved] = useState(() => (saved === 'auto' ? autoResolved() : saved));

  useEffect(() => {
    localStorage.setItem(KEY, saved);
    if (saved !== 'auto') {
      apply(saved);
      setResolved(saved);
      return undefined;
    }
    const tick = () => {
      const r = autoResolved();
      apply(r);
      setResolved(r);
    };
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, [saved]);

  // Header button cycles: light → dark → auto → light …
  const toggle = useCallback(
    () => setSaved(s => (s === 'light' ? 'dark' : s === 'dark' ? 'auto' : 'light')),
    []
  );

  return { mode: resolved, saved, toggle, setMode: setSaved };
}
