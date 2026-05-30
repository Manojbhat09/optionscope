// src/components/chatbot/Chatbot.js
import ChatIcon from '@mui/icons-material/Chat';
import CloseIcon from '@mui/icons-material/Close';
import KeyIcon from '@mui/icons-material/Key';
import SettingsIcon from '@mui/icons-material/Settings';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import html2canvas from 'html2canvas';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import './styles.css';

const PROVIDER_LABELS = {
  anthropic: 'Claude (Anthropic)',
  openai: 'GPT-4o (OpenAI)',
  openrouter: 'Llama (OpenRouter)',
};

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
    { id: 'meta-llama/llama-3.2-11b-vision-instruct:free', label: 'Llama 3.2 11B (Free)' },
    { id: 'google/gemini-flash-1.5:free', label: 'Gemini Flash (Free)' },
  ],
};

const FONT_SIZES = { small: '12px', medium: '14px', large: '16px' };

const Chatbot = ({ dashboardRef, onOpenChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // Provider / model
  const [providers, setProviders] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedModel, setSelectedModel] = useState('');

  // API key panel
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeys, setApiKeys] = useState({
    anthropic: localStorage.getItem('chat_key_anthropic') || '',
    openai: localStorage.getItem('chat_key_openai') || '',
    openrouter: localStorage.getItem('chat_key_openrouter') || '',
  });
  const [keyVisibility, setKeyVisibility] = useState({ anthropic: false, openai: false, openrouter: false });

  // Accessibility
  const [fontSize, setFontSize] = useState(localStorage.getItem('chat_fontSize') || 'medium');
  const [darkMode, setDarkMode] = useState(localStorage.getItem('chat_darkMode') === 'true');
  const [sendOnEnter, setSendOnEnter] = useState(localStorage.getItem('chat_sendOnEnter') !== 'false');
  const [includeScreenshot, setIncludeScreenshot] = useState(true);

  const chatboxRef = useRef(null);
  const inputRef = useRef(null);

  // ── fetch providers from backend ──────────────────────────────────────────
  useEffect(() => {
    fetch('http://localhost:5000/api/chat/providers')
      .then(r => r.json())
      .then(data => {
        setProviders(data.providers || []);
        const def = data.default || 'anthropic';
        setSelectedProvider(def);
        setSelectedModel(MODEL_OPTIONS[def]?.[0]?.id || '');
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

  // ── keyboard shortcut: Ctrl+/ to open/close ───────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        handleOpenChange(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── focus input when opened ───────────────────────────────────────────────
  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 300);
  }, [isOpen]);

  // ── save API keys to localStorage ─────────────────────────────────────────
  const saveApiKey = (provider, value) => {
    const updated = { ...apiKeys, [provider]: value };
    setApiKeys(updated);
    localStorage.setItem(`chat_key_${provider}`, value);
  };

  // ── send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (query) => {
    setIsProcessing(true);
    const apiKey = apiKeys[selectedProvider];

    try {
      let screenshot = null;
      if (includeScreenshot && dashboardRef.current) {
        const canvas = await html2canvas(dashboardRef.current);
        screenshot = canvas.toDataURL('image/jpeg', 0.8);
      }

      const response = await fetch('http://localhost:5000/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          screenshot,
          provider: selectedProvider,
          model: selectedModel,
          ...(apiKey ? { api_key: apiKey } : {}),
        }),
      });

      const data = await response.json();
      return data.success ? data.response : `⚠ ${data.response}`;
    } catch (err) {
      return '⚠ Connection error — is the backend running?';
    } finally {
      setIsProcessing(false);
    }
  }, [selectedProvider, selectedModel, apiKeys, includeScreenshot, dashboardRef]);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    if (!input.trim() || isProcessing) return;
    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, { type: 'user', content: userMessage }]);
    const response = await sendMessage(userMessage);
    setMessages(prev => [...prev, { type: 'bot', content: response, provider: selectedProvider, model: selectedModel }]);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && sendOnEnter && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleOpenChange = (valueOrFn) => {
    setIsOpen(prev => {
      const next = typeof valueOrFn === 'function' ? valueOrFn(prev) : valueOrFn;
      onOpenChange(next);
      return next;
    });
  };

  const onProviderChange = (p) => {
    setSelectedProvider(p);
    setSelectedModel(MODEL_OPTIONS[p]?.[0]?.id || '');
  };

  const clearChat = () => setMessages([]);

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
      {/* Toggle button */}
      <Tooltip title="Trading Assistant (Ctrl+/)" placement="left">
        <IconButton
          className="chatbot-toggle"
          onClick={() => handleOpenChange(v => !v)}
          aria-label="Open trading assistant"
          style={{
            position: 'fixed', top: '20px', right: '20px',
            zIndex: 1001, backgroundColor: '#1976d2', color: 'white',
          }}
        >
          {isOpen ? <CloseIcon /> : <ChatIcon />}
        </IconButton>
      </Tooltip>

      {/* Sidebar */}
      <div
        className={`chatbot-sidebar ${isOpen ? 'open' : ''}`}
        style={{ background: bg, color: textColor, fontSize: FONT_SIZES[fontSize] }}
        role="dialog"
        aria-label="Trading Assistant"
      >
        {/* Header */}
        <div className="chatbot-header" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 'bold' }}>Trading Assistant</span>
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <Tooltip title="API Keys & Settings">
              <IconButton
                size="small"
                onClick={() => setShowSettings(s => !s)}
                aria-label="Settings"
                style={{ color: 'white', padding: '4px' }}
              >
                {showSettings ? <KeyIcon fontSize="small" /> : <SettingsIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
            <Tooltip title="Clear chat">
              <button
                onClick={clearChat}
                aria-label="Clear chat history"
                style={{
                  background: 'rgba(255,255,255,0.2)', border: 'none',
                  color: 'white', borderRadius: '4px', padding: '2px 6px',
                  cursor: 'pointer', fontSize: '11px',
                }}
              >
                Clear
              </button>
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
            <div style={{ fontWeight: 'bold', marginBottom: '8px', color: '#1976d2' }}>
              🔑 API Keys (saved locally)
            </div>

            {[
              { id: 'anthropic', label: 'Anthropic (Claude)', placeholder: 'sk-ant-...' },
              { id: 'openai', label: 'OpenAI (GPT-4o)', placeholder: 'sk-...' },
              { id: 'openrouter', label: 'OpenRouter (free)', placeholder: 'sk-or-...' },
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
                    {keyVisibility[id] ? '🙈' : '👁'}
                  </button>
                </div>
              </div>
            ))}

            <div style={{ fontWeight: 'bold', margin: '10px 0 6px', color: '#1976d2' }}>
              ♿ Accessibility
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

            <div style={{ marginTop: '8px', fontSize: '10px', color: '#888' }}>
              Keys are stored in your browser only, never sent to our server.
              Keyboard shortcut: Ctrl+/ to open/close.
            </div>
          </div>
        )}

        {/* Messages */}
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
              Ask anything about your trading dashboard.<br />
              A screenshot is captured automatically.
            </div>
          )}
          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={`message ${msg.type}`}
              style={msg.type === 'bot' ? { background: msgBotBg, border: `1px solid ${msgBotBorder}`, color: textColor } : {}}
            >
              {msg.type === 'bot' && msg.model && (
                <div style={{ fontSize: '10px', opacity: 0.55, marginBottom: '3px' }}>
                  {PROVIDER_LABELS[msg.provider]} · {MODEL_OPTIONS[msg.provider]?.find(m => m.id === msg.model)?.label || msg.model}
                </div>
              )}
              <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
            </div>
          ))}
          {isProcessing && (
            <div className="message bot" style={{ background: msgBotBg, border: `1px solid ${msgBotBorder}`, color: textColor }}>
              <div style={{ fontSize: '10px', opacity: 0.55, marginBottom: '3px' }}>
                {PROVIDER_LABELS[selectedProvider]} · analyzing…
              </div>
              <span className="typing-dots">●●●</span>
            </div>
          )}
        </div>

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

          {/* Model selector */}
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
            {(MODEL_OPTIONS[selectedProvider] || []).map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
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
          <button
            type="submit"
            disabled={isProcessing || !input.trim()}
            aria-label="Send message"
            style={{ alignSelf: 'flex-end', padding: '8px 16px' }}
          >
            {isProcessing ? '…' : '↑'}
          </button>
        </form>
      </div>
    </>
  );
};

export default Chatbot;
