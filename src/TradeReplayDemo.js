import React, { useState, useMemo, useCallback, useEffect } from 'react';
import axios from 'axios';
import {
  ComposedChart, ScatterChart, Scatter, Line, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
  Legend, ReferenceArea, Customized,
} from 'recharts';

const API = 'http://localhost:5000';

// ── helpers ────────────────────────────────────────────────────────────────────

function parseAmount(raw) {
  if (!raw && raw !== 0) return 0;
  if (typeof raw === 'number') return raw;
  const s = String(raw).replace(/"/g, '').trim();
  if (!s || s === 'nan' || s === 'None') return 0;
  const neg = s.startsWith('(') && s.endsWith(')');
  const num = parseFloat(s.replace(/[^0-9.-]/g, '')) || 0;
  return neg ? -Math.abs(num) : num;
}

function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '$0';
  const abs = Math.abs(n);
  const str = abs >= 1000
    ? (abs / 1000).toFixed(1) + 'k'
    : abs.toFixed(2);
  return (n >= 0 ? '$' : '-$') + str;
}

function toISO(date) {
  if (!date) return null;
  if (typeof date === 'string') return date.slice(0, 10);
  try { return date.toISOString().slice(0, 10); } catch { return null; }
}

// Parse "TSLA 2023-05-19 call 172.5000" or "TSLA 08/09/2024 Call 197.5000"
function parseDescription(desc, instrument) {
  if (!desc) return null;
  const parts = desc.trim().split(/\s+/);
  const typeIdx = parts.findIndex(p => p.toLowerCase() === 'call' || p.toLowerCase() === 'put');
  if (typeIdx < 0) return null;
  return {
    ticker: instrument || parts[0],
    expiry: parts[typeIdx - 1] || '',
    type:   parts[typeIdx].charAt(0).toUpperCase() + parts[typeIdx].slice(1).toLowerCase(),
    strike: parts[typeIdx + 1] || '',
  };
}

// Build positions map from raw trade rows
function computePositions(trades) {
  const map = {};
  trades.forEach(t => {
    const parsed = parseDescription(t['Description'], t['Instrument']);
    if (!parsed) return;
    const { ticker, expiry, type, strike } = parsed;
    const key = `${ticker}_${expiry}_${type}_${strike}`;

    if (!map[key]) {
      map[key] = {
        key, ticker, expiry, type, strike,
        buyAmount: 0, sellAmount: 0, buyQty: 0, sellQty: 0,
        openDate: null, closeDate: null, gainRatio: null, pl: 0, expired: false,
      };
    }
    const p   = map[key];
    const amt = parseAmount(t['Amount']);
    const qty = parseFloat(t['Quantity']) || 0;
    const dt  = t['Activity Date'] ? new Date(t['Activity Date']) : null;

    // Use absolute value — Robinhood uses accounting parentheses (100.00) for negatives,
    // main app strips them, so we match that convention here.
    const absAmt = Math.abs(amt);
    const code = (t['Trans Code'] || '').toUpperCase();
    if (code === 'BTO') {
      p.buyAmount += absAmt;
      p.buyQty    += qty;
      if (dt && (!p.openDate || dt < p.openDate)) p.openDate = dt;
    } else if (code === 'STC') {
      p.sellAmount += absAmt;
      p.sellQty    += qty;
      if (dt && (!p.closeDate || dt > p.closeDate)) p.closeDate = dt;
    } else if (code === 'OEXP') {
      p.expired    = true;
    }
  });

  return Object.values(map).map(p => {
    if (p.expired) { p.sellAmount = 0; p.pl = -p.buyAmount; }
    else            p.pl = p.sellAmount - p.buyAmount;
    p.gainRatio = (p.buyAmount > 0 && p.sellAmount > 0)
      ? p.sellAmount / p.buyAmount : null;
    return p;
  }).filter(p => p.gainRatio !== null && !p.expired);
}

// ── custom scatter dot ─────────────────────────────────────────────────────────

const ScatterDot = (props) => {
  const { cx, cy, payload, onClick, selected } = props;
  if (!cx || !cy) return null;
  const isSelected = selected && selected.key === payload.key;
  const gr = payload.gainRatio ?? 0;
  const r = isSelected ? 9 : gr >= 3 ? 6 : 4;
  // Green gradient for wins, red for losses
  const color = gr >= 5  ? '#00c853'
              : gr >= 2  ? '#43a047'
              : gr >= 1  ? '#81c784'
              : gr >= 0.5 ? '#ef9a9a'
              : '#e53935';
  return (
    <circle cx={cx} cy={cy} r={r}
      fill={color} fillOpacity={0.85}
      stroke={isSelected ? '#1565c0' : 'rgba(0,0,0,0.15)'} strokeWidth={isSelected ? 2.5 : 0.5}
      style={{ cursor: 'pointer' }}
      onClick={() => onClick && onClick(payload)}
    />
  );
};

// ── scatter tooltip ────────────────────────────────────────────────────────────

const ScatterTip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={tipStyle}>
      <strong>{d.ticker} {d.type} {d.strike}</strong><br />
      Expiry: {d.expiry}<br />
      Close: {toISO(d.closeDate)}<br />
      Gain Ratio: <span style={{ color: d.gainRatio >= 1 ? '#00c853' : '#ef5350' }}>
        {d.gainRatio?.toFixed(2)}x
      </span><br />
      P&amp;L: <span style={{ color: d.pl >= 0 ? '#00c853' : '#ef5350' }}>{fmt(d.pl)}</span>
    </div>
  );
};

