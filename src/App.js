import React, { useState } from 'react';
import OptionsAnalysisApp from './OptionsAnalysisApp';
import TradeReplayDemo from './TradeReplayDemo';

export default function App() {
  const [page, setPage]       = useState('dashboard');
  const [replayFilter, setRF] = useState({ ticker: 'All', minGR: 0 });
  const [replayDates, setRD]  = useState({ startDate: '', endDate: '' });

  const goReplay = (filter = {}) => {
    const { startDate, endDate, ...rest } = filter;
    setRF({ ticker: 'All', minGR: 0, ...rest });
    if (startDate || endDate) setRD({ startDate: startDate || '', endDate: endDate || '' });
    setPage('replay');
  };

  return (
    <div className="App">
      {page === 'replay' ? (
        <TradeReplayDemo
          onBack={() => setPage('dashboard')}
          initialFilter={replayFilter}
          initialStartDate={replayDates.startDate || undefined}
          initialEndDate={replayDates.endDate || undefined}
        />
      ) : (
        <>
          <OptionsAnalysisApp onReplayTrade={goReplay} onDatesChange={setRD} />
          <button
            onClick={() => goReplay()}
            style={{
              position: 'fixed', bottom: 24, right: 24, zIndex: 1000,
              background: '#1565c0', color: '#fff', border: 'none',
              borderRadius: 28, padding: '12px 22px',
              fontSize: 14, fontWeight: 600, cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(21,101,192,0.4)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            🔄 Trade Replay
          </button>
        </>
      )}
    </div>
  );
}
