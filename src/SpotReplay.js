// src/SpotReplay.js
//
// Spot Replay — the dynamic, interactive version of the static options
// analysis reports (files/crwd_analysis_report.html). Enter a position once
// (paste block or form), and an agent pipeline runs on the backend:
//
//   parse → OHLCV (yfinance/Alpaca) → DuckDuckGo research → 8-stage quant
//   models → LLM narrative + self-critique → optional VLM chart read
//
// …and this page re-renders the full report live from the streamed result.
// Settings come from the shared useProviderSettings('spot') hook: API keys are
// shared with the chat assistant; provider/model/timeout are namespaced.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAssistantContext } from './components/chatbot/assistantContext';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import TradingNotes from './tradingnotes';

import { C, styles, fmtMoney, fmtNum, fmtPct } from './components/spotreplay/reportTheme';
import CandleChart from './components/spotreplay/CandleChart';
import MCHistogram from './components/spotreplay/MCHistogram';
import { RegimeTable, ModelTable, DecisionMatrix } from './components/spotreplay/SpotTables';
import SettingsDrawer from './components/spotreplay/SettingsDrawer';
import { TargetIcon, GearIcon } from './components/icons';
import { useProviderSettings } from './components/settings/useProviderSettings';
import { API_BASE } from './apiBase';

const MARKDOWN_PLUGINS = { remarkPlugins: [remarkGfm, remarkMath], rehypePlugins: [rehypeKatex] };

const EMPTY_FORM = {
  ticker: '', option_type: 'Put', strike: '', expiry: '',
  purchase_date: '', avg_cost: '', contracts: '1', current_option_price: '',
};

// A ready-to-run example position so a first-time user can hit
// "Run Analysis" without knowing the form. Dates are computed relative to
// today (expiry ~5 weeks out, purchased ~2 weeks ago) so the example never
// goes stale.
const exampleForm = () => {
  const iso = d => d.toISOString().slice(0, 10);
  const now = new Date();
  const expiry = new Date(now);   expiry.setDate(now.getDate() + 35);
  const purchase = new Date(now); purchase.setDate(now.getDate() - 14);
  return {
    ...EMPTY_FORM,
    ticker: 'SPY', option_type: 'Put', strike: '600',
    expiry: iso(expiry), purchase_date: iso(purchase),
    avg_cost: '4.20', current_option_price: '3.85',
  };
};

const FORM_KEY = 'spot_form';

// Canonical paste-block rendering of the example position — same source as
// the form prefill, so "copy → edit → Parse & prefill" always round-trips.
const examplePasteText = () => {
  const f = exampleForm();
  return [
    `Ticker: ${f.ticker}`,
    `Option: ${f.option_type}`,
    `Strike: $${f.strike}`,
    `Expiry: ${f.expiry}`,
    `Average cost: $${f.avg_cost}`,
    `Contracts: ${f.contracts}`,
    `Current option price: $${f.current_option_price}`,
  ].join('\n');
};

const FORM_PLACEHOLDERS = {
  ticker: 'SPY', strike: 'e.g. 600', avg_cost: 'e.g. 4.20',
  contracts: '1', current_option_price: 'e.g. 3.85',
};

// Remember the user's last inputs; fall back to the example on first visit
// (or if what was saved is unusable).
function loadInitialForm() {
  try {
    const saved = JSON.parse(localStorage.getItem(FORM_KEY) || 'null');
    if (saved && typeof saved === 'object' && saved.ticker) {
      return { ...exampleForm(), ...saved };
    }
  } catch { /* corrupted save — just use the example */ }
  return exampleForm();
}

