import React, { useEffect, useRef, useState } from 'react';
import OptionsAnalysisApp from './OptionsAnalysisApp';
import TradeReplayDemo from './TradeReplayDemo';
import SpotReplay from './SpotReplay';
import Chatbot from './components/chatbot/Chatbot';
import { createAssistantRegistry } from './components/chatbot/assistantContext';
import { TargetIcon, ReplayIcon } from './components/icons';
import { useOsTheme } from './osTheme';
import { startAgentBridge } from './agentBridge';

// One registry for the whole app. Pages register their context suppliers and
// STAY registered for their whole lifetime; App keeps registry.active pointed
// at the visible page. See files/assistant-history-design.md.
const assistantRegistry = createAssistantRegistry();

const PAGE_CONTEXT_ID = { dashboard: 'dashboard', replay: 'trade-replay', spot: 'spot-replay' };
const PAGES = ['dashboard', 'replay', 'spot'];

const pageFromHash = () => {
  const h = (window.location.hash || '').replace(/^#\/?/, '');
  return PAGES.includes(h) ? h : 'dashboard';
};

export default function App() {
  const osTheme = useOsTheme(); // day/night, applied via <html data-theme>
  const [page, setPage]       = useState(pageFromHash);
  const [replayFilter, setRF] = useState({ ticker: 'All', minGR: 0 });
  const [replayDates, setRD]  = useState({ startDate: '', endDate: '' });
  // Owned here so the FABs can shift while the sidebar covers them. The
  // sidebar itself never unmounts across navigation, so `chatOpen` always
  // reflects reality.
  const [chatOpen, setChatOpen] = useState(false);

  // Keep-alive routing: pages are mounted once and toggled with display:none,
  // so fetched data / selections survive navigating away and back. Pages are
  // also deep-linkable: #/dashboard, #/replay, #/spot.
  const go = (p) => {
    if (window.location.hash !== `#/${p}`) window.location.hash = `#/${p}`;
    setPage(p);
  };
  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const pageRef = useRef(page);
  pageRef.current = page;

  useEffect(() => {
    assistantRegistry.activeId = PAGE_CONTEXT_ID[page] || 'dashboard';
    window.__osReportPage?.();
  }, [page]);

  // Agent control plane (files/agent-mcp-design.md): any MCP client can
  // navigate/screenshot/inspect the live app through this bridge.
  useEffect(() => {
    startAgentBridge({
      getPage: () => pageRef.current,
      navigate: go,
      getActiveContext: () => assistantRegistry.active,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goReplay = (filter = {}) => {
    const { startDate, endDate, ...rest } = filter;
    setRF({ ticker: 'All', minGR: 0, ...rest });
    if (startDate || endDate) setRD({ startDate: startDate || '', endDate: endDate || '' });
    go('replay');
  };
  const goSpot = () => go('spot');

  return (
    <div className="App">
      {/* ── dashboard ── */}
      <div style={{ display: page === 'dashboard' ? 'block' : 'none' }}>
        <OptionsAnalysisApp
          onReplayTrade={goReplay}
          onDatesChange={setRD}
          chatOpen={chatOpen}
          registry={assistantRegistry}
          osTheme={osTheme}
        />
      </div>

      {/* ── trade replay ── */}
      <div style={{ display: page === 'replay' ? 'block' : 'none' }}>
        <TradeReplayDemo
          onBack={() => go('dashboard')}
          onGoSpot={goSpot}
          initialFilter={replayFilter}
          initialStartDate={replayDates.startDate || undefined}
          initialEndDate={replayDates.endDate || undefined}
          registry={assistantRegistry}
        />
      </div>

      {/* ── spot replay ── */}
      <div style={{ display: page === 'spot' ? 'block' : 'none' }}>
        <SpotReplay onBack={() => go('dashboard')} registry={assistantRegistry} chatOpen={chatOpen} />
      </div>

      {/* Floating nav buttons — dashboard only (stateless, safe to toggle) */}
      {page === 'dashboard' && (
        <>
          <button
            onClick={goSpot}
            style={{
              position: 'fixed', bottom: 84, right: chatOpen ? 392 : 24, zIndex: 1000,
              background: '#1baf7a', color: '#fff', border: 'none',
              borderRadius: 28, padding: '12px 22px',
              fontSize: 14, fontWeight: 600, cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(27,175,122,0.4)',
              display: 'flex', alignItems: 'center', gap: 8,
              transition: 'right 0.3s ease-in-out',
            }}
          >
            <TargetIcon size={16} /> Spot Replay
          </button>
          <button
            onClick={() => goReplay()}
            style={{
              position: 'fixed', bottom: 24, right: chatOpen ? 392 : 24, zIndex: 1000,
              background: '#1565c0', color: '#fff', border: 'none',
              borderRadius: 28, padding: '12px 22px',
              fontSize: 14, fontWeight: 600, cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(21,101,192,0.4)',
              display: 'flex', alignItems: 'center', gap: 8,
              transition: 'right 0.3s ease-in-out',
            }}
          >
            <ReplayIcon size={15} /> Trade Replay
          </button>
        </>
      )}

      {/* Mounted ONCE above the page switch — survives every navigation */}
      <Chatbot open={chatOpen} onOpenChange={setChatOpen} registry={assistantRegistry} />
    </div>
  );
}