// ── stock chart tooltip ────────────────────────────────────────────────────────

const StockTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  // Filter out the area band series (high/low) — they show as blank
  const visible = payload.filter(p => p.dataKey !== 'high' && p.dataKey !== 'low' && p.value != null);
  if (!visible.length) return null;
  const raw = payload[0]?.payload;
  return (
    <div style={tipStyle}>
      <strong>{label?.slice(0, 16)}</strong><br />
      {raw?.high != null && <div style={{ fontSize: 11, opacity: 0.8 }}>H: ${raw.high} · L: ${raw.low}</div>}
      {visible.map(p => (
        <div key={p.dataKey}>
          {p.name}: <span style={{ color: p.color }}>{
            typeof p.value === 'number' ? p.value.toFixed(2) : p.value
          }</span>
        </div>
      ))}
    </div>
  );
};

// ── shared style ───────────────────────────────────────────────────────────────

const tipStyle = {
  background: 'rgba(20,20,20,0.88)', color: '#fff',
  padding: '8px 12px', borderRadius: 6, fontSize: 12, lineHeight: 1.7,
  pointerEvents: 'none', whiteSpace: 'nowrap',
};

// ── journal storage ────────────────────────────────────────────────────────────

function journalKey(trade) { return `journal_${trade.key}`; }
function loadJournal(trade) {
  try { return JSON.parse(localStorage.getItem(journalKey(trade)) || '{}'); }
  catch { return {}; }
}
function saveJournal(trade, data) {
  localStorage.setItem(journalKey(trade), JSON.stringify(data));
}

// ── pattern stats sub-component ───────────────────────────────────────────────

function PatternStats({ pattern, color, chipColor, onTickerClick }) {
  const chipStyle = {
    background: chipColor, color: '#fff', padding: '2px 8px', borderRadius: 12,
    fontSize: 12, fontWeight: 600, cursor: 'pointer', userSelect: 'none', display: 'inline-block',
  };
  const statStyle = {
    background: 'rgba(255,255,255,0.65)', borderRadius: 6, padding: '8px 12px',
  };
  const labelStyle = { fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 };
  const valStyle   = { fontSize: 17, fontWeight: 700, color };

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <div style={statStyle}>
          <div style={labelStyle}>Top Tickers</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 }}>
            {pattern.topTickers.map(([t, n]) => (
              <span key={t} style={chipStyle} onClick={() => onTickerClick(t)} title={`×${n} — click to filter`}>
                {t} <span style={{ opacity: 0.7 }}>×{n}</span>
              </span>
            ))}
          </div>
        </div>
        <div style={statStyle}>
          <div style={labelStyle}>Preferred Type</div>
          <div style={{ ...valStyle, fontSize: 15 }}>
            {pattern.topType?.[0] || '—'}
            <span style={{ fontSize: 11, color: '#999', marginLeft: 6 }}>
              {pattern.topType?.[1]}/{pattern.count}
            </span>
          </div>
        </div>
        <div style={statStyle}>
          <div style={labelStyle}>Avg DTE at Entry</div>
          <div style={valStyle}>{pattern.avgDte !== null ? `${pattern.avgDte}d` : '—'}</div>
        </div>
        <div style={statStyle}>
          <div style={labelStyle}>Avg Hold Time</div>
          <div style={valStyle}>{pattern.avgHold !== null ? `${pattern.avgHold}d` : '—'}</div>
        </div>
        <div style={statStyle}>
          <div style={labelStyle}>Avg Gain Ratio</div>
          <div style={valStyle}>{pattern.avgGR}x</div>
        </div>
        <div style={statStyle}>
          <div style={labelStyle}>Avg P&L per Trade</div>
          <div style={valStyle}>
            {pattern.avgPL >= 0 ? '+' : ''}${Math.abs(pattern.avgPL).toLocaleString()}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 11, color: '#666', fontStyle: 'italic' }}>
        💡 Click a ticker to filter scatter to that symbol
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main component
// ══════════════════════════════════════════════════════════════════════════════