export default function SpotReplay({ onBack, registry, chatOpen = false }) {
  const s = useProviderSettings('spot');

  // Keep the page header clear of the assistant: the floating toggle sits at
  // top-right when the sidebar is closed; when open, the sidebar itself
  // covers that strip — so the gear shifts left of whichever is present.
  // (Sidebar width is user-resizable and persisted by Chatbot.)
  const headerClearance = chatOpen
    ? (parseInt(localStorage.getItem('chat_sidebarWidth'), 10) || 380) + 24
    : 72;

  // ── input state ────────────────────────────────────────────────────────────
  const [form, setForm] = useState(loadInitialForm);
  const [pasteText, setPasteText] = useState(examplePasteText);
  const [imageData, setImageData] = useState(null); // optional VLM chart screenshot (dataURL)
  const [enableResearch, setEnableResearch] = useState(() => localStorage.getItem('research_default') !== 'false');
  const [showSettings, setShowSettings] = useState(false);

  // ── run state ──────────────────────────────────────────────────────────────
  const [isRunning, setIsRunning] = useState(false);
  const [activity, setActivity] = useState([]); // [{stage, message}] agent log
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);   // full analysis payload

  const activityRef = useRef([]);
  const pushActivity = useCallback((stage, message) => {
    activityRef.current = [...activityRef.current.slice(-120), { stage, message, at: Date.now() }];
    setActivity(activityRef.current);
  }, []);

  const setField = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  // Persist every edit so returning users pick up where they left off.
  useEffect(() => { localStorage.setItem(FORM_KEY, JSON.stringify(form)); }, [form]);

  // Prefill the structured form from a pasted markdown-ish position block.
  const parsePasteBlock = async () => {
    setError('');
    try {
      const r = await fetch(`${API_BASE}/api/spot-replay/parse`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: pasteText }),
      });
      const data = await r.json();
      if (data.position && Object.keys(data.position).length) {
        setForm(prev => ({
          ...prev,
          ...data.position,
          contracts: String(data.position.contracts ?? prev.contracts),
        }));
        if (!data.ok) setError(`Missing fields: ${data.missing.join(', ')}`);
      } else {
        setError('Could not find any position fields in that text.');
      }
    } catch (e) {
      setError(`Parse failed — is the backend running? (${e.message})`);
    }
  };

  // Optional chart screenshot for the vision model.
  const onImagePick = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImageData(reader.result);
    reader.readAsDataURL(file);
  };

  // ── run the agent pipeline over SSE ────────────────────────────────────────
  const runAnalysis = async () => {
    setError('');
    setIsRunning(true);
    setResult(null);
    activityRef.current = [];
    setActivity([]);

    const body = {
      ticker: form.ticker.trim().toUpperCase(),
      option_type: form.option_type,
      strike: parseFloat(form.strike),
      expiry: form.expiry,
      purchase_date: form.purchase_date || undefined,
      avg_cost: parseFloat(form.avg_cost),
      contracts: parseInt(form.contracts || '1', 10),
      current_option_price: parseFloat(form.current_option_price),
      enable_research: enableResearch,
      image: imageData || undefined,
      // LLM/VLM connectivity — same shape the chat assistant sends.
      ...(s.provider ? { provider: s.provider } : {}),
      ...(s.provider === 'custom'
        ? { base_url: s.customBaseUrl, model: s.customModel }
        : { model: s.model || undefined }),
      ...(s.apiKeys[s.provider] ? { api_key: s.apiKeys[s.provider] } : {}),
      timeout: s.timeoutSec,
    };

    try {
      const resp = await fetch(`${API_BASE}/api/spot-replay/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop(); // partial event carried to next read

        for (const raw of events) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }

          if (evt.type === 'stage') {
            pushActivity(evt.stage, evt.message);
          } else if (evt.type === 'parsed') {
            pushActivity('parse', `Position parsed: ${evt.position.ticker} ${fmtMoney(evt.position.strike, 0)} ${evt.position.option_type}, expires ${evt.position.expiry}`);
          } else if (evt.type === 'result') {
            setResult(evt);
          } else if (evt.type === 'error') {
            setError(evt.message);
          }
        }
      }
    } catch (e) {
      setError(`Analysis failed — is the backend running? (${e.message})`);
    } finally {
      setIsRunning(false);
    }
  };

  const inputStyle = {
    padding: '6px 8px', border: `1px solid ${C.baseline}`, borderRadius: 6,
    fontSize: 13, background: 'var(--os-surface)', color: C.text, boxSizing: 'border-box',
  };
  const labelStyle = { fontSize: 11.5, color: C.textSecondary, marginBottom: 3, fontWeight: 600, display: 'block' };

  const a = result?.analysis;

  // ── assistant context: position + verdict when asked from this page ───────
  const pageRef = useRef(null);
  useAssistantContext(registry, {
    id: 'spot-replay',
    title: 'Spot Replay',
    getContext: () => {
      const pos = a?.position;
      const dec = a?.decision;
      return {
        inputs: { ...form },
        hasChartScreenshot: !!imageData,
        researchEnabled: enableResearch,
        runState: isRunning ? 'running' : (result ? 'complete' : 'idle'),
        verdict: pos && dec ? {
          ticker: pos.ticker, optionType: pos.option_type, strike: pos.strike, expiry: pos.expiry,
          currentPrice: a.market?.current_price,
          probITMpct: a.monte_carlo?.ensemble_prob_itm_pct,
          probProfitPct: a.monte_carlo?.prob_profit_pct,
          evHold: dec.ev_hold, evSell: dec.ev_sell,
          kellyFraction: dec.kelly_fraction,
          recommendation: dec.recommendation,
          models: {
            gradientBoosting: a.ml?.GradientBoosting?.final_price,
            randomForest: a.ml?.RandomForest?.final_price,
            arima: a.arima?.forecast?.[a.arima.forecast.length - 1],
          },
          researchSourceCount: result?.research?.length ?? null,
        } : null,
        note: 'verdict is the live Spot Replay analysis; null means no run yet. '
            + 'EVs are per-contract dollar expectations for hold vs sell now.',
      };
    },
    targetRef: pageRef,
  });

  return (
    <div ref={pageRef} style={{ background: C.bg, minHeight: '100vh', padding: '18px 22px', fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' }}>
      {/* ── header ──────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, paddingRight: headerClearance }}>
        <button onClick={onBack} aria-label="Back to dashboard" style={{
          background: 'var(--os-surface)', border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '7px 14px', cursor: 'pointer', fontSize: 13, color: C.textSecondary,
        }}>← Back</button>
        <h1 style={{ margin: 0, fontSize: 21, fontWeight: 800, color: C.text, display: 'flex', alignItems: 'center', gap: 8 }}>
          <TargetIcon size={19} /> Spot Replay <span style={{ fontSize: 12.5, fontWeight: 400, color: C.textMuted }}>/ dynamic options edge analyzer</span>
        </h1>
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowSettings(true)} aria-label="Open settings" title="Settings" style={{
          background: 'var(--os-surface)', border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '7px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center',
          color: 'var(--os-text)',
        }}><GearIcon size={16} /></button>
      </div>

      {/* ── input panel ────────────────────────────────────────────────────── */}
      <div style={{ ...styles.card, display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        <div>
          <div style={labelStyle}>Position — paste block or fill the form</div>
          <textarea
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            placeholder={'Ticker: CRWD\nOption: Put\nStrike: $190\nExpiry: 2026-08-21\nAverage cost: $0.69\nContracts: 1\nCurrent option price: $0.57'}
            rows={5}
            aria-label="Position paste block"
            style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}
          />
          <button onClick={parsePasteBlock} disabled={!pasteText.trim() || isRunning}
                  style={{ marginTop: 6, padding: '6px 12px', borderRadius: 6, border: `1px solid ${C.border}`,
                           background: 'var(--os-bg)', color: 'var(--os-text)', cursor: 'pointer', fontSize: 12.5 }}>
            Parse & prefill ↓
          </button>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 10 }}>
            {[
              ['ticker', 'Ticker'], ['option_type', 'Option'],
              ['strike', 'Strike'], ['expiry', 'Expiry'],
              ['purchase_date', 'Purchase date'], ['avg_cost', 'Avg cost ($)'],
              ['contracts', 'Contracts'], ['current_option_price', 'Current opt. price ($)'],
            ].map(([key, label]) => (
              <div key={key}>
                <span style={labelStyle}>{label}</span>
                {key === 'option_type' ? (
                  <select value={form[key]} onChange={e => setField(key, e.target.value)}
                          style={{ ...inputStyle, width: '100%' }} aria-label={label}>
                    <option value="Put">Put</option>
                    <option value="Call">Call</option>
                  </select>
                ) : (
                  <input type={key.includes('date') ? 'date' : 'text'} value={form[key] ?? ''}
                         onChange={e => setField(key, e.target.value)}
                         placeholder={FORM_PLACEHOLDERS[key] || ''}
                         style={{ ...inputStyle, width: '100%' }} aria-label={label} />
                )}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderLeft: `1px solid ${C.gridline}`, paddingLeft: 16 }}>
          <div>
            <span style={labelStyle}>Chart screenshot (optional — read by the vision model)</span>
            <input type="file" accept="image/*" onChange={onImagePick} aria-label="Attach chart screenshot"
                   style={{ fontSize: 11.5 }} />
            {imageData && (
              <button onClick={() => setImageData(null)} style={{
                marginLeft: 8, fontSize: 11, border: 'none', background: 'none',
                color: C.critical, cursor: 'pointer',
              }}>remove</button>
            )}
          </div>
          <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={enableResearch}
                   onChange={e => setEnableResearch(e.target.checked)}
                   aria-label="Run web research during analysis" />
            Web research (DuckDuckGo)
          </label>
          <div style={{ fontSize: 11, color: C.textMuted }}>
            LLM: {s.provider ? `${s.provider}${s.effectiveModel ? ` · ${s.effectiveModel}` : ''}` : 'not selected — tables only'}
          </div>
          <button onClick={runAnalysis} disabled={isRunning}
                  style={{
                    marginTop: 'auto', padding: '11px 16px', borderRadius: 8, border: 'none',
                    background: isRunning ? '#9fb8d6' : C.blue, color: '#fff',
                    fontSize: 14.5, fontWeight: 700, cursor: isRunning ? 'default' : 'pointer',
                  }}
                  aria-label="Run analysis">
            {isRunning ? '⏳ Agent working…' : '▶ Run Analysis'}
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" style={{
          background: 'rgba(227,73,72,0.09)', border: `1px solid ${C.red}`, borderRadius: 8,
          padding: '9px 12px', marginBottom: 12, color: C.critical, fontSize: 13,
        }}>{error}</div>
      )}

      {/* ── agent activity log ─────────────────────────────────────────────── */}
      {(isRunning || activity.length > 0) && (
        <div style={{ ...styles.card, maxHeight: 170, overflowY: 'auto' }} aria-live="polite">
          <div style={styles.sectionTitle}>Agent Activity</div>
          {activity.map((ev, i) => (
            <div key={i} style={{ fontSize: 12, fontFamily: 'ui-monospace, Consolas, monospace', color: C.textSecondary, marginBottom: 3 }}>
              <span style={{ color: C.blue, fontWeight: 700 }}>[{ev.stage}]</span> {ev.message}
            </div>
          ))}
          {isRunning && <span className="typing-dots" style={{ color: C.textMuted, fontSize: 12 }}>●●●</span>}
        </div>
      )}

      {/* ── report ─────────────────────────────────────────────────────────── */}
      {!a ? (
        !isRunning && !activity.length && (
          <div style={{ ...styles.card, textAlign: 'center', color: C.textMuted, padding: '42px 16px', fontSize: 14 }}>
            Enter a position above and hit <strong>Run Analysis</strong> — the agent fetches data,
            researches catalysts, runs the quant models, and renders the report here.
          </div>
        )
      ) : (
        <>
          {/* summary card + verdict badge */}
          <div style={{ ...styles.card, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
            <div style={{ fontSize: 20, fontWeight: 800 }}>
              {a.position.ticker} {' '}
              <span style={{ color: a.position.option_type === 'Put' ? C.red : C.good }}>
                ${a.position.strike.toFixed(0)} {a.position.option_type.toUpperCase()}
              </span>{' '}
              · exp {a.position.expiry}
              {a.position.expired && (
                <span style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 700, color: C.orange,
                               border: `1px solid ${C.orange}`, borderRadius: 10, padding: '2px 8px' }}>
                  EXPIRED — repricing post-mortem only
                </span>
              )}
            </div>
            <div style={{ fontSize: 13.5, color: C.textSecondary }}>
              Underlying {fmtMoney(a.market.current_price)} ({a.market.as_of}, via {result.data_provider}){' '}
              · strike {fmtMoney(a.market.distance_to_strike)} away ({fmtNum(a.market.distance_in_atr)} ATR)
            </div>
            <div style={{ flex: 1 }} />
            <div style={{
              fontSize: 17, fontWeight: 800, letterSpacing: 1, color: '#fff',
              background: a.decision.recommendation === 'HOLD' ? C.good : C.critical,
              borderRadius: 10, padding: '7px 18px',
            }}>
              {a.decision.recommendation}
            </div>
          </div>

          {/* stat tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 14 }}>
            {[
              ['P(ITM)', fmtPct(a.monte_carlo.ensemble_prob_itm_pct), C.blue],
              ['P(profit)', fmtPct(a.monte_carlo.prob_profit_pct), C.text],
              ['EV hold', fmtMoney(a.decision.ev_hold, 0), a.decision.ev_hold >= a.decision.ev_sell ? C.good : C.critical],
              ['EV sell now', fmtMoney(a.decision.ev_sell, 0), C.textSecondary],
              ['Kelly', a.decision.kelly_fraction == null ? '—' : fmtPct(a.decision.kelly_fraction * 100),
               a.decision.kelly_fraction != null && a.decision.kelly_fraction > 0 ? C.good : C.critical],
              ['RSI / ATR%', `${fmtNum(a.market.rsi)} / ${fmtNum(a.market.atr_pct_of_price)}%`, C.text],
            ].map(([label, value, color]) => (
              <div key={label} style={{
                background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                borderLeft: `4px solid ${color}`, padding: '10px 13px',
              }}>
                <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5,
                              color: C.textMuted, fontWeight: 600 }}>{label}</div>
                <div style={{ fontSize: 19, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
              </div>
            ))}
          </div>

          {/* price chart + MC distribution */}
          <div style={styles.card}>
            <div style={styles.sectionTitle}>Price History &amp; Model Forecasts (last 60 days)</div>
            <CandleChart analysis={a} />
          </div>
          <div style={styles.card}>
            <div style={styles.sectionTitle}>Monte Carlo Distribution — Blended Ensemble</div>
            <MCHistogram analysis={a} />
          </div>

          <RegimeTable analysis={a} />
          <ModelTable analysis={a} />
          <DecisionMatrix analysis={a} />

          {/* research findings */}
          {result.research.length > 0 && (
            <div style={styles.card}>
              <div style={styles.sectionTitle}>Key Catalysts &amp; Research ({result.research.length} sources)</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                {result.research.map((f, i) => f.error ? null : (
                  <a key={i} href={f.url} target="_blank" rel="noreferrer" style={{
                    textDecoration: 'none', border: `1px solid ${C.gridline}`, borderRadius: 8,
                    padding: '8px 10px', display: 'block', background: 'var(--os-surface)',
                  }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>{f.title}</div>
                    <div style={{ fontSize: 11.5, color: C.textSecondary, marginTop: 2 }}>
                      {f.snippet?.slice(0, 140)}…
                    </div>
                    <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{f.query}</div>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* analyst narrative */}
          {result.narrative?.content && (
            <div style={styles.card}>
              <div style={styles.sectionTitle}>Analyst Narrative &amp; Self-Check</div>
              <div className="markdown-body" style={{ fontSize: 13.5, lineHeight: 1.55, color: C.text }}>
                <ReactMarkdown {...MARKDOWN_PLUGINS}>{result.narrative.content}</ReactMarkdown>
              </div>
            </div>
          )}

          {/* console summary + disclaimer footer */}
          <pre style={{
            background: '#101418', color: '#cfe3cf', borderRadius: 10, padding: '13px 16px',
            fontSize: 12.5, overflowX: 'auto',
          }}>{result.summary}</pre>
          <div style={{ textAlign: 'center', fontSize: 11, color: C.textMuted, margin: '4px 0 30px' }}>
            Quantitative analysis, not financial advice · generated {a.generated_at}
          </div>
        </>
      )}

      {/* how-to notes — same shared strip as Trade Replay */}
      <TradingNotes />

      <SettingsDrawer open={showSettings} onClose={() => setShowSettings(false)} s={s} />
    </div>
  );
}
