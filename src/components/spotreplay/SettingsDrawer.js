// src/components/spotreplay/SettingsDrawer.js
//
// Right-side settings drawer for Spot Replay, built on the SHARED
// useProviderSettings('spot') hook: same provider API keys as the chat
// assistant (shared singletons), but its own selected provider/model/timeout
// (namespaced preferences). Mirrors the assistant sidebar's drawer UX.

import React, { useState } from 'react';
import { PROVIDERS, DYNAMIC_MODEL_PROVIDERS, labelizeModelId } from '../settings/useProviderSettings';
import { GearIcon, CloseIcon, KeyIcon } from '../icons';

export default function SettingsDrawer({ open, onClose, s }) {
  const [keyVisibility, setKeyVisibility] = useState({});

  if (!open) return null;

  const inputStyle = {
    width: '100%', padding: '5px 7px', border: '1px solid var(--os-border)', borderRadius: 4,
    fontSize: 12, boxSizing: 'border-box', background: 'var(--os-bg)', color: 'var(--os-text)',
  };

  return (
    <>
      {/* click-away backdrop */}
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 998,
      }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, height: '100vh', width: 360,
        background: 'var(--os-surface)', color: 'var(--os-text)', boxShadow: '-4px 0 20px rgba(0,0,0,0.25)',
        zIndex: 999, padding: '16px', overflowY: 'auto', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', gap: 10,
      }} aria-label="Spot Replay settings">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ display: 'flex', alignItems: 'center', gap: 7 }}><GearIcon size={15} /> Spot Replay Settings</strong>
          <button onClick={onClose} aria-label="Close settings"
                  style={{ border: 'none', background: 'none', cursor: 'pointer', display: 'flex', padding: 4 }}>
            <CloseIcon size={16} />
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--os-text-2)' }}>
          API keys are shared with the chat assistant. Provider/model choices here are
          independent of the assistant's.
        </div>

        {/* provider */}
        <label style={{ fontSize: 12, fontWeight: 600 }}>LLM provider</label>
        <select value={s.provider} onChange={e => {
          s.setProvider(e.target.value);
          // Reset model to the first option of the new provider's catalog.
          s.setModel('');
        }} style={inputStyle} aria-label="AI provider">
          <option value="">— select —</option>
          {PROVIDERS.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>

        {/* model — free text for custom endpoints, catalog otherwise */}
        {s.provider === 'custom' ? (
          <>
            <label style={{ fontSize: 12, fontWeight: 600 }}>Custom endpoint</label>
            <input type="text" value={s.customBaseUrl}
                   onChange={e => s.setCustomBaseUrl(e.target.value)}
                   placeholder="http://localhost:11434/v1" style={{ ...inputStyle, marginBottom: 6 }}
                   aria-label="Custom endpoint base URL" />
            <input type="text" value={s.customModel}
                   onChange={e => s.setCustomModel(e.target.value)}
                   placeholder="model name (e.g. llama3.2)" style={inputStyle}
                   aria-label="Custom endpoint model name" />
          </>
        ) : (
          <>
            <label style={{ fontSize: 12, fontWeight: 600 }}>Model</label>
            {DYNAMIC_MODEL_PROVIDERS.includes(s.provider) && s.dynamicModels[s.provider]?.length > 0 ? (
              <select value={s.model} onChange={e => s.setModel(e.target.value)}
                      style={inputStyle} aria-label="AI model">
                <option value="">— select —</option>
                {s.dynamicModels[s.provider].map(m => (
                  <option key={m.id} value={m.id}>
                    {m.label || labelizeModelId(m.id)}{m.vision ? ' (vision)' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input type="text" value={s.model} onChange={e => s.setModel(e.target.value)}
                     placeholder="model id (e.g. deepseek/deepseek-v4-flash)"
                     style={inputStyle} aria-label="Model id" />
            )}
          </>
        )}

        {/* timeout */}
        <label style={{ fontSize: 12, fontWeight: 600 }}>Timeout (seconds)</label>
        <input type="number" min="5" max="600" step="5" value={s.timeoutSec}
               onChange={e => {
                 const v = parseInt(e.target.value, 10);
                 s.setTimeoutSec(Number.isFinite(v) ? Math.min(600, Math.max(5, v)) : 120);
               }}
               style={{ ...inputStyle, width: 90 }} aria-label="Response timeout in seconds" />

        {/* shared API keys */}
        <div style={{ fontWeight: 700, fontSize: 12, marginTop: 4, color: '#1565c0' }}><KeyIcon size={12} /> API Keys (shared with assistant)</div>
        {PROVIDERS.map(({ id, label, placeholder }) => (
          <div key={id} style={{ marginBottom: 6 }}>
            <label style={{ display: 'block', marginBottom: 2, fontSize: 11.5 }}>{label}</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                type={keyVisibility[id] ? 'text' : 'password'}
                value={s.apiKeys[id] || ''}
                onChange={e => s.setApiKey(id, e.target.value.trim())}
                placeholder={placeholder}
                aria-label={`${id} API key`}
                style={inputStyle}
              />
              <button onClick={() => setKeyVisibility(v => ({ ...v, [id]: !v[id] }))}
                      aria-label={`Toggle ${id} key visibility`} title="Show/hide"
                      style={{ border: '1px solid var(--os-border)', background: 'var(--os-bg)', color: 'var(--os-text)', borderRadius: 4,
                               cursor: 'pointer', fontSize: 11, padding: '0 8px' }}>
                {keyVisibility[id] ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
        ))}

        <div style={{ fontSize: 10, color: 'var(--os-text-3)', marginTop: 2 }}>
          Keys are stored in your browser only and sent directly to your chosen provider.
        </div>
      </div>
    </>
  );
}