export default function TradeReplayDemo({ onBack, initialTrades, initialFilter }) {
  const [username, setUsername]     = useState(localStorage.getItem('tr_user') || '');
  const [password, setPassword]     = useState(localStorage.getItem('tr_pass') || '');
  const [trades, setTrades]         = useState(initialTrades || []);
  const [loadingTrades, setLT]      = useState(false);
  const [tradeError, setTE]         = useState('');

  const [minGR, setMinGR]           = useState(initialFilter?.minGR ?? 0);
  const [tickerFilter, setTF]       = useState(initialFilter?.ticker ?? 'All');

  const [selected, setSelected]     = useState(null);
  const [history, setHistory]       = useState(null);
  const [loadingHist, setLH]        = useState(false);
  const [histError, setHE]          = useState('');

  const [journal, setJournal]       = useState({});
  const [journalDirty, setJD]       = useState(false);
  const [news, setNews]             = useState(null);
  const [loadingNews, setLN]        = useState(false);

  // ── compute positions ──────────────────────────────────────────────────────
  const positions = useMemo(() => computePositions(trades), [trades]);

  const tickers = useMemo(() => {
    const s = new Set(positions.map(p => p.ticker));
    return ['All', ...Array.from(s).sort()];
  }, [positions]);

  const scatterData = useMemo(() => positions
    .filter(p => p.gainRatio >= minGR && (tickerFilter === 'All' || p.ticker === tickerFilter))
    .map(p => ({ ...p, closeTs: p.closeDate ? p.closeDate.getTime() : 0 }))
    .sort((a, b) => a.closeTs - b.closeTs),
    [positions, minGR, tickerFilter]
  );

  const scatterWins   = useMemo(() => scatterData.filter(p => p.gainRatio >= 1).length, [scatterData]);
  const scatterLosses = useMemo(() => scatterData.filter(p => p.gainRatio < 1).length,  [scatterData]);

  const [tableSort, setTableSort] = useState('gainRatio');  // gainRatio | pl | held
  const [tableView, setTableView] = useState('wins');        // wins | losses

  const tableRows = useMemo(() => {
    const src = positions.filter(p => tableView === 'wins' ? p.gainRatio >= 1 : p.gainRatio < 1);
    const held = p => (p.closeDate && p.openDate)
      ? Math.round((p.closeDate - p.openDate) / 86400000) : 0;
    return [...src]
      .sort((a, b) => {
        if (tableSort === 'pl')       return b.pl - a.pl;
        if (tableSort === 'held')     return held(a) - held(b);
        return (b.gainRatio ?? 0) - (a.gainRatio ?? 0);
      })
      .slice(0, 15)
      .map(p => ({ ...p, heldDays: held(p) }));
  }, [positions, tableSort, tableView]);

  // ── pattern fingerprint helper ─────────────────────────────────────────────
  const buildPattern = useCallback((group) => {
    if (group.length < 3) return null;
    const freq = (arr) => {
      const m = {};
      arr.forEach(v => { if (v) m[v] = (m[v] || 0) + 1; });
      return Object.entries(m).sort((a, b) => b[1] - a[1]);
    };
    const dtes = group.map(p => {
      if (!p.openDate || !p.expiry) return null;
      try {
        const exp = new Date(p.expiry.includes('/') ?
          p.expiry.replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2') : p.expiry);
        const d = Math.round((exp - p.openDate) / 86400000);
        return (d >= 0 && d <= 365) ? d : null;
      } catch { return null; }
    }).filter(d => d !== null);
    const holdDays = group.map(p =>
      (p.closeDate && p.openDate) ? Math.round((p.closeDate - p.openDate) / 86400000) : null
    ).filter(d => d !== null);
    return {
      count:      group.length,
      topTickers: freq(group.map(p => p.ticker)).slice(0, 5),
      topType:    freq(group.map(p => p.type))[0] || null,
      avgDte:     dtes.length      ? Math.round(dtes.reduce((a, b) => a + b, 0) / dtes.length) : null,
      avgHold:    holdDays.length  ? Math.round(holdDays.reduce((a, b) => a + b, 0) / holdDays.length) : null,
      avgGR:      (group.reduce((s, p) => s + (p.gainRatio ?? 0), 0) / group.length).toFixed(2),
      avgPL:      Math.round(group.reduce((s, p) => s + p.pl, 0) / group.length),
    };
  }, []);

  const winPattern  = useMemo(() => buildPattern(positions.filter(p => p.gainRatio >= 2)),  [positions, buildPattern]);
  const lossPattern = useMemo(() => buildPattern(positions.filter(p => p.gainRatio < 0.5)), [positions, buildPattern]);

  // ── auto-load on mount if credentials saved ────────────────────────────────
  useEffect(() => {
    if (username && password && trades.length === 0) loadTrades();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── load trades ────────────────────────────────────────────────────────────
  const loadTrades = async () => {
    setLT(true); setTE('');
    try {
      localStorage.setItem('tr_user', username);
      localStorage.setItem('tr_pass', password);
      const res = await axios.post(`${API}/api/fetch-data`, {
        username, password, startDate: '2023-01-01',
        endDate: new Date().toISOString().slice(0, 10),
      });
      setTrades(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      setTE(e?.response?.data?.error || e.message);
    }
    setLT(false);
  };

  // ── select a trade dot → fetch history ────────────────────────────────────
  const selectTrade = useCallback(async (pos) => {
    setSelected(pos);
    setHE('');
    setHistory(null);
    setNews(null);
    setJournal(loadJournal(pos));
    setJD(false);

    const openISO  = toISO(pos.openDate);
    const closeISO = toISO(pos.closeDate);
    if (!openISO || !closeISO) { setHE('Missing open/close date'); return; }

    setLH(true);
    // Fetch stock history and news in parallel
    const [histRes, newsRes] = await Promise.allSettled([
      axios.post(`${API}/api/stock-history`, { ticker: pos.ticker, start_date: openISO, end_date: closeISO }),
      axios.post(`${API}/api/news`,          { ticker: pos.ticker, open_date: openISO, close_date: closeISO }),
    ]);
    if (histRes.status === 'fulfilled') setHistory(histRes.value.data);
    else setHE(histRes.reason?.response?.data?.error || histRes.reason?.message);
    if (newsRes.status === 'fulfilled') setNews(newsRes.value.data);
    setLH(false);
  }, []);

  // ── save journal ───────────────────────────────────────────────────────────
  const saveJ = () => {
    if (selected) { saveJournal(selected, journal); setJD(false); }
  };

  // ── stock chart data ───────────────────────────────────────────────────────
  const chartData = useMemo(() => {
    if (!history?.ohlcv) return [];
    return history.ohlcv.map(c => ({
      dt:       c.datetime?.slice(0, 16).replace('T', ' '),
      close:    c.Close ? +c.Close.toFixed(2) : null,
      high:     c.High  ? +c.High.toFixed(2)  : null,
      low:      c.Low   ? +c.Low.toFixed(2)   : null,
      open:     c.Open  ? +c.Open.toFixed(2)  : null,
      // For area band: [low, high] range
      range:    (c.Low && c.High) ? [+c.Low.toFixed(2), +c.High.toFixed(2)] : null,
    }));
  }, [history]);

  // For VIX we map by date prefix
  const vixByDate = useMemo(() => {
    if (!history?.vix) return {};
    const m = {};
    history.vix.forEach(v => { if (v.datetime && v.vix) m[v.datetime.slice(0,10)] = +v.vix.toFixed(2); });
    return m;
  }, [history]);

  const chartWithVix = useMemo(() => chartData.map(c => ({
    ...c,
    vix: vixByDate[c.dt?.slice(0, 10)] || null,
  })), [chartData, vixByDate]);

  // Reference line X values (match dt format)
  const buyDt = useMemo(() => {
    if (!selected?.openDate || !chartData.length) return null;
    const buyDate = toISO(selected.openDate);
    const match = chartData.find(c => c.dt?.startsWith(buyDate));
    return match?.dt || null;
  }, [selected, chartData]);

  const sellDt = useMemo(() => {
    if (!selected?.closeDate || !chartData.length) return null;
    const sellDate = toISO(selected.closeDate);
    const match = chartData.findLast?.(c => c.dt?.startsWith(sellDate))
      || [...chartData].reverse().find(c => c.dt?.startsWith(sellDate));
    return match?.dt || null;
  }, [selected, chartData]);

  const priceRange = useMemo(() => {
    if (!chartData.length) return [0, 0];
    const vals = chartData.flatMap(c => [c.high, c.low]).filter(Boolean);
    const mn = Math.min(...vals); const mx = Math.max(...vals);
    const pad = (mx - mn) * 0.05;
    return [+(mn - pad).toFixed(2), +(mx + pad).toFixed(2)];
  }, [chartData]);

  const holdPnl = selected ? fmt(selected.pl) : '';
  const holdDays = selected?.openDate && selected?.closeDate
    ? Math.round((new Date(selected.closeDate) - new Date(selected.openDate)) / 86400000)
    : null;

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>

      {/* ── header ── */}
      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {onBack && (
            <button style={styles.backBtn} onClick={onBack}>← Dashboard</button>
          )}
          <span style={styles.title}>🔄 Trade Replay</span>
          <span style={styles.subtitle}>Click any dot on the scatter plot to replay that trade</span>
        </div>
      </div>

      {/* ── credentials row ── */}
      <div style={styles.credRow}>
        <input style={styles.inp} placeholder="Robinhood email"
          value={username} onChange={e => setUsername(e.target.value)} />
        <input style={styles.inp} type="password" placeholder="Password"
          value={password} onChange={e => setPassword(e.target.value)} />
        <button style={styles.btn} onClick={loadTrades} disabled={loadingTrades}>
          {loadingTrades ? 'Loading…' : trades.length ? `Reload (${trades.length} rows)` : 'Load Trades'}
        </button>
        {tradeError && <span style={styles.err}>{tradeError}</span>}
        {trades.length > 0 && !tradeError && (
          <span style={styles.ok}>✓ {positions.length} closed positions</span>
        )}
      </div>

      {/* ── filter row ── */}
      {positions.length > 0 && (
        <div style={styles.filterRow}>
          <label style={styles.filterLabel}>Ticker
            <select style={styles.sel} value={tickerFilter} onChange={e => setTF(e.target.value)}>
              {tickers.map(t => <option key={t}>{t}</option>)}
            </select>
          </label>
          <label style={styles.filterLabel}>Min Gain Ratio
            <input style={{ ...styles.inp, width: 70 }} type="number" step="0.5" min="0"
              value={minGR} onChange={e => setMinGR(+e.target.value)} />
          </label>
          <span style={styles.ok}>{scatterData.length} trades</span>
          <span style={{ fontSize: 12, color: '#00a844' }}>▲ {scatterWins} wins</span>
          <span style={{ fontSize: 12, color: '#e53935' }}>▼ {scatterLosses} losses</span>
          <span style={{ fontSize: 11, color: '#aaa', marginLeft: 4 }}>
            (green=win · red=loss · bigger=higher gain)
          </span>
        </div>
      )}

      {/* ── scatter plot ── */}
      {scatterData.length > 0 && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Gain Ratio (Sell/Buy) by Close Date — click a dot to replay</div>
          <ResponsiveContainer width="100%" height={220}>
            <ScatterChart margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="closeTs" type="number" domain={['auto','auto']}
                tickFormatter={v => new Date(v).toLocaleDateString('en-US', { month:'short', year:'2-digit' })}
                tick={{ fontSize: 10, fill: '#888' }} axisLine={false} tickLine={false} />
              <YAxis dataKey="gainRatio" type="number" domain={[0,'auto']}
                tickFormatter={v => v.toFixed(1) + 'x'}
                tick={{ fontSize: 10, fill: '#888' }} axisLine={false} tickLine={false} width={40} />
              <Tooltip content={<ScatterTip />} />
              <Scatter data={scatterData} shape={
                (props) => <ScatterDot {...props} onClick={selectTrade} selected={selected} />
              } />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}

      {trades.length === 0 && (
        <div style={styles.empty}>
          <div style={{ fontSize: 48 }}>📈</div>
          <div>Enter your Robinhood credentials and click <strong>Load Trades</strong> to begin.</div>
        </div>
      )}

      {/* ── win / loss fingerprint comparison ── */}
      {(winPattern || lossPattern) && (
        <div style={{ margin: '12px 24px 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

          {/* WIN fingerprint */}
          {winPattern && (
            <div style={{ ...styles.patternCard, background: 'linear-gradient(135deg,#e8f5e9,#f1f8e9)', border: '1px solid #c8e6c9' }}>
              <div style={{ ...styles.patternTitle, color: '#2e7d32' }}>
                🏆 Winning Pattern
                <span style={styles.patternSub}> — {winPattern.count} trades with 2x+ gain</span>
              </div>
              <PatternStats pattern={winPattern} color="#2e7d32" chipColor="#2e7d32" onTickerClick={setTF} />
            </div>
          )}

          {/* LOSS fingerprint */}
          {lossPattern && (
            <div style={{ ...styles.patternCard, background: 'linear-gradient(135deg,#fce4ec,#fff8f8)', border: '1px solid #ffcdd2' }}>
              <div style={{ ...styles.patternTitle, color: '#c62828' }}>
                ⚠️ Loss Pattern
                <span style={styles.patternSub}> — {lossPattern.count} trades losing &gt;50%</span>
              </div>
              <PatternStats pattern={lossPattern} color="#c62828" chipColor="#c62828" onTickerClick={setTF} />
            </div>
          )}

        </div>
      )}

      {/* ── top performers table ── */}
      {positions.length > 0 && (
        <div style={styles.card}>
          {/* tab + sort controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #ddd' }}>
              {['wins', 'losses'].map(v => (
                <button key={v} onClick={() => setTableView(v)}
                  style={{ ...styles.tabBtn, background: tableView === v ? '#1976d2' : '#fff',
                    color: tableView === v ? '#fff' : '#555' }}>
                  {v === 'wins' ? `▲ Top Wins` : `▼ Worst Losses`}
                </button>
              ))}
            </div>
            <span style={{ fontSize: 11, color: '#999' }}>Sort by:</span>
            {[['gainRatio', 'Gain Ratio'], ['pl', 'P&L'], ['held', 'Hold Time']].map(([k, label]) => (
              <button key={k} onClick={() => setTableSort(k)}
                style={{ ...styles.sortBtn, fontWeight: tableSort === k ? 700 : 400,
                  color: tableSort === k ? '#1976d2' : '#666',
                  borderBottom: tableSort === k ? '2px solid #1976d2' : '2px solid transparent' }}>
                {label}
              </button>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: 11, color: '#aaa' }}>
              Top 15 — click a row to replay
            </span>
          </div>

          {/* table */}
          <table style={styles.table}>
            <thead>
              <tr style={{ borderBottom: '2px solid #f0f0f0' }}>
                {['Ticker', 'Type', 'Strike', 'Expiry', 'Open', 'Close', 'Held', 'Buy', 'Sell', 'Gain Ratio', 'P&L'].map(h => (
                  <th key={h} style={styles.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row, i) => {
                const isWin = row.gainRatio >= 1;
                const isSel = selected?.key === row.key;
                return (
                  <tr key={row.key} onClick={() => selectTrade(row)}
                    style={{ ...styles.tr, background: isSel ? '#e3f2fd' : i % 2 ? '#fafafa' : '#fff',
                      cursor: 'pointer' }}>
                    <td style={{ ...styles.td, fontWeight: 600 }}>{row.ticker}</td>
                    <td style={{ ...styles.td, color: row.type === 'Call' ? '#1976d2' : '#7b1fa2' }}>{row.type}</td>
                    <td style={styles.td}>${row.strike}</td>
                    <td style={styles.td}>{row.expiry}</td>
                    <td style={styles.td}>{toISO(row.openDate)}</td>
                    <td style={styles.td}>{toISO(row.closeDate)}</td>
                    <td style={styles.td}>{row.heldDays}d</td>
                    <td style={styles.td}>{fmt(row.buyAmount)}</td>
                    <td style={styles.td}>{fmt(row.sellAmount)}</td>
                    <td style={{ ...styles.td, fontWeight: 700, color: isWin ? '#00a844' : '#e53935' }}>
                      {row.gainRatio?.toFixed(2)}x
                    </td>
                    <td style={{ ...styles.td, fontWeight: 700, color: isWin ? '#00a844' : '#e53935' }}>
                      {fmt(row.pl)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── detail panel ── */}
      {selected && (
        <div style={styles.detailPanel}>

          {/* trade header */}
          <div style={styles.tradeHeader}>
            <div>
              <span style={styles.tradeTitle}>
                {selected.ticker} {selected.type} @ ${selected.strike}
              </span>
              <span style={styles.tradeExpiry}> · Expiry {selected.expiry}</span>
            </div>
            <button style={styles.closeBtn} onClick={() => setSelected(null)}>✕</button>
          </div>

          {/* KPI strip */}
          <div style={styles.kpiRow}>
            {[
              { label: 'Gain Ratio', value: `${selected.gainRatio?.toFixed(2)}x`,
                color: selected.gainRatio >= 2 ? '#00c853' : selected.gainRatio >= 1 ? '#66bb6a' : '#ef5350' },
              { label: 'P&L', value: holdPnl,
                color: selected.pl >= 0 ? '#00c853' : '#ef5350' },
              { label: 'Buy Price', value: fmt(selected.buyAmount / (selected.buyQty || 1)) + '/contract', color: '#333' },
              { label: 'Sell Price', value: fmt(selected.sellAmount / (selected.sellQty || 1)) + '/contract', color: '#333' },
              { label: 'Open Date',  value: toISO(selected.openDate),  color: '#1976d2' },
              { label: 'Close Date', value: toISO(selected.closeDate), color: '#e53935' },
              { label: 'Held',       value: holdDays != null ? `${holdDays}d` : '—', color: '#555' },
            ].map(k => (
              <div key={k.label} style={styles.kpi}>
                <div style={styles.kpiLabel}>{k.label}</div>
                <div style={{ ...styles.kpiValue, color: k.color }}>{k.value}</div>
              </div>
            ))}
          </div>

          {/* stock chart */}
          <div style={styles.chartSection}>
            <div style={styles.sectionTitle}>
              {selected.ticker} stock price · {history?.interval} candles
              {loadingHist && <span style={styles.loading}> Loading…</span>}
              {histError && <span style={styles.err}> {histError}</span>}
            </div>

            {chartWithVix.length > 0 && (
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={chartWithVix} margin={{ top: 14, right: 60, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                  <XAxis dataKey="dt"
                    tickFormatter={v => v?.slice(5, 13)}
                    tick={{ fontSize: 9, fill: '#888' }} interval="preserveStartEnd"
                    axisLine={false} tickLine={false} />
                  <YAxis yAxisId="price" domain={priceRange}
                    tick={{ fontSize: 9, fill: '#888' }} axisLine={false} tickLine={false} width={52}
                    tickFormatter={v => '$' + v.toFixed(2)} />
                  <YAxis yAxisId="vix" orientation="right"
                    tick={{ fontSize: 9, fill: '#bbb' }} axisLine={false} tickLine={false} width={38}
                    tickFormatter={v => v.toFixed(0)} />
                  <Tooltip content={<StockTip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />

                  {/* High-Low shaded band — hide from tooltip/legend */}
                  <Area yAxisId="price" type="monotone" dataKey="high"
                    stroke="none" fill="rgba(25,118,210,0.13)" connectNulls dot={false}
                    legendType="none" tooltipType="none" activeDot={false} />
                  <Area yAxisId="price" type="monotone" dataKey="low"
                    stroke="none" fill="white" connectNulls dot={false}
                    legendType="none" tooltipType="none" activeDot={false} />

                  {/* hold period shading */}
                  {buyDt && sellDt && (
                    <ReferenceArea yAxisId="price" x1={buyDt} x2={sellDt}
                      fill="rgba(25,118,210,0.07)" stroke="none" />
                  )}

                  {/* buy / sell lines */}
                  {buyDt && (
                    <ReferenceLine yAxisId="price" x={buyDt}
                      stroke="#00c853" strokeWidth={2} strokeDasharray="5 3"
                      label={{ value: '▲ BUY', position: 'insideTopRight', fill: '#00c853', fontSize: 10, fontWeight: 700 }} />
                  )}
                  {sellDt && (
                    <ReferenceLine yAxisId="price" x={sellDt}
                      stroke="#e53935" strokeWidth={2} strokeDasharray="5 3"
                      label={{ value: '▼ SELL', position: 'insideTopRight', fill: '#e53935', fontSize: 10, fontWeight: 700 }} />
                  )}

                  <Line yAxisId="price" type="monotone" dataKey="close" name="Close"
                    stroke="#1565c0" dot={false} strokeWidth={2.5} connectNulls />
                  <Line yAxisId="vix" type="monotone" dataKey="vix" name="VIX"
                    stroke="#ff9800" dot={false} strokeWidth={1.5}
                    strokeDasharray="4 2" connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* VIX context */}
          {history?.vix?.length > 0 && (() => {
            const buyDate  = toISO(selected.openDate);
            const vixAtBuy = history.vix.find(v => v.datetime?.startsWith(buyDate));
            const avg      = history.vix.reduce((s, v) => s + (v.vix || 0), 0) / history.vix.length;
            return (
              <div style={styles.vixContext}>
                <span>VIX at entry: <strong>{vixAtBuy ? vixAtBuy.vix?.toFixed(1) : '—'}</strong></span>
                <span style={{ marginLeft: 20 }}>Avg VIX (window): <strong>{avg.toFixed(1)}</strong></span>
                <span style={{ marginLeft: 20, color: '#888', fontSize: 11 }}>
                  {vixAtBuy && vixAtBuy.vix > 25
                    ? '⚠️ High VIX at entry — expensive premium'
                    : vixAtBuy && vixAtBuy.vix < 15
                    ? '📉 Low VIX at entry — cheap premium'
                    : ''}
                </span>
              </div>
            );
          })()}

          {/* news context */}
          {(news?.items?.length > 0 || loadingNews) && (
            <div style={styles.newsSection}>
              <div style={styles.sectionTitle}>
                📰 News Context
                {loadingNews && <span style={styles.loading}> fetching…</span>}
                <span style={{ fontWeight: 400, color: '#888', fontSize: 11, marginLeft: 8 }}>
                  headlines around your trade dates · may not be historical for older trades
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(news?.items || []).map((n, i) => (
                  <div key={i} style={{
                    display: 'flex', gap: 10, alignItems: 'flex-start',
                    padding: '6px 10px', borderRadius: 6, background: '#fff',
                    border: `1px solid ${n.bucket === 'entry' ? '#c8e6c9' : n.bucket === 'exit' ? '#ffcdd2' : '#f0f0f0'}`,
                  }}>
                    <span style={{
                      fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 10,
                      background: n.bucket === 'entry' ? '#e8f5e9' : n.bucket === 'exit' ? '#fce4ec' : '#f5f5f5',
                      color:      n.bucket === 'entry' ? '#2e7d32' : n.bucket === 'exit' ? '#c62828' : '#777',
                      whiteSpace: 'nowrap', alignSelf: 'center', flexShrink: 0,
                    }}>
                      {n.bucket === 'entry' ? '▲ ENTRY' : n.bucket === 'exit' ? '▼ EXIT' : 'CONTEXT'}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <a href={n.url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 12, color: '#1565c0', textDecoration: 'none', fontWeight: 500 }}>
                        {n.title}
                      </a>
                      <div style={{ fontSize: 10, color: '#aaa', marginTop: 2 }}>
                        {n.source}{n.date ? ` · ${n.date}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* similar trades */}
          {(() => {
            const similar = positions
              .filter(p => p.ticker === selected.ticker && p.type === selected.type && p.key !== selected.key)
              .sort((a, b) => (b.closeDate?.getTime() ?? 0) - (a.closeDate?.getTime() ?? 0));
            if (!similar.length) return null;
            const wins   = similar.filter(p => p.gainRatio >= 1).length;
            const avgGR  = (similar.reduce((s, p) => s + (p.gainRatio ?? 0), 0) / similar.length).toFixed(2);
            const avgPL  = Math.round(similar.reduce((s, p) => s + p.pl, 0) / similar.length);
            return (
              <div style={styles.similarSection}>
                <div style={styles.sectionTitle}>
                  📋 Your other {selected.ticker} {selected.type} trades
                  <span style={{ fontWeight: 400, color: '#888', marginLeft: 8 }}>
                    {similar.length} trades · {wins}W/{similar.length - wins}L · avg {avgGR}x · avg {avgPL >= 0 ? '+' : ''}${Math.abs(avgPL).toLocaleString()}
                  </span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={styles.table}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #f0f0f0' }}>
                        {['Strike','Expiry','Open','Close','Held','Gain','P&L'].map(h => (
                          <th key={h} style={styles.th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {similar.slice(0, 10).map((s, i) => {
                        const isWin = s.gainRatio >= 1;
                        const hd = (s.closeDate && s.openDate)
                          ? Math.round((s.closeDate - s.openDate) / 86400000) : '—';
                        return (
                          <tr key={s.key} onClick={() => selectTrade(s)}
                            style={{ ...styles.tr, cursor: 'pointer',
                              background: selected?.key === s.key ? '#e3f2fd' : i % 2 ? '#fafafa' : '#fff' }}>
                            <td style={styles.td}>${s.strike}</td>
                            <td style={styles.td}>{s.expiry}</td>
                            <td style={styles.td}>{toISO(s.openDate)}</td>
                            <td style={styles.td}>{toISO(s.closeDate)}</td>
                            <td style={styles.td}>{hd}d</td>
                            <td style={{ ...styles.td, fontWeight: 700, color: isWin ? '#00a844' : '#e53935' }}>
                              {s.gainRatio?.toFixed(2)}x
                            </td>
                            <td style={{ ...styles.td, fontWeight: 700, color: isWin ? '#00a844' : '#e53935' }}>
                              {fmt(s.pl)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {/* journal */}
          <div style={styles.journalSection}>
            <div style={styles.sectionTitle}>📓 Trade Journal</div>
            <div style={styles.journalGrid}>
              {[
                { key: 'thesis',  label: 'What was your thesis going in?' },
                { key: 'entry',   label: 'What signal triggered your entry?' },
                { key: 'exit',    label: 'Why did you exit when you did?' },
                { key: 'learned', label: 'What would you do differently?' },
              ].map(({ key, label }) => (
                <label key={key} style={styles.journalLabel}>
                  <span style={styles.journalQ}>{label}</span>
                  <textarea style={styles.journalTA}
                    value={journal[key] || ''}
                    onChange={e => { setJournal(j => ({ ...j, [key]: e.target.value })); setJD(true); }}
                    rows={3}
                    placeholder="Type your notes…"
                  />
                </label>
              ))}
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
              <button style={styles.btn} onClick={saveJ} disabled={!journalDirty}>
                {journalDirty ? 'Save Journal' : '✓ Saved'}
              </button>
              {!journalDirty && journal.thesis && (
                <span style={styles.ok}>Journal entry loaded from storage</span>
              )}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}

// ── styles ─────────────────────────────────────────────────────────────────────

const styles = {
  root: {
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    background: '#f5f7fa', minHeight: '100vh', padding: '0 0 60px',
  },
  header: {
    background: '#1976d2', color: '#fff', padding: '14px 24px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
  },
  title:    { fontSize: 18, fontWeight: 700 },
  subtitle: { fontSize: 12, opacity: 0.8, marginLeft: 8 },
  backBtn:  {
    background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.4)',
    color: '#fff', padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
  },
  credRow: {
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    padding: '14px 24px', background: '#fff', borderBottom: '1px solid #eee',
  },
  filterRow: {
    display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap',
    padding: '10px 24px', background: '#fff', borderBottom: '1px solid #eee',
  },
  filterLabel: { fontSize: 12, color: '#555', display: 'flex', alignItems: 'center', gap: 6 },
  inp: {
    padding: '7px 10px', border: '1px solid #ddd', borderRadius: 6,
    fontSize: 13, outline: 'none', width: 200,
  },
  sel: {
    padding: '6px 8px', border: '1px solid #ddd', borderRadius: 6,
    fontSize: 13, outline: 'none', cursor: 'pointer',
  },
  btn: {
    padding: '7px 16px', background: '#1976d2', color: '#fff',
    border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 500,
  },
  err:  { fontSize: 12, color: '#e53935' },
  ok:   { fontSize: 12, color: '#00a844' },
  card: {
    margin: '16px 24px 0', background: '#fff', borderRadius: 8,
    padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
  },
  cardTitle: { fontSize: 13, fontWeight: 600, color: '#444', marginBottom: 10 },
  empty: {
    margin: '60px auto', textAlign: 'center', color: '#aaa', fontSize: 15,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
  },
  patternCard: {
    margin: '12px 24px 0', background: 'linear-gradient(135deg, #e8f5e9 0%, #f1f8e9 100%)',
    borderRadius: 8, padding: '14px 20px',
    border: '1px solid #c8e6c9', boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  },
  patternTitle: { fontSize: 14, fontWeight: 700, color: '#2e7d32', marginBottom: 10 },
  patternSub:   { fontSize: 12, fontWeight: 400, color: '#555' },
  patternGrid:  { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 },
  patternStat:  { background: 'rgba(255,255,255,0.7)', borderRadius: 6, padding: '8px 12px' },
  patternLabel: { fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  patternValue: { fontSize: 18, fontWeight: 700, color: '#222' },
  tickerChip: {
    background: '#2e7d32', color: '#fff', padding: '2px 8px', borderRadius: 12,
    fontSize: 12, fontWeight: 600, cursor: 'pointer', userSelect: 'none',
    transition: 'background 0.15s',
  },
  patternHint: { fontSize: 11, color: '#666', marginTop: 10, fontStyle: 'italic' },
  tabBtn:  { padding: '6px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
  sortBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, padding: '2px 6px' },
  table:   { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th:      { padding: '6px 10px', textAlign: 'left', fontSize: 10, color: '#999',
             textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 },
  tr:      { transition: 'background 0.1s', borderBottom: '1px solid #f5f5f5' },
  td:      { padding: '7px 10px', whiteSpace: 'nowrap' },
  loading: { color: '#1976d2', fontSize: 12 },
  detailPanel: {
    margin: '16px 24px 0', background: '#fff', borderRadius: 8,
    boxShadow: '0 1px 6px rgba(0,0,0,0.1)', overflow: 'hidden',
  },
  tradeHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '14px 20px', background: '#1565c0', color: '#fff',
  },
  tradeTitle:  { fontSize: 18, fontWeight: 700 },
  tradeExpiry: { fontSize: 13, opacity: 0.8 },
  closeBtn: {
    background: 'none', border: 'none', color: '#fff',
    fontSize: 18, cursor: 'pointer', padding: '0 4px',
  },
  kpiRow: {
    display: 'flex', flexWrap: 'wrap', gap: 0,
    borderBottom: '1px solid #f0f0f0',
  },
  kpi: {
    flex: '1 1 120px', padding: '12px 20px',
    borderRight: '1px solid #f5f5f5',
  },
  kpiLabel: { fontSize: 10, color: '#999', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.5 },
  kpiValue: { fontSize: 16, fontWeight: 700 },
  chartSection: { padding: '16px 20px' },
  sectionTitle: { fontSize: 13, fontWeight: 600, color: '#555', marginBottom: 10 },
  vixContext: {
    padding: '10px 20px 14px', background: '#fafafa',
    borderTop: '1px solid #f0f0f0', fontSize: 13, color: '#333',
  },
  newsSection:    { padding: '14px 20px', borderTop: '1px solid #f0f0f0', background: '#fafefe' },
  similarSection: { padding: '14px 20px', borderTop: '1px solid #f0f0f0', background: '#fafafa' },
  journalSection: { padding: '16px 20px 20px', borderTop: '1px solid #f0f0f0' },
  journalGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 },
  journalLabel: { display: 'flex', flexDirection: 'column', gap: 4 },
  journalQ: { fontSize: 12, fontWeight: 600, color: '#555' },
  journalTA: {
    resize: 'vertical', border: '1px solid #ddd', borderRadius: 6,
    padding: '8px 10px', fontSize: 12, fontFamily: 'inherit',
    outline: 'none', background: '#fafafa', lineHeight: 1.5,
  },
};
