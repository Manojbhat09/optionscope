import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

// Settings → Preferences → "Use defaults from env file": before first render,
// pull the OS_* section of backend/.env and seed any localStorage key that has
// no value yet (env provides DEFAULTS — explicit in-app choices still win).
// Kept on a short timeout so a cold/slow backend can never block startup.
async function seedFromEnv() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${window.location.origin}/api/app-settings/env`, { signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json();
    if (!data.seed || !data.values) return;
    Object.entries(data.values).forEach(([k, v]) => {
      if (!k.startsWith('OS_LS_')) return;         // OS_LS_<localStorageKey>
      const key = k.slice(6);
      if (localStorage.getItem(key) === null && v !== '') localStorage.setItem(key, v);
    });
  } catch { /* backend not reachable yet — plain start */ }
}

const root = ReactDOM.createRoot(document.getElementById('root'));
seedFromEnv().finally(() => {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
reportWebVitals();
