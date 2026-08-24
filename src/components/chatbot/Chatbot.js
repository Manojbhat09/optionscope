// src/components/chatbot/Chatbot.js
import AddIcon from '@mui/icons-material/Add';
import ChatIcon from '@mui/icons-material/Chat';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CloseIcon from '@mui/icons-material/Close';
import HistoryIcon from '@mui/icons-material/History';
import KeyIcon from '@mui/icons-material/Key';
import SettingsIcon from '@mui/icons-material/Settings';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import html2canvas from 'html2canvas';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import './styles.css';
import { API_BASE } from '../../apiBase';
import { SpinnerIcon, SearchIcon, MonitorIcon, AccessibilityIcon, GearIcon, CopyIcon, RefreshIcon } from '../icons';

// GFM adds table/strikethrough/task-list support; math adds LaTeX ($...$ and
// $$...$$) parsing, rendered by rehype-katex. Shared by every ReactMarkdown
// instance in this file (final answer + reasoning trace).
const MARKDOWN_PLUGINS = { remarkPlugins: [remarkGfm, remarkMath], rehypePlugins: [rehypeKatex] };

// Grok-style reasoning trace: while `isThinking`, renders as a short masked
// viewport that auto-scrolls to the newest line (fade top/bottom via CSS
// mask-image in styles.css). Once thinking ends it collapses to just the
// header ("Thought for Xs"). Clicking the header expands it either way —
// mid-stream (keeps auto-scrolling, unmasked) or after completion (static
// full trace).
function ThinkingBlock({ reasoning, isThinking, startedAt, finalElapsed, textColor }) {
  const [expanded, setExpanded] = useState(false);
  const [liveElapsed, setLiveElapsed] = useState(0);
  const viewportRef = useRef(null);

  useEffect(() => {
    if (!isThinking || !startedAt) return undefined;
    const tick = () => setLiveElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [isThinking, startedAt]);

  // Auto-scroll to the newest line: always while thinking (windowed or
  // expanded), and when the user opens the expanded view mid-stream.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    if (isThinking || expanded) {
      el.scrollTop = el.scrollHeight;
    }
  }, [reasoning, isThinking, expanded]);

  if (!reasoning) return null;
  const seconds = isThinking ? liveElapsed : (finalElapsed != null ? finalElapsed : liveElapsed);

  return (
    <div className={`thinking-block${isThinking ? ' is-active' : ' is-done'}${expanded ? ' is-expanded' : ''}`}>
      <button type="button" className="thinking-header" onClick={() => setExpanded(v => !v)}>
        <span className={`thinking-icon${isThinking ? ' spin' : ''}`} aria-hidden="true">{isThinking ? '◐' : '✓'}</span>
        <span className="thinking-label">
          {isThinking ? `Thinking${seconds ? `… ${seconds}s` : '…'}` : `Thought for ${seconds}s`}
        </span>
        <span className={`thinking-chevron${expanded ? ' is-open' : ''}`} aria-hidden="true">›</span>
      </button>
      <div
        ref={viewportRef}
        className={`thinking-viewport${expanded ? ' is-expanded' : ' is-collapsed'}${isThinking ? ' is-live' : ''}`}
      >
        <div className="markdown-body thinking-content" style={{ color: textColor }}>
          <ReactMarkdown {...MARKDOWN_PLUGINS}>{reasoning}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

// Same collapsible-header styling family as ThinkingBlock, one entry per
// web_search tool call: "Searching the web for '<query>'…" while the
// backend's DuckDuckGo lookup is in flight, "Searched the web (N results)"
// once results land — expand to see the titles/links actually used.
function WebSearchBlock({ toolCalls, textColor }) {
  const [expandedIdx, setExpandedIdx] = useState(null);
  if (!toolCalls || toolCalls.length === 0) return null;

  return (
    <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {toolCalls.map((call, i) => {
        const pending = call.results == null;
        const count = Array.isArray(call.results) ? call.results.length : 0;
        const expanded = expandedIdx === i;
        return (
          <div key={i} className={`thinking-block${pending ? ' is-active' : ' is-done'}${expanded ? ' is-expanded' : ''}`}>
            <button type="button" className="thinking-header" onClick={() => setExpandedIdx(expanded ? null : i)}>
              <span className={`thinking-icon${pending ? ' spin' : ''}`} aria-hidden="true" style={{ display: 'inline-flex' }}>
                {pending ? <SpinnerIcon size={13} /> : <SearchIcon size={13} />}
              </span>
              <span className="thinking-label">
                {pending ? `Searching the web for "${call.query}"…` : `Searched the web for "${call.query}" (${count} result${count === 1 ? '' : 's'})`}
              </span>
              <span className={`thinking-chevron${expanded ? ' is-open' : ''}`} aria-hidden="true">›</span>
            </button>
            <div className={`thinking-viewport${expanded ? ' is-expanded' : ' is-collapsed'}`}>
              <div className="thinking-content" style={{ color: textColor, fontSize: 12 }}>
                {(call.results || []).map((r, j) => (
                  <div key={j} style={{ marginBottom: 6 }}>
                    <a href={r.url} target="_blank" rel="noreferrer" style={{ color: 'inherit', fontWeight: 600 }}>{r.title || r.url}</a>
                    {r.snippet && <div style={{ opacity: 0.75 }}>{r.snippet}</div>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const PROVIDER_LABELS = {
  anthropic: 'Claude (Anthropic)',
  openai: 'GPT-4o (OpenAI)',
  openrouter: 'OpenRouter',
  inferx: 'InferX',
  zai: 'Z.ai',
  commandcode: 'CommandCode',
  custom: 'Custom / Local',
};

// Providers with a live /models catalog (see backend's _MODEL_LISTERS) —
// their dropdown is populated dynamically instead of from the static
// MODEL_OPTIONS fallback below, which only exists for when that fetch fails.
const DYNAMIC_MODEL_PROVIDERS = ['inferx', 'openrouter', 'zai', 'commandcode'];

const CHAT_HISTORY_KEY = 'chat_history_v1';
const CHAT_HISTORY_LIMIT = 200; // capped so localStorage can't grow unbounded over a long-lived session

// How many prior turns to feed forward as conversation context. Only final
// answers are sent, never reasoning traces — the default pattern most
// consumer chat UIs use (see task #17 research): reasoning is provider-
// specific and often invalidated by a differently-phrased follow-up, so
// replaying it tends to bias rather than help; the final answer alone is
// what "the assistant already told the user" and is safe to reference.
const MAX_HISTORY_TURNS = 6;

// Builds the {role, content}[] history to send with a request: every prior
// completed turn strictly before `currentQuery`, oldest first, capped to the
// last MAX_HISTORY_TURNS. On a normal send `allMessages` is the pre-update
// state (doesn't contain currentQuery yet) so nothing is cut. On a retry
// `allMessages` still contains the turn being retried, so this walks
// backward to the matching user message and drops everything from there on
// — otherwise the retried question would appear twice (once as history,
// once as the live query).
function buildHistory(allMessages, currentQuery) {
  let cutoff = allMessages.length;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    if (allMessages[i].type === 'user' && allMessages[i].content === currentQuery) {
      cutoff = i;
      break;
    }
  }
  const turns = allMessages.slice(0, cutoff)
    .filter(m => m.content && (m.type === 'user' || (m.type === 'bot' && !m.isError)))
    .map(m => ({ role: m.type === 'user' ? 'user' : 'assistant', content: m.content }));
  return turns.slice(-MAX_HISTORY_TURNS * 2);
}

// Pre-filled (not auto-sent) starting point for the input box — a deep,
// multi-part question that's tedious to type from scratch every time.
const DEFAULT_QUERY = 'What did I do right here? in this period? what were the tickers that I did option '
  + 'trade and when and what time and sell and how much multiplier and how long, assess all of it and '
  + 'tell me what was the strategy here. Deep research';

const MODEL_OPTIONS = {
  anthropic: [
    { id: 'claude-opus-4-8', label: 'Opus 4.8 (Best)' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (Fast)' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5 (Fastest)' },
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o (Vision)' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast)' },
    { id: 'o1-mini', label: 'o1-mini (Reasoning)' },
  ],
  openrouter: [
    { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B (Free, Vision)' },
    { id: 'nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning (Free)' },
  ],
  inferx: [
    { id: 'deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash' },
    { id: 'nemotron-35-lightning', label: 'Nemotron 3.5 Lightning' },
    { id: 'Qwen3.8-27B-FP8', label: 'Qwen 3.8 27B' },
  ],
  zai: [
    { id: 'glm-4.6', label: 'GLM-4.6' },
    { id: 'glm-4.6v', label: 'GLM-4.6V (Vision)', vision: true },
  ],
};

// Turns a raw model id into a readable label when it's not one of the ones
// we already have a nice name for — "nemotron-35-lightning" (InferX) or
// "google/gemma-4-26b-a4b-it:free" (OpenRouter, provider/model:variant).
function labelizeModelId(id) {
  const withoutProvider = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  const free = withoutProvider.endsWith(':free');
  const base = free ? withoutProvider.slice(0, -':free'.length) : withoutProvider;
  const words = base.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return free ? `${words} (Free)` : words;
}

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const FONT_SIZES = { small: '12px', medium: '14px', large: '16px' };

// Controlled by App.js so the sidebar survives page navigation (it is mounted
// ONCE, above the page switch). `open` lives in App for FAB-shift layout;
// everything else — sessions, messages, streaming — is internal.
const Chatbot = ({ open, onOpenChange, registry }) => {
  const [messages, setMessages] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CHAT_HISTORY_KEY) || '[]'); } catch { return []; }
  });
  // ── session FSM state (files/assistant-history-design.md §3) ─────────────
  // view: 'chat' | 'history'. sessionId identifies the active conversation in
  // the server-side JSONL store; '' means "brand new, not yet persisted".
  const [sessionId, setSessionId] = useState(() => localStorage.getItem('chat_session_id') || '');
  const [view, setView] = useState('chat');
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  // Marks how many entries of `messages` are already durably saved to the
  // JSONL store; the auto-save effect appends anything beyond this point that
  // has finished streaming.
  const savedUpToRef = useRef(0);
  const [input, setInput] = useState(DEFAULT_QUERY);
  const [isProcessing, setIsProcessing] = useState(false);

  // Provider / model
  const [providers, setProviders] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedModel, setSelectedModel] = useState('');

  // Custom / local endpoint (Ollama, LM Studio, vLLM, any OpenAI-compatible server)
  const [customBaseUrl, setCustomBaseUrl] = useState(localStorage.getItem('chat_custom_base_url') || '');
  const [customModel, setCustomModel] = useState(localStorage.getItem('chat_custom_model') || '');

  // API key panel
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeys, setApiKeys] = useState({
    anthropic: localStorage.getItem('chat_key_anthropic') || '',
    openai: localStorage.getItem('chat_key_openai') || '',
    openrouter: localStorage.getItem('chat_key_openrouter') || '',
    inferx: localStorage.getItem('chat_key_inferx') || '',
    zai: localStorage.getItem('chat_key_zai') || '',
    commandcode: localStorage.getItem('chat_key_commandcode') || '',
    custom: localStorage.getItem('chat_key_custom') || '',
  });
  const [keyVisibility, setKeyVisibility] = useState({ anthropic: false, openai: false, openrouter: false, inferx: false, zai: false, commandcode: false, custom: false });
  const [dynamicModels, setDynamicModels] = useState({}); // { inferx: [...], openrouter: [...] } — live /models results, once fetched

  const abortControllerRef = useRef(null);

  // Accessibility
  const [fontSize, setFontSize] = useState(localStorage.getItem('chat_fontSize') || 'medium');
  const [darkMode, setDarkMode] = useState(localStorage.getItem('chat_darkMode') === 'true');
  const [sendOnEnter, setSendOnEnter] = useState(localStorage.getItem('chat_sendOnEnter') !== 'false');
  const [includeScreenshot, setIncludeScreenshot] = useState(true);

  // Sidebar width — drag-resizable via the handle on its left edge.
  const SIDEBAR_MIN_WIDTH = 320;
  const SIDEBAR_MAX_WIDTH = 900;
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = parseInt(localStorage.getItem('chat_sidebarWidth'), 10);
    return Number.isFinite(saved) && saved >= SIDEBAR_MIN_WIDTH && saved <= SIDEBAR_MAX_WIDTH ? saved : 380;
  });
  const [isResizing, setIsResizing] = useState(false);
  const resizeStateRef = useRef({ startX: 0, startWidth: 0 });

  // Request behavior
  const [streamingEnabled, setStreamingEnabled] = useState(localStorage.getItem('chat_streaming') !== 'false');
  const [enableWebSearch, setEnableWebSearch] = useState(localStorage.getItem('chat_webSearch') === 'true');
  const [timeoutSec, setTimeoutSec] = useState(() => {
    const saved = parseInt(localStorage.getItem('chat_timeout_sec'), 10);
    return Number.isFinite(saved) && saved > 0 ? saved : 60;
  });

  const chatboxRef = useRef(null);
  const inputRef = useRef(null);

  // Effective model list for a provider — the live /models result when we
  // have one (reflects whatever the account's key actually unlocks, or
  // OpenRouter's full public catalog), else the static fallback above.
  const modelOptionsFor = useCallback((provider) => {
    if (dynamicModels[provider]?.length) return dynamicModels[provider];
    return MODEL_OPTIONS[provider] || [];
  }, [dynamicModels]);

  // ── fetch each dynamic-catalog provider's live model list — re-fetch
  // whenever that provider's own key changes (a different key can unlock a
  // different set of models, e.g. InferX). OpenRouter's catalog is public
  // and doesn't depend on a key at all, so it only needs to fetch once.
  useEffect(() => {
    DYNAMIC_MODEL_PROVIDERS.forEach(provider => {
      fetch(`${API_BASE}/api/chat/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(apiKeys[provider] ? { provider, api_key: apiKeys[provider] } : { provider }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.models && data.models.length) {
            setDynamicModels(prev => ({
              ...prev,
              [provider]: data.models.map(({ id, vision }) => {
                const known = MODEL_OPTIONS[provider]?.find(m => m.id === id);
                const label = known ? known.label : labelizeModelId(id);
                return { id, label: vision ? `${label} (vision)` : label, vision };
              }),
            }));
          }
        })
        .catch(() => {}); // silent — the static MODEL_OPTIONS fallback is already fine
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeys.inferx, apiKeys.openrouter, apiKeys.zai, apiKeys.commandcode]);

  // ── fetch providers from backend ──────────────────────────────────────────
  useEffect(() => {
    fetch(`${API_BASE}/api/chat/providers`)
      .then(r => r.json())
      .then(data => {
        setProviders(data.providers || []);
        const def = data.default || 'anthropic';
        setSelectedProvider(def);
        setSelectedModel(modelOptionsFor(def)[0]?.id || '');
      })
      .catch(() => {
        const fallback = [
          { id: 'anthropic', name: 'Claude (Anthropic)' },
          { id: 'openai', name: 'GPT-4o (OpenAI)' },
          { id: 'openrouter', name: 'Llama (OpenRouter)' },
        ];
        setProviders(fallback);
        setSelectedProvider('anthropic');
        setSelectedModel(MODEL_OPTIONS.anthropic[0].id);
      });
  }, []);

  // ── scroll to bottom on new messages ──────────────────────────────────────
  useEffect(() => {
    if (chatboxRef.current) {
      chatboxRef.current.scrollTop = chatboxRef.current.scrollHeight;
    }
  }, [messages]);

  // ── persist accessibility prefs ───────────────────────────────────────────
  useEffect(() => { localStorage.setItem('chat_fontSize', fontSize); }, [fontSize]);
  useEffect(() => { localStorage.setItem('chat_darkMode', darkMode); }, [darkMode]);
  useEffect(() => { localStorage.setItem('chat_sendOnEnter', sendOnEnter); }, [sendOnEnter]);
  useEffect(() => { localStorage.setItem('chat_custom_base_url', customBaseUrl); }, [customBaseUrl]);
  useEffect(() => { localStorage.setItem('chat_custom_model', customModel); }, [customModel]);
  useEffect(() => { localStorage.setItem('chat_streaming', streamingEnabled); }, [streamingEnabled]);
  useEffect(() => { localStorage.setItem('chat_webSearch', enableWebSearch); }, [enableWebSearch]);
  useEffect(() => { localStorage.setItem('chat_timeout_sec', String(timeoutSec)); }, [timeoutSec]);
  useEffect(() => { localStorage.setItem('chat_sidebarWidth', String(sidebarWidth)); }, [sidebarWidth]);

  // ── sidebar drag-to-resize ────────────────────────────────────────────────
  const handleResizeStart = useCallback((e) => {
    e.preventDefault();
    resizeStateRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    setIsResizing(true);
  }, [sidebarWidth]);

  useEffect(() => {
    if (!isResizing) return undefined;
    const handleMouseMove = (e) => {
      // Sidebar is anchored to the right edge, so dragging left (negative
      // delta) should grow it — width grows as clientX moves left of startX.
      const delta = resizeStateRef.current.startX - e.clientX;
      const next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, resizeStateRef.current.startWidth + delta));
      setSidebarWidth(next);
    };
    const handleMouseUp = () => setIsResizing(false);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [isResizing]);

  // ── persist active conversation across reloads (instant local cache; the
  // JSONL store below is the durable source of truth) ────────────────────────
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(messages.slice(-CHAT_HISTORY_LIMIT)));
    } catch {
      // localStorage full or unavailable — history just won't persist this time
    }
  }, [messages]);
  useEffect(() => {
    if (sessionId) localStorage.setItem('chat_session_id', sessionId);
    else localStorage.removeItem('chat_session_id');
  }, [sessionId]);

  // ── session store helpers (files/assistant-history-design.md §4) ──────────
  // Wire format for the JSONL store: {role, content, ts, page, …}. Message
  // objects carry UI-only flags (streaming/reasoning) that we strip on the
  // way out and rebuild (as nulls) on the way back in.
  const serializeMsg = useCallback((m) => ({
    role: m.type === 'user' ? 'user' : 'assistant',
    content: m.content || '',
    timestamp: m.timestamp,
    page: m.page || null,
    pageTitle: m.pageTitle || null,
    provider: m.provider || null,
    model: m.model || null,
    isError: !!m.isError,
    stopped: !!m.stopped,
  }), []);

  const deserializeMsg = useCallback((m) => ({
    type: m.role === 'user' ? 'user' : 'bot',
    content: m.content || '',
    reasoning: null, toolCalls: null, streaming: false,
    provider: m.provider, model: m.model,
    isError: !!m.isError, stopped: !!m.stopped,
    page: m.page, pageTitle: m.pageTitle,
    timestamp: m.ts, userQuery: m.role === 'user' ? m.content : undefined,
  }), []);

  // Auto-save: whenever `messages` grows past what's already been persisted
  // (and the new entries have finished streaming), append them to the server
  // JSONL. Retry shrinks the array — reset the cursor so nothing is skipped.
  useEffect(() => {
    if (savedUpToRef.current > messages.length) savedUpToRef.current = 0;
    const pending = [];
    for (let i = savedUpToRef.current; i < messages.length; i++) {
      const m = messages[i];
      if (m.type === 'bot' && m.streaming) break; // settle first, then save the pair together
      pending.push(serializeMsg(m));
    }
    if (!pending.length) return;
    const from = savedUpToRef.current;
    savedUpToRef.current += pending.length;
    fetch(`${API_BASE}/api/chat/history/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, messages: pending }),
    }).then(r => r.json())
      .then(data => {
        if (!sessionId && data.session_id) setSessionId(data.session_id);
      })
      .catch(() => {}); // offline / backend down — localStorage cache still holds it
  }, [messages, sessionId, serializeMsg]);

  // ── FSM actions ───────────────────────────────────────────────────────────
  // NEW_CHAT: blank conversation in a fresh session; the old one stays in the
  // JSONL store and remains reachable from History.
  const startNewChat = () => {
    setMessages([]);
    setSessionId('');
    savedUpToRef.current = 0;
    setInput(DEFAULT_QUERY);
    setView('chat');
  };

  // OPEN_HISTORY: fetch the session list fresh every time (cheap, cached).
  const openHistory = () => {
    setSessionsLoading(true);
    fetch(`${API_BASE}/api/chat/history/sessions`)
      .then(r => r.json())
      .then(data => setSessions(data.sessions || []))
      .catch(() => setSessions([]))
      .finally(() => { setSessionsLoading(false); setView('history'); });
  };

  // SELECT_SESSION: load a past conversation into the chat view.
  const selectSession = (sid) => {
    fetch(`${API_BASE}/api/chat/history/sessions/${sid}`)
      .then(r => r.json())
      .then(data => {
        const loaded = (data.messages || []).map(deserializeMsg);
        setMessages(loaded);
        setSessionId(sid);
        savedUpToRef.current = loaded.length;
        setView('chat');
      })
      .catch(() => {});
  };

  const deleteSession = (e, sid) => {
    e.stopPropagation();
    setSessions(prev => prev.filter(s => s.session_id !== sid));
    fetch(`${API_BASE}/api/chat/history/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
  };

  // CLEAR: empty the CURRENT conversation (marker appended to the JSONL so a
  // reload of this session shows empty too). Use ➕ for a brand-new thread.
  const clearChat = () => {
    setMessages([]);
    savedUpToRef.current = 0;
    if (sessionId) {
      fetch(`${API_BASE}/api/chat/history/clear`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      }).catch(() => {});
    }
  };

  // ── keyboard shortcut: Ctrl+/ to open/close ───────────────────────────────
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        handleOpenChange(!openRef.current);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── focus input when opened ───────────────────────────────────────────────
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 300);
  }, [open]);

  // ── save API keys to localStorage ─────────────────────────────────────────
  const saveApiKey = (provider, value) => {
    const updated = { ...apiKeys, [provider]: value };
    setApiKeys(updated);
    localStorage.setItem(`chat_key_${provider}`, value);
  };

  // ── send message ──────────────────────────────────────────────────────────
  const effectiveModel = selectedProvider === 'custom' ? customModel : selectedModel;

  // Shared request body: screenshot + structured context + provider config.
  // Built fresh per call so it always reflects the current dashboard state
  // and current settings (model, timeout, streaming key), not stale closures.
  const buildRequestBody = useCallback(async (query) => {
    const apiKey = apiKeys[selectedProvider];
    let screenshot = null;
    // Screenshot + context come from the ACTIVE page's registry entry — i.e.
    // whatever the user is looking at right now, on any page.
    const entry = registry?.active;
    const target = entry?.target();
    if (includeScreenshot && target) {
      try {
        const canvas = await html2canvas(target);
        screenshot = canvas.toDataURL('image/jpeg', 0.8);
      } catch { /* screenshot is best-effort */ }
    }
    // Structured snapshot of the current page's real numbers (P&L, position,
    // quant verdict…), sent alongside the screenshot so the assistant reasons
    // from data instead of estimating from pixels. Wrapped with page identity
    // so past answers stay interpretable ("which surface was this asked on?").
    const pageContext = entry ? entry.getContext() : null;
    const context = pageContext == null ? null : {
      ...(typeof pageContext === 'object' ? pageContext : { value: pageContext }),
      page: entry.id,
      pageTitle: entry.title(),
    };
    const history = buildHistory(messages, query);
    // Settings → Preferences → assistant defaults (blank/0 = provider default)
    const tempRaw = parseFloat(localStorage.getItem('ai_temperature'));
    const tokRaw = parseInt(localStorage.getItem('ai_max_tokens'), 10);
    return {
      query, screenshot, context, history,
      provider: selectedProvider, model: effectiveModel, timeout: timeoutSec,
      enable_search: enableWebSearch,
      ...(Number.isFinite(tempRaw) ? { temperature: tempRaw } : {}),
      ...(Number.isFinite(tokRaw) && tokRaw > 0 ? { max_tokens: tokRaw } : {}),
      ...(apiKey ? { api_key: apiKey } : {}),
      ...(selectedProvider === 'custom' ? { base_url: customBaseUrl } : {}),
    };
  }, [selectedProvider, effectiveModel, apiKeys, includeScreenshot, registry, customBaseUrl, timeoutSec, messages, enableWebSearch]);

  const sendMessageOnce = useCallback(async (query, controller) => {
    const body = await buildRequestBody(query);
    const response = await fetch(`${API_BASE}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: controller.signal, body: JSON.stringify(body),
    });
    const data = await response.json();
    return {
      content: data.success ? data.response : `Error: ${data.response}`,
      reasoning: data.reasoning || null,
      toolCalls: data.tool_calls || null,
      isError: !data.success,
    };
  }, [buildRequestBody]);

  // Streams SSE events from /api/chat/stream, calling updateMessage(updater)
  // for each content/reasoning delta as it arrives, instead of waiting for
  // one final response.
  const streamMessageInto = useCallback(async (query, controller, updateMessage) => {
    const body = await buildRequestBody(query);
    const response = await fetch(`${API_BASE}/api/chat/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: controller.signal, body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Stream request failed (HTTP ${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamError = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop(); // last piece may be a partial event — carried to the next read

      for (const raw of events) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (evt.type === 'content') {
          updateMessage(m => ({
            ...m, content: m.content + evt.delta,
            reasoningEndedAt: m.reasoning && !m.reasoningEndedAt ? Date.now() : m.reasoningEndedAt,
          }));
        } else if (evt.type === 'reasoning') {
          updateMessage(m => ({ ...m, reasoning: (m.reasoning || '') + evt.delta }));
        } else if (evt.type === 'tool_call') {
          updateMessage(m => ({
            ...m, toolCalls: [...(m.toolCalls || []), { query: evt.args?.query || '', results: null }],
          }));
        } else if (evt.type === 'tool_result') {
          updateMessage(m => {
            const toolCalls = [...(m.toolCalls || [])];
            const lastPending = toolCalls.map(t => t.results).lastIndexOf(null);
            if (lastPending !== -1) toolCalls[lastPending] = { ...toolCalls[lastPending], results: evt.results };
            return { ...m, toolCalls };
          });
        } else if (evt.type === 'error') {
          streamError = evt.message;
        }
      }
    }

    if (streamError) throw new Error(streamError);
  }, [buildRequestBody]);

  const runQuery = async (userMessage, { replaceLast = false, pageInfo = {} } = {}) => {
    setIsProcessing(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Seed the message the response gets written into — empty and growing
    // for streaming, filled in all at once for non-streaming. `streaming`
    // here means "still pending" regardless of transport — it's what drives
    // the inline typing-dots indicator — not literally "uses the streaming
    // API" (that would leave non-streaming replies with no pending state at
    // all, since streamingEnabled would be false from the start).
    setMessages(prev => {
      const base = replaceLast ? prev.slice(0, -1) : prev;
      return [...base, {
        type: 'bot', content: '', reasoning: null, toolCalls: null, provider: selectedProvider, model: effectiveModel,
        timestamp: Date.now(), userQuery: userMessage, streaming: true,
        reasoningStartedAt: Date.now(), reasoningEndedAt: null,
        page: pageInfo.page, pageTitle: pageInfo.pageTitle,
      }];
    });
    const updateMessage = (updater) => {
      setMessages(prev => {
        const next = [...prev];
        next[next.length - 1] = updater(next[next.length - 1]);
        return next;
      });
    };

    try {
      if (streamingEnabled) {
        await streamMessageInto(userMessage, controller, updateMessage);
        updateMessage(m => ({
          ...m, streaming: false,
          reasoningEndedAt: m.reasoning && !m.reasoningEndedAt ? Date.now() : m.reasoningEndedAt,
        }));
      } else {
        const result = await sendMessageOnce(userMessage, controller);
        updateMessage(m => ({
          ...m, content: result.content, reasoning: result.reasoning, toolCalls: result.toolCalls, isError: result.isError, streaming: false,
          reasoningEndedAt: result.reasoning ? Date.now() : m.reasoningEndedAt,
        }));
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        updateMessage(m => ({
          ...m, stopped: true, streaming: false,
          reasoningEndedAt: m.reasoning && !m.reasoningEndedAt ? Date.now() : m.reasoningEndedAt,
        }));
      } else {
        updateMessage(m => ({
          ...m, streaming: false, isError: true,
          content: m.content ? m.content : `Error: ${err.message || 'Connection error — is the backend running?'}`,
          reasoningEndedAt: m.reasoning && !m.reasoningEndedAt ? Date.now() : m.reasoningEndedAt,
        }));
      }
    } finally {
      setIsProcessing(false);
      abortControllerRef.current = null;
    }
  };

  const handleSubmit = async (e) => {
    e?.preventDefault();
    if (!input.trim() || isProcessing) return;
    const userMessage = input.trim();
    setInput('');
    // Snapshot WHERE the question is being asked — stamped on both the user
    // and the answer bubble, and persisted with the JSONL history.
    const entry = registry?.active;
    const pageInfo = entry ? { page: entry.id, pageTitle: entry.title() } : {};
    setMessages(prev => [...prev, { type: 'user', content: userMessage, timestamp: Date.now(), ...pageInfo }]);
    await runQuery(userMessage, { pageInfo });
  };

  const handleStop = () => abortControllerRef.current?.abort();

  const handleRetry = (msg) => {
    if (isProcessing || !msg.userQuery) return;
    runQuery(msg.userQuery, {
      replaceLast: true,
      pageInfo: { page: msg.page, pageTitle: msg.pageTitle },
    });
  };

  const copyMessage = (content) => {
    navigator.clipboard?.writeText(content).catch(() => {});
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && sendOnEnter && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleOpenChange = (value) => {
    onOpenChange?.(value);
  };

  const onProviderChange = (p) => {
    setSelectedProvider(p);
    setSelectedModel(modelOptionsFor(p)[0]?.id || '');
  };

  // ── derived ───────────────────────────────────────────────────────────────
  const bg = darkMode ? '#1a1a2e' : 'white';
  const textColor = darkMode ? '#e0e0e0' : '#333';
  const msgBotBg = darkMode ? '#2d2d44' : 'white';
  const msgBotBorder = darkMode ? '#444' : '#ddd';
  const inputBg = darkMode ? '#2d2d44' : 'white';
  const inputBorder = darkMode ? '#555' : '#ddd';
  const placeholderStyle = darkMode ? { color: '#aaa' } : {};

  return (
    <>
      {/* Toggle button — rendered ONLY while closed. When the sidebar is
          open, ✕ lives in the header toolbar, so nothing floats on top of
          it (the old overlap bug). */}
      {!open && (
        <Tooltip title="Trading Assistant (Ctrl+/)" placement="left">
          <IconButton
            className="chatbot-toggle"
            onClick={() => handleOpenChange(true)}
            aria-label="Open trading assistant"
            style={{
              position: 'fixed', top: '20px', right: '20px',
              zIndex: 1001, backgroundColor: '#1976d2', color: 'white',
            }}
          >
            <ChatIcon />
          </IconButton>
        </Tooltip>
      )}

      {/* Sidebar */}
      <div
        className={`chatbot-sidebar ${open ? 'open' : ''} ${isResizing ? 'is-resizing' : ''}`}
        style={{ background: bg, color: textColor, fontSize: FONT_SIZES[fontSize], width: sidebarWidth }}
        role="dialog"
        aria-label="Trading Assistant"
      >
        <div
          className={`chatbot-resize-handle ${isResizing ? 'is-active' : ''}`}
          onMouseDown={handleResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize assistant sidebar"
          title="Drag to resize"
        />
        {/* Header — uniform icon toolbar: ⚙ settings · 🕘 history · ➕ new ·
            🧹 clear · ✕ close. Even gaps, no absolutely-positioned buttons. */}
        <div className="chatbot-header" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}>Trading Assistant</span>
          <div className="chatbot-toolbar" style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <Tooltip title="API Keys & Settings">
              <IconButton size="small" onClick={() => setShowSettings(s => !s)} aria-label="Settings"
                          style={{ color: 'white', padding: 6 }}>
                {showSettings ? <KeyIcon fontSize="small" /> : <SettingsIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
            <Tooltip title={view === 'history' ? 'Back to chat' : 'Chat history'}>
              <IconButton size="small"
                          onClick={() => (view === 'history' ? setView('chat') : openHistory())}
                          aria-label="Chat history"
                          style={{ color: 'white', padding: 6 }}>
                <HistoryIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="New chat">
              <IconButton size="small" onClick={startNewChat} aria-label="New chat"
                          style={{ color: 'white', padding: 6 }}>
                <AddIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Clear current chat">
              <IconButton size="small" onClick={clearChat} aria-label="Clear current chat"
                          disabled={!messages.length}
                          style={{ color: 'white', padding: 6, opacity: messages.length ? 1 : 0.4 }}>
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Close (Ctrl+/)">
              <IconButton size="small" onClick={() => handleOpenChange(false)} aria-label="Close assistant"
                          style={{ color: 'white', padding: 6 }}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </div>
        </div>

        {/* Settings panel */}
        {showSettings && (
          <div style={{
            padding: '12px', borderBottom: `1px solid ${inputBorder}`,
            background: darkMode ? '#151526' : '#f0f4ff',
            fontSize: '12px', overflowY: 'auto', maxHeight: '280px',
          }}>
            <div style={{ fontWeight: 'bold', marginBottom: '8px', color: '#1976d2', display: 'flex', alignItems: 'center', gap: 6 }}>
              <KeyIcon fontSize="small" /> API Keys (saved locally)
            </div>

            {[
              { id: 'anthropic', label: 'Anthropic (Claude)', placeholder: 'sk-ant-...' },
              { id: 'openai', label: 'OpenAI (GPT-4o)', placeholder: 'sk-...' },
              { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-...' },
              { id: 'inferx', label: 'InferX', placeholder: 'ix_...' },
              { id: 'zai', label: 'Z.ai (coding plan)', placeholder: 'API key…' },
              { id: 'commandcode', label: 'CommandCode (Provider plan+)', placeholder: 'user_…' },
              { id: 'custom', label: 'Custom / Local (optional)', placeholder: 'leave blank if none required' },
            ].map(({ id, label, placeholder }) => (
              <div key={id} style={{ marginBottom: '8px' }}>
                <label style={{ display: 'block', marginBottom: '2px', color: textColor }}>{label}</label>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <input
                    type={keyVisibility[id] ? 'text' : 'password'}
                    value={apiKeys[id]}
                    onChange={e => saveApiKey(id, e.target.value)}
                    placeholder={placeholder}
                    aria-label={`${label} API key`}
                    style={{
                      flex: 1, padding: '4px 6px', border: `1px solid ${inputBorder}`,
                      borderRadius: '4px', fontSize: '11px',
                      background: inputBg, color: textColor,
                    }}
                  />
                  <button
                    onClick={() => setKeyVisibility(v => ({ ...v, [id]: !v[id] }))}
                    style={{
                      padding: '4px 6px', border: `1px solid ${inputBorder}`,
                      borderRadius: '4px', cursor: 'pointer', fontSize: '10px',
                      background: inputBg, color: textColor,
                    }}
                    aria-label={`Toggle ${label} key visibility`}
                  >
                    {keyVisibility[id] ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
            ))}

            <div style={{ fontWeight: 'bold', margin: '10px 0 6px', color: '#1976d2' }}>
              <MonitorIcon size={13} /> Custom / Local Endpoint
            </div>
            <div style={{ fontSize: '10px', color: '#888', marginBottom: '6px' }}>
              Any OpenAI-compatible chat/completions server — Ollama, LM Studio, vLLM, llama.cpp, or a hosted
              provider not listed above. Select "Custom / Local" as the provider below to use it.
            </div>
            <div style={{ marginBottom: '8px' }}>
              <label style={{ display: 'block', marginBottom: '2px', color: textColor }}>Base URL</label>
              <input
                type="text"
                value={customBaseUrl}
                onChange={e => setCustomBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/v1"
                aria-label="Custom endpoint base URL"
                style={{
                  width: '100%', padding: '4px 6px', border: `1px solid ${inputBorder}`,
                  borderRadius: '4px', fontSize: '11px', background: inputBg, color: textColor,
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ marginBottom: '8px' }}>
              <label style={{ display: 'block', marginBottom: '2px', color: textColor }}>Model name</label>
              <input
                type="text"
                value={customModel}
                onChange={e => setCustomModel(e.target.value)}
                placeholder="llama3.2, qwen2.5:0.5b, ..."
                aria-label="Custom endpoint model name"
                style={{
                  width: '100%', padding: '4px 6px', border: `1px solid ${inputBorder}`,
                  borderRadius: '4px', fontSize: '11px', background: inputBg, color: textColor,
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ fontWeight: 'bold', margin: '10px 0 6px', color: '#1976d2' }}>
              <AccessibilityIcon size={13} /> Accessibility
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              <label style={{ color: textColor }}>Font size</label>
              <select
                value={fontSize}
                onChange={e => setFontSize(e.target.value)}
                style={{ padding: '2px', border: `1px solid ${inputBorder}`, borderRadius: '4px', background: inputBg, color: textColor }}
                aria-label="Chat font size"
              >
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>

              <label style={{ color: textColor }}>Dark mode</label>
              <input
                type="checkbox" checked={darkMode}
                onChange={e => setDarkMode(e.target.checked)}
                aria-label="Dark mode"
              />

              <label style={{ color: textColor }}>Enter to send</label>
              <input
                type="checkbox" checked={sendOnEnter}
                onChange={e => setSendOnEnter(e.target.checked)}
                aria-label="Send on Enter key"
              />

              <label style={{ color: textColor }}>Include screenshot</label>
              <input
                type="checkbox" checked={includeScreenshot}
                onChange={e => setIncludeScreenshot(e.target.checked)}
                aria-label="Include dashboard screenshot"
              />
            </div>

            <div style={{ fontWeight: 'bold', margin: '10px 0 6px', color: '#1976d2' }}>
              <GearIcon size={13} /> Request Behavior
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', alignItems: 'center' }}>
              <label style={{ color: textColor }}>Stream response</label>
              <input
                type="checkbox" checked={streamingEnabled}
                onChange={e => setStreamingEnabled(e.target.checked)}
                aria-label="Stream response"
              />

              <label style={{ color: textColor }}>Web search (DuckDuckGo)</label>
              <input
                type="checkbox" checked={enableWebSearch}
                onChange={e => setEnableWebSearch(e.target.checked)}
                aria-label="Let the assistant search the web"
              />

              <label style={{ color: textColor }}>Timeout (seconds)</label>
              <input
                type="number" min="5" max="600" step="5"
                value={timeoutSec}
                onChange={e => {
                  const v = parseInt(e.target.value, 10);
                  setTimeoutSec(Number.isFinite(v) ? Math.min(600, Math.max(5, v)) : 60);
                }}
                aria-label="Response timeout in seconds"
                style={{
                  padding: '3px 6px', border: `1px solid ${inputBorder}`, borderRadius: '4px',
                  background: inputBg, color: textColor, width: '70px',
                }}
              />
            </div>
            <div style={{ fontSize: '10px', color: '#888', marginTop: '4px' }}>
              Slow or local models may need a longer timeout than the 60s default — raise it here if you're
              seeing "unreachable after retries" / read-timeout errors.
            </div>

            <div style={{ marginTop: '8px', fontSize: '10px', color: '#888' }}>
              Keys are stored in your browser only, never sent to our server.
              Keyboard shortcut: Ctrl+/ to open/close.
            </div>
          </div>
        )}

        {/* History view — replaces the message log while browsing past chats.
            Selecting a row loads that conversation (SELECT_SESSION); 🗑
            tombstones it in the JSONL store; the 🕘 header button returns
            to the chat view without changing anything. */}
        {view === 'history' && (
          <div className="chatbot-messages" style={{ background: darkMode ? '#13132a' : '#f5f5f5', padding: 0 }}>
            <div style={{ padding: '10px 14px 6px', fontSize: 12, fontWeight: 600, color: textColor }}>
              Chat history
              <span style={{ display: 'block', fontSize: 10, opacity: 0.55, fontWeight: 400 }}>
                Pick a conversation to continue it · stored server-side
              </span>
            </div>
            {sessionsLoading ? (
              <div style={{ textAlign: 'center', color: '#999', fontSize: 12, marginTop: 20 }}>
                <span className="typing-dots">●●●</span>
              </div>
            ) : sessions.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#999', fontSize: 12, marginTop: 20 }}>
                No saved conversations yet.<br />Your chats are saved here automatically.
              </div>
            ) : sessions.map(s => (
              <button
                key={s.session_id}
                onClick={() => selectSession(s.session_id)}
                className="chat-history-row"
                aria-label={`Open chat: ${s.title}`}
                style={{ color: textColor }}
              >
                <span className="chat-history-title">{s.title}</span>
                <span className="chat-history-meta">
                  {new Date(s.updated_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                  {' · '}{new Date(s.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {' · '}{s.message_count} msg{s.message_count === 1 ? '' : 's'}
                  {s.last_page ? ` · ${s.last_page}` : ''}
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Delete chat: ${s.title}`}
                  onClick={(e) => deleteSession(e, s.session_id)}
                  onKeyDown={(e) => e.key === 'Enter' && deleteSession(e, s.session_id)}
                  className="chat-history-delete"
                >
                  <DeleteOutlineIcon style={{ fontSize: 15 }} />
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Messages */}
        {view === 'chat' && (
        <div
          className="chatbot-messages"
          ref={chatboxRef}
          role="log"
          aria-live="polite"
          aria-label="Chat messages"
          style={{ background: darkMode ? '#13132a' : '#f5f5f5' }}
        >
          {messages.length === 0 && (
            <div style={{ textAlign: 'center', color: '#999', fontSize: '12px', marginTop: '20px' }}>
              Ask anything about what's on screen.<br />
              A screenshot + page context are captured automatically.
            </div>
          )}
          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={`message ${msg.type}`}
              style={msg.type === 'bot' ? {
                background: msgBotBg, border: `1px solid ${msg.isError ? '#e57373' : msgBotBorder}`, color: textColor,
              } : {}}
            >
              {msg.type === 'bot' && msg.model && (
                <div style={{ fontSize: '10px', opacity: 0.55, marginBottom: '3px', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span>
                    {PROVIDER_LABELS[msg.provider]} · {modelOptionsFor(msg.provider)?.find(m => m.id === msg.model)?.label || msg.model}
                    {msg.pageTitle && <> · <b style={{ fontWeight: 600 }}>{msg.pageTitle}</b></>}
                  </span>
                  {msg.timestamp && <span>{fmtTime(msg.timestamp)}</span>}
                </div>
              )}
              {msg.type === 'user' && msg.timestamp && (
                <div style={{ fontSize: '10px', opacity: 0.55, marginBottom: '3px', textAlign: 'right' }}>
                  {fmtTime(msg.timestamp)}
                </div>
              )}
              {msg.type === 'bot' ? (
                <>
                  <WebSearchBlock toolCalls={msg.toolCalls} textColor={textColor} />
                  <ThinkingBlock
                    reasoning={msg.reasoning}
                    isThinking={!!msg.streaming && !msg.reasoningEndedAt}
                    startedAt={msg.reasoningStartedAt}
                    finalElapsed={
                      msg.reasoningEndedAt && msg.reasoningStartedAt
                        ? Math.max(1, Math.round((msg.reasoningEndedAt - msg.reasoningStartedAt) / 1000))
                        : null
                    }
                    textColor={textColor}
                  />
                  {msg.content ? (
                    <div className="markdown-body" style={{ color: textColor }}>
                      <ReactMarkdown {...MARKDOWN_PLUGINS}>{msg.content}</ReactMarkdown>
                    </div>
                  ) : msg.streaming ? (
                    <span className="typing-dots">●●●</span>
                  ) : msg.stopped ? (
                    <span style={{ opacity: 0.7 }}>⏹ Stopped.</span>
                  ) : null}
                  {msg.stopped && msg.content && (
                    <div style={{ fontSize: 10, opacity: 0.5, marginTop: 2 }}>⏹ stopped</div>
                  )}
                </>
              ) : (
                <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
              )}
              {msg.type === 'bot' && !msg.streaming && (msg.content || msg.isError) && (
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  {msg.content && (
                    <button
                      onClick={() => copyMessage(msg.content)}
                      aria-label="Copy response"
                      title="Copy"
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        fontSize: 11, opacity: 0.6, padding: 0, color: textColor,
                      }}
                    >
                      <CopyIcon size={11} /> Copy
                    </button>
                  )}
                  {(msg.isError || msg.stopped) && msg.userQuery && (
                    <button
                      onClick={() => handleRetry(msg)}
                      disabled={isProcessing}
                      aria-label="Retry this question"
                      title="Retry"
                      style={{
                        background: 'none', border: 'none', cursor: isProcessing ? 'default' : 'pointer',
                        fontSize: 11, opacity: 0.6, padding: 0, color: textColor,
                      }}
                    >
                      <RefreshIcon size={11} /> Retry
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        )}

        {/* Model selector toolbar — above text bar */}
        <div style={{
          padding: '8px 12px 4px',
          background: darkMode ? '#1a1a2e' : 'white',
          borderTop: `1px solid ${inputBorder}`,
          display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center',
        }}>
          {/* Provider selector */}
          <select
            value={selectedProvider}
            onChange={e => onProviderChange(e.target.value)}
            disabled={isProcessing}
            aria-label="AI provider"
            style={{
              flex: '1 1 auto', padding: '4px 6px',
              border: `1px solid ${inputBorder}`, borderRadius: '6px',
              fontSize: '12px', background: inputBg, color: textColor, cursor: 'pointer',
            }}
          >
            {providers.map(p => (
              <option key={p.id} value={p.id}>
                {p.name || PROVIDER_LABELS[p.id] || p.id}
              </option>
            ))}
          </select>

          {/* Model selector — free text for "custom" (no fixed catalog for an arbitrary endpoint) */}
          {selectedProvider === 'custom' ? (
            <input
              type="text"
              value={customModel}
              onChange={e => setCustomModel(e.target.value)}
              disabled={isProcessing}
              placeholder="model name (e.g. llama3.2)"
              aria-label="AI model"
              style={{
                flex: '1 1 auto', padding: '4px 6px',
                border: `1px solid ${inputBorder}`, borderRadius: '6px',
                fontSize: '12px', background: inputBg, color: textColor,
              }}
            />
          ) : (
            <select
              value={selectedModel}
              onChange={e => setSelectedModel(e.target.value)}
              disabled={isProcessing}
              aria-label="AI model"
              style={{
                flex: '1 1 auto', padding: '4px 6px',
                border: `1px solid ${inputBorder}`, borderRadius: '6px',
                fontSize: '12px', background: inputBg, color: textColor, cursor: 'pointer',
              }}
            >
              {modelOptionsFor(selectedProvider).map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          )}
        </div>

        {/* Input bar */}
        <form
          onSubmit={handleSubmit}
          className="chatbot-input"
          style={{ background: darkMode ? '#1a1a2e' : 'white', borderTop: `1px solid ${inputBorder}` }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={sendOnEnter ? 'Ask anything… (Enter to send, Shift+Enter for newline)' : 'Ask anything…'}
            disabled={isProcessing}
            rows={2}
            aria-label="Chat input"
            style={{
              flex: 1, padding: '8px 12px', border: `1px solid ${inputBorder}`,
              borderRadius: '12px', resize: 'none', outline: 'none',
              fontFamily: 'inherit', fontSize: 'inherit',
              background: inputBg, color: textColor,
              ...placeholderStyle,
            }}
          />
          {isProcessing ? (
            <button
              type="button"
              onClick={handleStop}
              aria-label="Stop generating"
              title="Stop"
              style={{ alignSelf: 'flex-end', padding: '8px 16px', background: '#e53935', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
            >
              ⏹
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              aria-label="Send message"
              style={{ alignSelf: 'flex-end', padding: '8px 16px' }}
            >
              ↑
            </button>
          )}
        </form>
      </div>
    </>
  );
};

export default Chatbot;
