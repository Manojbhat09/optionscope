// src/components/settings/useProviderSettings.js
//
// Shared settings infrastructure for every LLM-powered surface in the app
// (currently: the chat assistant sidebar and the Spot Replay dashboard).
//
// Contract (see files/spot-replay-design.md):
//   CREDENTIALS ARE GLOBAL SINGLETONS — the same provider API keys serve both
//   surfaces, stored once under `provider_key_<id>` (canonical) with automatic
//   seeding from the assistant's legacy `chat_key_<id>` keys on first read.
//   Writes go to BOTH locations while Chatbot.js still reads the legacy names,
//   so entering a key in either surface instantly appears in the other.
//
//   PREFERENCES ARE NAMESPACED PER SURFACE — which provider/model is selected,
//   timeout, etc. live under `<namespace>_*` keys, because the right model for
//   a quick chat question isn't necessarily the right one for a deep spot
//   analysis run.
//
// Usage:
//   const s = useProviderSettings('spot');
//   s.provider, s.setProvider('inferx'), s.model, s.apiKeys.inferx,
//   s.setApiKey('inferx', 'ix_...'), s.dynamicModels.inferx, ...
//
import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '../../apiBase';

export const PROVIDERS = [
  { id: 'anthropic', label: 'Claude (Anthropic)', placeholder: 'sk-ant-...' },
  { id: 'openai', label: 'OpenAI (GPT-4o)', placeholder: 'sk-...' },
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-...' },
  { id: 'inferx', label: 'InferX', placeholder: 'ix_...' },
  { id: 'zai', label: 'Z.ai (coding plan)', placeholder: 'API key…' },
  { id: 'commandcode', label: 'CommandCode (Provider plan+)', placeholder: 'user_…' },
  { id: 'custom', label: 'Custom / Local (optional)', placeholder: 'leave blank if none required' },
];

// Providers whose dropdowns are populated live from the backend's generic
// /api/chat/models endpoint (which proxies each provider's own catalog).
export const DYNAMIC_MODEL_PROVIDERS = ['inferx', 'openrouter', 'zai', 'commandcode'];

// ── shared credential storage ────────────────────────────────────────────────

function readSharedKey(id) {
  // Canonical location first; fall back to the assistant's legacy key so
  // existing users see their saved keys without re-entering anything.
  return localStorage.getItem(`provider_key_${id}`)
      || localStorage.getItem(`chat_key_${id}`)
      || '';
}

function writeSharedKey(id, value) {
  // Dual-write while Chatbot.js still reads `chat_key_*`: both surfaces stay
  // in sync no matter which one the key was entered in.
  localStorage.setItem(`provider_key_${id}`, value);
  localStorage.setItem(`chat_key_${id}`, value);
}

// Turns a raw model id into a readable dropdown label when the provider's
// catalog has no friendly name — "nemotron-35-lightning" (InferX) or
// "google/gemma-4-26b-a4b-it:free" (OpenRouter, provider/model:variant).
export function labelizeModelId(id) {
  const withoutProvider = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  const free = withoutProvider.endsWith(':free');
  const base = free ? withoutProvider.slice(0, -':free'.length) : withoutProvider;
  const words = base.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return free ? `${words} (Free)` : words;
}

// ── the hook ─────────────────────────────────────────────────────────────────

export function useProviderSettings(namespace, defaults = {}) {
  const {
    defaultTimeoutSec = 120,          // deep analysis runs take longer than chat
    defaultModel = '',
  } = defaults;

  // Namespaced preferences — independent per surface.
  const [provider, setProviderState] = useState(
    () => localStorage.getItem(`${namespace}_provider`) || '');
  const [model, setModelState] = useState(
    () => localStorage.getItem(`${namespace}_model`) || defaultModel);
  const [timeoutSec, setTimeoutSec] = useState(() => {
    const saved = parseInt(localStorage.getItem(`${namespace}_timeout_sec`), 10);
    return Number.isFinite(saved) && saved > 0 ? saved : defaultTimeoutSec;
  });

  // Shared credentials — identical across surfaces by contract.
  const [apiKeys, setApiKeysState] = useState(() =>
    Object.fromEntries(PROVIDERS.map(p => [p.id, readSharedKey(p.id)])));

  const [customBaseUrl, setCustomBaseUrl] = useState(
    () => localStorage.getItem('provider_custom_base_url') || '');
  const [customModel, setCustomModel] = useState(
    () => localStorage.getItem('provider_custom_model') || '');

  // Live model catalogs, fetched per dynamic-catalog provider.
  const [dynamicModels, setDynamicModels] = useState({});

  // ── persistence ────────────────────────────────────────────────────────────
  useEffect(() => { localStorage.setItem(`${namespace}_provider`, provider); }, [namespace, provider]);
  useEffect(() => { localStorage.setItem(`${namespace}_model`, model); }, [namespace, model]);
  useEffect(() => { localStorage.setItem(`${namespace}_timeout_sec`, String(timeoutSec)); }, [namespace, timeoutSec]);
  useEffect(() => { localStorage.setItem('provider_custom_base_url', customBaseUrl); }, [customBaseUrl]);
  useEffect(() => { localStorage.setItem('provider_custom_model', customModel); }, [customModel]);

  const setApiKey = useCallback((id, value) => {
    writeSharedKey(id, value);
    setApiKeysState(prev => ({ ...prev, [id]: value }));
  }, []);

  // Effective model options for a provider: live catalog when present
  // (reflects what the account's key actually unlocks), else static fallback
  // passed by the caller via window-level registry below.
  const modelOptionsFor = useCallback((pid, staticOptions = []) => {
    if (dynamicModels[pid]?.length) return dynamicModels[pid];
    return staticOptions;
  }, [dynamicModels]);

  // Fetch each dynamic provider's catalog once on mount, and refetch whenever
  // that provider's key changes (a different key unlocks different models).
  useEffect(() => {
    DYNAMIC_MODEL_PROVIDERS.forEach(pid => {
      fetch(`${API_BASE}/api/chat/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(apiKeys[pid] ? { provider: pid, api_key: apiKeys[pid] } : { provider: pid }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.models?.length) {
            setDynamicModels(prev => ({
              ...prev,
              // Preserve any caller-supplied friendly labels for known ids;
              // vision-capable entries get a 👁 marker when metadata allows.
              [pid]: data.models.map(({ id, vision }) => ({
                id,
                label: id,
                vision,
              })),
            }));
          }
        })
        .catch(() => {}); // silent — callers pass their own static fallbacks
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, DYNAMIC_MODEL_PROVIDERS.map(pid => apiKeys[pid]));

  return {
    // preferences (namespaced)
    provider, setProvider: setProviderState,
    model, setModel: setModelState,
    timeoutSec, setTimeoutSec,
    // credentials (shared)
    apiKeys, setApiKey,
    customBaseUrl, setCustomBaseUrl,
    customModel, setCustomModel,
    // catalogs
    dynamicModels, modelOptionsFor,
    // effective model sent to the backend: free-text for custom endpoints
    effectiveModel: provider === 'custom' ? customModel : model,
  };
}
