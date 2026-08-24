import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import axios from 'axios';
import {
  ComposedChart, ScatterChart, Scatter, Line, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
  Legend, ReferenceArea, Customized, Brush,
} from 'recharts';
import TradingNotes from './tradingnotes';
import { useAssistantContext } from './components/chatbot/assistantContext';
import { TargetIcon, ReplayIcon, CloseIcon, BulbIcon, ChartUpIcon, TrophyIcon, AlertIcon, BookIcon, KeyIcon, NewsIcon, ListIcon, TrendDownIcon, GearIcon } from './components/icons';
import ErrorBubble from './components/ErrorBubble';
// Backend base — runtime-resolved so the app works over localhost OR the WSL
// IP from the Windows browser (see src/apiBase.js).
import { API_BASE as API } from './apiBase';

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

// Robinhood's Activity DateTime is UTC, e.g. "2023-05-12T20:58:59.806380Z".
// Displayed as-is (UTC) rather than converted to browser-local time, so it
// stays unambiguous and matches the raw value everything else is keyed off.
function fmtDateTime(iso) {
  if (!iso) return '—';
  // Seconds included: day-trades often open and close within the same minute,
  // and minute precision made Buy/Sell look identical.
  return iso.slice(0, 19).replace('T', ' ') + ' UTC';
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
        openDate: null, closeDate: null, openDateTime: null, closeDateTime: null,
        gainRatio: null, pl: 0, expired: false,
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
    const actDT = t['Activity DateTime'] || null;
    if (code === 'BTO') {
      p.buyAmount += absAmt;
      p.buyQty    += qty;
      if (dt && (!p.openDate || dt < p.openDate)) {
        p.openDate     = dt;
        p.openDateTime = actDT;
      }
    } else if (code === 'STC') {
      p.sellAmount += absAmt;
      p.sellQty    += qty;
      if (dt && (!p.closeDate || dt > p.closeDate)) {
        p.closeDate     = dt;
        p.closeDateTime = actDT;
      }
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

// Color cycle for multi-select chart lines & markers (per trade / per ticker).
const MULTI_PALETTE = ['#1565c0', '#00897b', '#e65100', '#6a1fb1', '#2e7d32', '#c62828', '#00838f', '#5d4037'];

const ScatterDot = (props) => {
  const { cx, cy, payload, onClick, selected, multiSelected } = props;
  if (!cx || !cy) return null;
  const isSelected = selected && selected.key === payload.key;
  const isMulti = !!(multiSelected && multiSelected.has && multiSelected.has(payload.key));
  const gr = payload.gainRatio ?? 0;
  const r = isSelected ? 9 : isMulti ? 7 : gr >= 3 ? 6 : 4;
  // Green gradient for wins, red for losses
  const color = gr >= 5  ? '#00c853'
              : gr >= 2  ? '#43a047'
              : gr >= 1  ? '#81c784'
              : gr >= 0.5 ? '#ef9a9a'
              : '#e53935';
  return (
    <circle cx={cx} cy={cy} r={r}
      fill={color} fillOpacity={0.85}
      stroke={isSelected ? '#1565c0' : isMulti ? '#ff9800' : 'var(--os-border)'}
      strokeWidth={isSelected || isMulti ? 2.5 : 0.5}
      style={{ cursor: 'pointer' }}
      onClick={(ev) => onClick && onClick(payload, ev)}
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
      Buy: {fmtDateTime(d.openDateTime)}<br />
      Sell: {fmtDateTime(d.closeDateTime)}<br />
      Gain Ratio: <span style={{ color: d.gainRatio >= 1 ? '#00c853' : '#ef5350' }}>
        {d.gainRatio?.toFixed(2)}x
      </span><br />
      P&amp;L: <span style={{ color: d.pl >= 0 ? '#00c853' : '#ef5350' }}>{fmt(d.pl)}</span>
    </div>
  );
};

// ── RSI (Wilder smoothing; period adapts to available candles) ────────────────
// Shared by the single-trade chart and the multi-select per-ticker charts.
function computeRsiSeries(rows) {
  const period = rows.length >= 30 ? 14 : rows.length >= 10 ? 7 : 0;
  if (period === 0 || rows.length < period + 1) return [];
  const deltas = rows.map((c, i) => {
    if (i === 0) return null;
    const prev = rows[i - 1].close; const curr = c.close;
    return (prev !== null && curr !== null) ? curr - prev : null;
  });
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    if (deltas[i] === null) continue;
    if (deltas[i] > 0) avgGain += deltas[i]; else avgLoss += Math.abs(deltas[i]);
  }
  avgGain /= period; avgLoss /= period;
  const rsiArr = new Array(period).fill(null);
  const rs0 = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  rsiArr.push(avgLoss === 0 ? 100 : +(100 - 100 / (1 + rs0)).toFixed(2));
  for (let i = period + 1; i < rows.length; i++) {
    if (deltas[i] === null) { rsiArr.push(null); continue; }
    const g = deltas[i] > 0 ? deltas[i] : 0;
    const l = deltas[i] < 0 ? Math.abs(deltas[i]) : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    rsiArr.push(avgLoss === 0 ? 100 : +(100 - 100 / (1 + rs)).toFixed(2));
  }
  return rows.map((c, i) => ({ dt: c.dt, rsi: rsiArr[i] ?? null }));
}

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

// ── compute auto-zoom brush for intraday charts ────────────────────────────────

// Robinhood created_at is UTC (e.g. "2023-05-19T13:30:00.000000Z" = 09:30 ET).
// yfinance returns candles in local exchange time (ET).
// Find the candle on `dateStr` whose time is closest to `utcIso` after converting UTC→ET.
function findCandleByTime(chartDts, dateStr, utcIso) {
  if (!utcIso || !dateStr) return -1;
  const utcH = parseInt(utcIso.slice(11, 13), 10);
  const utcM = parseInt(utcIso.slice(14, 16), 10);
  // Collect indices for that date
  const dayIdxs = chartDts.reduce((a, d, i) => { if (d?.startsWith(dateStr)) a.push(i); return a; }, []);
  if (!dayIdxs.length) return -1;
  let best = -1, bestDiff = Infinity;
  for (const i of dayIdxs) {
    const d = chartDts[i];
    const h = parseInt(d.slice(11, 13), 10) || 0;
    const m = parseInt(d.slice(14, 16), 10) || 0;
    const mins = h * 60 + m;
    // Try both EDT (UTC-4) and EST (UTC-5)
    for (const off of [4, 5]) {
      const diff = Math.abs(mins - (((utcH - off + 24) % 24) * 60 + utcM));
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
  }
  return bestDiff <= 30 ? best : -1; // reject if >30-min gap
}

// Locates the exact candle for the buy and the sell (time-precise via UTC→ET
// matching on intraday data, falling back to date-only on daily candles where
// there's nothing finer to match against), plus an auto-zoom window around
// them. Reference lines and the zoom brush both derive from this one pass so
// they can never disagree with each other about which candle a trade happened on.
function computeTradeChartLayout(ohlcv, buyDate, sellDate, interval, buyIso, sellIso) {
  if (!ohlcv?.length) return { brush: null, buyDt: null, sellDt: null };

  const chartDts = ohlcv.map(c => c.datetime?.slice(0, 16).replace('T', ' '));
  const isIntraday = !!interval && interval !== '1d';

  // Buy candle: proximity match by time (UTC→ET) on intraday data, else the
  // (only) candle for that date.
  let buyIdx = (isIntraday && buyDate && buyIso) ? findCandleByTime(chartDts, buyDate, buyIso) : -1;
  if (buyIdx < 0 && buyDate) buyIdx = chartDts.findIndex(d => d?.startsWith(buyDate));

  // Sell candle (search from end)
  let sellIdx = -1;
  if (isIntraday && sellDate && sellIso) {
    sellIdx = findCandleByTime(chartDts, sellDate, sellIso);
    // findCandleByTime may return the same candle as buy on same-day trades;
    // scan backwards from it for the true close candle
    if (sellIdx >= 0 && sellIdx === buyIdx) {
      for (let i = chartDts.length - 1; i >= 0; i--) {
        if (chartDts[i]?.startsWith(sellDate)) { sellIdx = i; break; }
      }
    }
  }
  if (sellIdx < 0 && sellDate) {
    for (let i = chartDts.length - 1; i >= 0; i--) {
      if (chartDts[i]?.startsWith(sellDate)) { sellIdx = i; break; }
    }
  }

  let brush = null;
  // Only auto-zoom on intraday data with real timestamps — date-only data
  // gives a meaningless full-day range.
  if (isIntraday && (buyIso || sellIso) && (buyIdx >= 0 || sellIdx >= 0)) {
    const pad = interval === '1m' ? 30 : interval === '5m' ? 15 : interval === '15m' ? 10 : 6;
    const startIndex = Math.max(0, (buyIdx >= 0 ? buyIdx : sellIdx) - pad);
    const endIndex   = Math.min(ohlcv.length - 1, (sellIdx >= 0 ? sellIdx : buyIdx) + pad);
    if (endIndex > startIndex) brush = { startIndex, endIndex };
  }

  return {
    brush,
    buyDt:  buyIdx  >= 0 ? chartDts[buyIdx]  : null,
    sellDt: sellIdx >= 0 ? chartDts[sellIdx] : null,
  };
}

// ── journal storage ────────────────────────────────────────────────────────────

function journalKey(trade) { return `journal_${trade.key}`; }
function loadJournal(trade) {
  try { return JSON.parse(localStorage.getItem(journalKey(trade)) || '{}'); }
  catch { return {}; }
}
function saveJournal(trade, data) {
  localStorage.setItem(journalKey(trade), JSON.stringify(data));
}

// ── candlestick SVG layer (used as Customized child in ComposedChart) ─────────
function CandlestickLayer({ xAxisMap, yAxisMap, data }) {
  const xAxis = xAxisMap?.[0];
  const yAxis = yAxisMap?.['price'];
  if (!xAxis?.scale || !yAxis?.scale || !data?.length) return null;
  const bw = xAxis.bandSize ?? 4;
  const cw = Math.max(2, Math.min(bw * 0.65, 14));
  return (
    <g>
      {data.map((d, i) => {
        if (d.open == null || d.close == null) return null;
        const cx = xAxis.scale(d.dt);
        if (cx == null || isNaN(cx)) return null;
        const yO = yAxis.scale(d.open);
        const yC = yAxis.scale(d.close);
        const yH = d.high != null ? yAxis.scale(d.high) : Math.min(yO, yC);
        const yL = d.low  != null ? yAxis.scale(d.low)  : Math.max(yO, yC);
        const isUp = d.close >= d.open;
        const col  = isUp ? '#00c853' : '#e53935';
        const bodyTop = Math.min(yO, yC);
        const bodyH   = Math.max(1, Math.abs(yC - yO));
        return (
          <g key={i}>
            <line x1={cx} y1={yH} x2={cx} y2={yL} stroke={col} strokeWidth={1} />
            <rect x={cx - cw / 2} y={bodyTop} width={cw} height={bodyH}
              fill={col} stroke={col} strokeWidth={0.5} />
          </g>
        );
      })}
    </g>
  );
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
      <div style={{ fontSize: 11, color: '#666', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 5 }}>
        <BulbIcon size={12} /> Click a ticker to filter scatter to that symbol
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main component
// ══════════════════════════════════════════════════════════════════════════════

export default function TradeReplayDemo({ onBack, onGoSpot, initialTrades, initialFilter, initialStartDate, initialEndDate, registry }) {
  const [username, setUsername]     = useState(localStorage.getItem('tr_user') || '');
  const [password, setPassword]     = useState(localStorage.getItem('tr_pass') || '');
  const [startDate, setStartDate]   = useState(
    initialStartDate || localStorage.getItem('tr_start') || '2023-01-01'
  );
  const [endDate, setEndDate]       = useState(
    initialEndDate || localStorage.getItem('tr_end') || new Date().toISOString().slice(0, 10)
  );
  const [trades, setTrades]         = useState(initialTrades || []);
  const [loadingTrades, setLT]      = useState(false);
  const [tradeError, setTE]         = useState('');
  const [showCred, setShowCred]     = useState(false);

  // ── multi-select (scatter) + multi-trade price charts ─────────────────────
  // Ctrl/Cmd+click a dot any time, or flip the card's Multi-select button and
  // plain clicks toggle too. Selection drives the toolbar, the pattern-card
  // badges and the "Selected Trades · Price Action" charts below the scatter.
  const [multiMode, setMultiMode]   = useState(false);
  const [multiSel, setMultiSel]     = useState(() => new Set());
  const [tsMode, setTsMode]         = useState('single'); // 'single' | 'multi'
  const [multiHist, setMultiHist]   = useState({});       // { [ticker]: history }
  const [multiLoading, setMultiLoad] = useState(false);
  const [multiErr, setMultiErr]     = useState('');
  const [msBrush, setMsBrush]       = useState(null);     // single-plot zoom
  const [mtBrushes, setMtBrushes]   = useState({});       // { [ticker]: zoom }

  const [minGR, setMinGR] = useState(initialFilter?.minGR ?? (localStorage.getItem('tr_minGR') !== null ? parseFloat(localStorage.getItem('tr_minGR')) : 0));
  const [tickerFilter, setTF] = useState(initialFilter?.ticker ?? localStorage.getItem('tr_ticker') ?? 'All');

  // Settings → Preferences → remember filters: persist as they change.
  useEffect(() => {
    if (localStorage.getItem('remember_filters') === 'false') return;
    localStorage.setItem('tr_minGR', String(minGR));
    localStorage.setItem('tr_ticker', tickerFilter);
  }, [minGR, tickerFilter]);

  const [selected, setSelected]     = useState(null);
  const [history, setHistory]       = useState(null);
  const [loadingHist, setLH]        = useState(false);
  const [histError, setHE]          = useState('');

  const [journal, setJournal]       = useState({});
  const [journalDirty, setJD]       = useState(false);
  const [news, setNews]             = useState(null);

  const [chartType, setChartType]   = useState('line');  // 'line' | 'area' | 'candle'
  const [overrideInterval, setOI]   = useState('auto');  // 'auto' | '1m' | '5m' | '15m' | '1h' | '1d'
  const [priceBrush, setPriceBrush] = useState(null);    // { startIndex, endIndex }
  const [rsiBrush,   setRsiBrush]   = useState(null);
  const [tradeCandles, setTradeCandles] = useState({ buyDt: null, sellDt: null }); // exact buy/sell candle dt, stable across manual brush drags

  // Provider API keys — persisted to localStorage so user only enters once
  const [alpacaKey,    setAlpacaKey]    = useState(() => localStorage.getItem('alpaca_key')    || '');
  const [alpacaSecret, setAlpacaSecret] = useState(() => localStorage.getItem('alpaca_secret') || '');
  const [polygonKey,   setPolygonKey]   = useState(() => localStorage.getItem('polygon_key')   || '');
  const [keysOpen,     setKeysOpen]     = useState(false);

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

  // ── selection-derived values (Replace + badge semantics) ──────────────────
  // Must precede the pattern memos — they read activePositions.
  const selectedPositions = useMemo(
    () => positions.filter(p => multiSel.has(p.key)),
    [positions, multiSel]
  );
  const activePositions = multiSel.size > 0 ? selectedPositions : positions;
  const selWins  = selectedPositions.filter(p => p.gainRatio >= 1).length;
  const selPL    = selectedPositions.reduce((s, p) => s + (p.pl || 0), 0);
  // Per-trade colors, stable while the selection set doesn't reorder.
  const tradeColor = useCallback((key) => {
    const idx = selectedPositions.findIndex(p => p.key === key);
    return MULTI_PALETTE[(idx < 0 ? 0 : idx) % MULTI_PALETTE.length];
  }, [selectedPositions]);
  const tickerGroups = useMemo(() => {
    const m = new Map();
    selectedPositions.forEach(p => {
      if (!m.has(p.ticker)) m.set(p.ticker, []);
      m.get(p.ticker).push(p);
    });
    return [...m.entries()]; // [[ticker, [pos…]], …] in first-selected order
  }, [selectedPositions]);

  const winPattern  = useMemo(() => buildPattern(activePositions.filter(p => p.gainRatio >= 2)),  [activePositions, buildPattern]);
  const lossPattern = useMemo(() => buildPattern(activePositions.filter(p => p.gainRatio < 0.5)), [activePositions, buildPattern]);

  // ── assistant context: what the model sees when asked from this page ──────
  const rootRef = useRef(null);
  useAssistantContext(registry, {
    id: 'trade-replay',
    title: 'Trade Replay',
    getContext: () => ({
      filters: { ticker: tickerFilter, minGainRatio: minGR, startDate, endDate },
      totalPositions: positions.length,
      wins: scatterWins, losses: scatterLosses,
      selectedTrade: selected ? {
        ticker: selected.ticker, type: selected.type, strike: selected.strike,
        expiry: selected.expiry, key: selected.key,
        buyAmount: Math.round(selected.buyAmount), sellAmount: Math.round(selected.sellAmount),
        pl: Math.round(selected.pl), gainRatio: selected.gainRatio != null ? +selected.gainRatio.toFixed(2) : null,
        expired: !!selected.expired,
        openDate: selected.openDate?.toISOString?.().slice(0, 10) || null,
        closeDate: selected.closeDate?.toISOString?.().slice(0, 10) || null,
        quantity: selected.sellQty || selected.buyQty || null,
        journalNote: journal[selected.key] || null,
      } : null,
      note: 'selectedTrade is the position currently charted; null means none picked yet. '
          + 'wins/losses counted by gainRatio >=/< 1 (premium recovered vs paid).',
    }),
    targetRef: rootRef,
  });

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
      localStorage.setItem('tr_start', startDate);
      localStorage.setItem('tr_end',   endDate);
      const res = await axios.post(`${API}/api/fetch-data`, {
        username, password, startDate, endDate,
      });
      setTrades(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      setTE(e?.response?.data?.error || e.message);
    }
    setLT(false);
  };

  // ── save credentials from the settings dialog ───────────────────────────────
  // Persist immediately on write/change, then auto-load if nothing is loaded yet.
  const saveCreds = () => {
    localStorage.setItem('tr_user', username);
    localStorage.setItem('tr_pass', password);
    setShowCred(false);
    if (trades.length === 0 && username && password && !loadingTrades) loadTrades();
  };

  // Keys snapshot for API calls — read from state refs to always get latest value.
  // Settings → Preferences → "Force yfinance" sends no keys so the backend
  // skips paid providers entirely.
  const providerKeys = () => {
    if (localStorage.getItem('data_provider') === 'force_yfinance') return {};
    return {
      ...(alpacaKey    ? { alpaca_key: alpacaKey }       : {}),
      ...(alpacaSecret ? { alpaca_secret: alpacaSecret } : {}),
      ...(polygonKey   ? { polygon_key: polygonKey }     : {}),
    };
  };

  // ── select a trade dot → fetch history + news ─────────────────────────────
  const selectTrade = useCallback(async (pos, interval) => {
    setSelected(pos);
    setHE('');
    setHistory(null);
    setNews(null);
    setJournal(loadJournal(pos));
    setJD(false);
    setPriceBrush(null);  // cleared here; will be set to auto-zoom once data arrives
    setRsiBrush(null);
    setTradeCandles({ buyDt: null, sellDt: null });

    const openISO  = toISO(pos.openDate);
    const closeISO = toISO(pos.closeDate);
    if (!openISO || !closeISO) { setHE('Missing open/close date'); return; }

    setLH(true);
    const [histRes, newsRes] = await Promise.allSettled([
      axios.post(`${API}/api/stock-history`, {
        ticker: pos.ticker, start_date: openISO, end_date: closeISO,
        interval: interval || 'auto', ...providerKeys(),
      }),
      axios.post(`${API}/api/news`, { ticker: pos.ticker, open_date: openISO, close_date: closeISO }),
    ]);
    if (histRes.status === 'fulfilled') {
      const data = histRes.value.data;
      setHistory(data);
      const layout = computeTradeChartLayout(data?.ohlcv, openISO, closeISO, data?.interval, pos.openDateTime, pos.closeDateTime);
      setPriceBrush(layout.brush);
      setTradeCandles({ buyDt: layout.buyDt, sellDt: layout.sellDt });
      setRsiBrush(null);
    } else setHE(histRes.reason?.response?.data?.error || histRes.reason?.message);
    if (newsRes.status === 'fulfilled') setNews(newsRes.value.data);
    setLH(false);
  }, []);

  // Re-fetch history (only) when interval override changes and a trade is selected
  useEffect(() => {
    if (!selected) return;
    const openISO  = toISO(selected.openDate);
    const closeISO = toISO(selected.closeDate);
    if (!openISO || !closeISO) return;
    setLH(true); setHE(''); setPriceBrush(null); setRsiBrush(null);
    setTradeCandles({ buyDt: null, sellDt: null });
    axios.post(`${API}/api/stock-history`, {
      ticker: selected.ticker, start_date: openISO, end_date: closeISO,
      interval: overrideInterval, ...providerKeys(),
    }).then(r => {
      setHistory(r.data);
      const layout = computeTradeChartLayout(r.data?.ohlcv, openISO, closeISO, r.data?.interval, selected.openDateTime, selected.closeDateTime);
      setPriceBrush(layout.brush);
      setTradeCandles({ buyDt: layout.buyDt, sellDt: layout.sellDt });
      setRsiBrush(null);
    }).catch(e => setHE(e?.response?.data?.error || e.message))
      .finally(() => setLH(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideInterval]);

  // ── multi-select: dot click routing ──────────────────────────────────────────
  // Multi-select button ON → plain clicks toggle dots. Button OFF → plain
  // click replays (today's behavior) and Ctrl/Cmd+click toggles selection.
  const handleScatterClick = useCallback((pos, ev) => {
    if (multiMode || ev?.ctrlKey || ev?.metaKey) {
      setMultiSel(prev => {
        const n = new Set(prev);
        if (n.has(pos.key)) n.delete(pos.key); else n.add(pos.key);
        return n;
      });
      return;
    }
    selectTrade(pos);
  }, [multiMode, selectTrade]);

  // Selection self-prunes when trades are reloaded and keys disappear.
  useEffect(() => {
    setMultiSel(prev => {
      if (prev.size === 0) return prev;
      const keys = new Set(positions.map(p => p.key));
      const next = new Set([...prev].filter(k => keys.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [positions]);

  // ── batch history fetch for the multi-select price charts ─────────────────
  // One request per unique ticker covering the whole selection window; results
  // cached in state until the selection or interval changes. Same-day (day-
  // trade) selections auto-escalate granularity so the buy/sell markers can
  // land on separate candles — daily bars would stack them on one datetime.
  useEffect(() => {
    if (multiSel.size === 0) { setMultiHist({}); setMultiErr(''); return; }
    let cancelled = false;
    (async () => {
      setMultiLoad(true); setMultiErr('');
      const tickers = [...new Set(selectedPositions.map(p => p.ticker))];
      const opens  = selectedPositions.map(p => toISO(p.openDate)).filter(Boolean).sort();
      const closes = selectedPositions.map(p => toISO(p.closeDate)).filter(Boolean).sort();
      if (!opens.length || !closes.length) {
        setMultiErr('Selection has trades with missing dates'); setMultiLoad(false); return;
      }
      const anySameDay = selectedPositions.some(p => toISO(p.openDate) === toISO(p.closeDate));
      const spanDays = (new Date(closes[closes.length - 1]) - new Date(opens[0])) / 86400000;
      const effInterval = overrideInterval !== 'auto' ? overrideInterval
        : anySameDay ? (spanDays <= 3 ? '1m' : spanDays <= 14 ? '5m' : '15m')
        : 'auto';
      const results = {};
      await Promise.allSettled(tickers.map(tk =>
        axios.post(`${API}/api/stock-history`, {
          ticker: tk, start_date: opens[0], end_date: closes[closes.length - 1],
          interval: effInterval, ...providerKeys(),
        }).then(r => { results[tk] = r.data; })
          .catch(e => { results[tk] = { error: e?.response?.data?.error || e.message }; })
      ));
      if (cancelled) return;
      setMultiHist(results);
      setMsBrush(null); setMtBrushes({});   // fresh window → reset zooms
      const failed = tickers.filter(tk => results[tk]?.error);
      setMultiErr(failed.length ? `${failed.length}/${tickers.length} ticker(s) failed: ${failed.join(', ')}` : '');
      setMultiLoad(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiSel, overrideInterval]);

  // Candle dt for a trade marker: snap to the candle NEAREST the trade's real
  // timestamp (Activity DateTime) so intraday buys/sells separate; falls back
  // to the first candle of the trade's date when no timestamp exists.
  const markerDt = (rows, date, exactIso) => {
    if (exactIso) {
      const t = new Date(exactIso).getTime();
      if (Number.isFinite(t)) {
        let best = null, bestDiff = Infinity;
        for (const r of rows) {
          const rt = new Date((r.dt || '').replace(' ', 'T') + 'Z').getTime();
          if (!Number.isFinite(rt)) continue;
          const diff = Math.abs(rt - t);
          if (diff < bestDiff) { bestDiff = diff; best = r.dt; }
        }
        if (best) return best;
      }
    }
    const iso = toISO(date);
    return iso ? (rows.find(r => r.dt?.startsWith(iso))?.dt || null) : null;
  };

  // Merged rows for Single-plot: { dt, [ticker]: close, vix }. With more than
  // one ticker every series is normalized to % change from window start so
  // different price scales share one axis. VIX is merged once — market-wide.
  const singleRows = useMemo(() => {
    if (tickerGroups.length === 0) return [];
    const tickers = tickerGroups.map(([tk]) => tk);
    const rows = new Map();
    tickers.forEach(tk => {
      (multiHist[tk]?.ohlcv || []).forEach(c => {
        const dt = c.datetime?.slice(0, 16).replace('T', ' ');
        if (!dt) return;
        if (!rows.has(dt)) rows.set(dt, { dt });
        rows.get(dt)[tk] = c.Close != null ? +c.Close.toFixed(2) : null;
      });
    });
    const vixSrc = tickers.map(tk => multiHist[tk]).find(h => h?.vix?.length);
    (vixSrc?.vix || []).forEach(v => {
      const dt = v.datetime?.slice(0, 16).replace('T', ' ');
      if (dt && rows.has(dt)) rows.get(dt).vix = v.vix ?? null;
    });
    const out = [...rows.values()].sort((a, b) => (a.dt < b.dt ? -1 : 1));
    if (tickers.length > 1) {
      const base = {};
      tickers.forEach(tk => {
        const first = out.find(r => r[tk] != null);
        base[tk] = first ? first[tk] : null;
      });
      out.forEach(r => {
        tickers.forEach(tk => {
          r[tk] = (r[tk] != null && base[tk]) ? +(((r[tk] - base[tk]) / base[tk]) * 100).toFixed(2) : null;
        });
      });
    }
    return out;
  }, [tickerGroups, multiHist]);

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

  // Reference line X values — the exact buy/sell candle, time-matched (not
  // just date-matched) via computeTradeChartLayout when history loads, so the
  // BUY/SELL lines and the auto-zoom brush always agree on the same candle.
  const { buyDt, sellDt } = tradeCandles;

  const priceRange = useMemo(() => {
    if (!chartData.length) return [0, 0];
    const vals = chartData.flatMap(c => [c.high, c.low]).filter(Boolean);
    const mn = Math.min(...vals); const mx = Math.max(...vals);
    const pad = (mx - mn) * 0.05;
    return [+(mn - pad).toFixed(2), +(mx + pad).toFixed(2)];
  }, [chartData]);

  // RSI — see computeRsiSeries (module scope), shared with the multi charts
  const rsiData = useMemo(() => computeRsiSeries(chartData), [chartData]);

  const holdPnl = selected ? fmt(selected.pl) : '';
  const holdDays = selected?.openDate && selected?.closeDate
    ? Math.round((new Date(selected.closeDate) - new Date(selected.openDate)) / 86400000)
    : null;

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div style={styles.root} ref={rootRef}>
      <ErrorBubble message={histError || tradeError} />

      {/* ── header ── */}
      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {onBack && (
            <button style={styles.backBtn} onClick={onBack}>← Dashboard</button>
          )}
          {onGoSpot && (
            <button style={{ ...styles.backBtn, background: 'rgba(255,255,255,0.22)', borderColor: 'rgba(255,255,255,0.75)',
                             display: 'inline-flex', alignItems: 'center', gap: 6, color: '#fff', fontWeight: 600 }} onClick={onGoSpot}
                    title="Open the dynamic options edge analyzer">
              <TargetIcon size={14} /> Spot Replay
            </button>
          )}
          <span style={{ ...styles.title, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <ReplayIcon size={16} /> Trade Replay
          </span>
          <span style={styles.subtitle}>Click any dot on the scatter plot to replay that trade</span>
        </div>
      </div>

      {/* ── controls row (credentials live behind the gear button) ── */}
      <div style={styles.credRow}>
        <input style={{ ...styles.inp, width: 130 }} type="date"
          value={startDate} onChange={e => setStartDate(e.target.value)} />
        <input style={{ ...styles.inp, width: 130 }} type="date"
          value={endDate} onChange={e => setEndDate(e.target.value)} />
        <button style={styles.gearBtn} onClick={() => setShowCred(true)}
                title="Robinhood credentials" aria-label="Robinhood credentials settings">
          <GearIcon size={14} />
          {username && password
            ? <span style={{ fontSize: 11 }}>Credentials saved</span>
            : <span style={{ fontSize: 11 }}>Add credentials</span>}
        </button>
        <button style={styles.btn} onClick={() => loadTrades()} disabled={loadingTrades}>
          {loadingTrades ? 'Loading…' : trades.length ? `Reload (${trades.length} rows)` : 'Load Trades'}
        </button>
        {tradeError && <span style={styles.err}>{tradeError}</span>}
        {trades.length > 0 && !tradeError && (
          <span style={styles.ok}>✓ {positions.length} closed positions</span>
        )}
      </div>

      {/* ── credentials dialog ── */}
      {showCred && (
        <>
          <div onClick={() => setShowCred(false)} aria-label="Close credentials dialog"
               style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 998 }} />
          <div role="dialog" aria-label="Robinhood credentials"
               style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 999,
                        width: 300, padding: 16, boxSizing: 'border-box',
                        background: 'var(--os-surface)', color: 'var(--os-text)',
                        border: '1px solid var(--os-border)', borderRadius: 8,
                        boxShadow: 'var(--os-shadow-2)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
                <KeyIcon size={13} /> Robinhood Credentials
              </strong>
              <button onClick={() => setShowCred(false)} aria-label="Close"
                      style={{ border: 'none', background: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
                <CloseIcon size={15} />
              </button>
            </div>
            <input style={{ ...styles.inp, width: '100%', boxSizing: 'border-box' }} placeholder="Robinhood email"
              value={username} onChange={e => setUsername(e.target.value)} />
            <input style={{ ...styles.inp, width: '100%', boxSizing: 'border-box' }} type="password" placeholder="Password"
              value={password} onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveCreds()} />
            <div style={{ fontSize: 10.5, color: 'var(--os-text-3)' }}>
              Saved locally in this browser the moment you save, and reused automatically on every visit.
            </div>
            <button style={styles.btn} onClick={saveCreds}>Save</button>
          </div>
        </>
      )}

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
          {multiSel.size > 0 ? (
            <>
              <span style={{ ...styles.ok, fontWeight: 700, color: '#ff9800' }}>{multiSel.size} SELECTED</span>
              <span style={{ fontSize: 12, color: '#00a844' }}>▲ {selWins} wins</span>
              <span style={{ fontSize: 12, color: '#e53935' }}>▼ {multiSel.size - selWins} losses</span>
            </>
          ) : (
            <>
              <span style={styles.ok}>{scatterData.length} trades</span>
              <span style={{ fontSize: 12, color: '#00a844' }}>▲ {scatterWins} wins</span>
              <span style={{ fontSize: 12, color: '#e53935' }}>▼ {scatterLosses} losses</span>
            </>
          )}
          <span style={{ fontSize: 11, color: 'var(--os-text-3)', marginLeft: 4 }}>
            (green=win · red=loss · bigger=higher gain)
          </span>
        </div>
      )}

      {/* ── scatter plot ── */}
      {scatterData.length > 0 && (
        <div style={styles.card}>
          <div style={{ ...styles.cardTitle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <span>
              Gain Ratio (Sell/Buy) by Close Date — click a dot to replay
              {multiMode && <span style={{ color: '#ff9800' }}> · multi-select ON</span>}
            </span>
            <button onClick={() => setMultiMode(m => !m)}
                    title="Multi-select: plain clicks toggle dots into a set. Ctrl/Cmd+click works even with this off."
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px',
                             fontSize: 11, fontWeight: 600, borderRadius: 4, cursor: 'pointer', flexShrink: 0,
                             background: multiMode ? '#ff9800' : 'var(--os-surface)',
                             color: multiMode ? '#fff' : 'var(--os-text-2)',
                             border: `1px solid ${multiMode ? '#ff9800' : 'var(--os-border)'}` }}>
              <ListIcon size={12} /> Multi-select
            </button>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <ScatterChart margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--os-border)" />
              <XAxis dataKey="closeTs" type="number" domain={['auto','auto']}
                tickFormatter={v => new Date(v).toLocaleDateString('en-US', { month:'short', year:'2-digit' })}
                tick={{ fontSize: 10, fill: 'var(--os-text-2)' }} axisLine={false} tickLine={false} />
              <YAxis dataKey="gainRatio" type="number" domain={[0,'auto']}
                tickFormatter={v => v.toFixed(1) + 'x'}
                tick={{ fontSize: 10, fill: 'var(--os-text-2)' }} axisLine={false} tickLine={false} width={40} />
              <Tooltip content={<ScatterTip />} />
              <Scatter data={scatterData} shape={
                (props) => <ScatterDot {...props} onClick={handleScatterClick} selected={selected} multiSelected={multiSel} />
              } />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── multi-select toolbar (stats + global chart controls) ── */}
      {multiSel.size > 0 && (
        <div style={{ margin: '10px 24px 0', background: 'var(--os-surface)', border: '1px solid #ff9800', borderRadius: 8, padding: '8px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: '#ff9800', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <ListIcon size={13} /> {multiSel.size} selected
            </span>
            <span style={{ fontSize: 12, color: '#00a844' }}>▲ {selWins}W</span>
            <span style={{ fontSize: 12, color: '#e53935' }}>▼ {multiSel.size - selWins}L</span>
            <span style={{ fontSize: 12, color: 'var(--os-text)' }}>P&amp;L {selPL >= 0 ? '+' : ''}{fmt(selPL)}</span>
            <span style={{ fontSize: 11, color: 'var(--os-text-3)' }}>
              pattern cards &amp; counts reflect the selection · Ctrl+click adds more
            </span>
            <div style={{ flex: 1 }} />
            <button onClick={() => { setMultiSel(new Set()); setMsBrush(null); setMtBrushes({}); }}
                    style={{ border: '1px solid var(--os-border)', background: 'var(--os-bg)', color: 'var(--os-text-2)',
                             padding: '3px 12px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
              Clear ✕
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 7, paddingTop: 7, borderTop: '1px solid var(--os-border)' }}>
            <span style={{ fontSize: 11, color: 'var(--os-text-3)' }}>Layout:</span>
            {[['single', 'Single-plot'], ['multi', 'Multi-ticker']].map(([m, label]) => (
              <button key={m} onClick={() => setTsMode(m)}
                      style={{ padding: '3px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', borderRadius: 4,
                               background: tsMode === m ? '#1565c0' : 'var(--os-surface)',
                               color: tsMode === m ? '#fff' : 'var(--os-text-2)',
                               border: `1px solid ${tsMode === m ? '#1565c0' : 'var(--os-border)'}` }}>
                {label}
              </button>
            ))}
            {tsMode === 'multi' && (
              <>
                <div style={{ width: 1, height: 16, background: 'var(--os-border)', margin: '0 6px' }} />
                <span style={{ fontSize: 11, color: 'var(--os-text-3)' }}>Chart:</span>
                {[['line', 'Line'], ['area', 'Area'], ['candle', 'Candle']].map(([ct, label]) => (
                  <button key={ct} onClick={() => setChartType(ct)}
                          style={{ padding: '3px 10px', fontSize: 11, borderRadius: 4, cursor: 'pointer', fontWeight: 600,
                                   background: chartType === ct ? '#1565c0' : 'var(--os-surface)',
                                   color: chartType === ct ? '#fff' : 'var(--os-text-2)',
                                   border: `1px solid ${chartType === ct ? '#1565c0' : 'var(--os-border)'}` }}>
                    {label}
                  </button>
                ))}
              </>
            )}
            <div style={{ width: 1, height: 16, background: 'var(--os-border)', margin: '0 6px' }} />
            <span style={{ fontSize: 11, color: 'var(--os-text-3)' }}>Interval:</span>
            {['auto', '1m', '5m', '15m', '1h', '1d'].map(iv => (
              <button key={iv} onClick={() => setOI(iv)}
                      style={{ padding: '3px 9px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                               background: overrideInterval === iv ? '#ff9800' : 'var(--os-border)',
                               color: overrideInterval === iv ? '#fff' : 'var(--os-text-2)',
                               border: `1px solid ${overrideInterval === iv ? '#ff9800' : 'var(--os-border)'}`,
                               fontWeight: overrideInterval === iv ? 600 : 400 }}>
                {iv}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── selected trades · single-plot overlay ── */}
      {multiSel.size > 0 && tsMode === 'single' && (() => {
        const tickers = tickerGroups.map(([tk]) => tk);
        const normed = tickers.length > 1;
        const showLabels = selectedPositions.length <= 6;
        // Technical indicators on Single-plot only when ONE ticker is selected
        // — otherwise which ticker the RSI describes would be ambiguous.
        let singleRsiRows = [];
        if (tickers.length === 1) {
          const r = (multiHist[tickers[0]]?.ohlcv || []).map(c => ({
            dt: c.datetime?.slice(0, 16).replace('T', ' '),
            close: c.Close != null ? +c.Close.toFixed(2) : null,
          })).filter(x => x.dt);
          singleRsiRows = computeRsiSeries(r);
        }
        return (
          <div style={{ ...styles.card, marginTop: 12 }}>
            <div style={{ ...styles.cardTitle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                <ListIcon size={13} /> Selected Trades · Single-plot
                {multiLoading && <span style={{ color: 'var(--os-text-3)', fontWeight: 400 }}>· loading history…</span>}
                {multiErr && <span style={styles.err}>{multiErr}</span>}
              </span>
              {msBrush && singleRows.length > 0 && (
                <button onClick={() => setMsBrush(null)} style={styles.resetZoom}>⟲ Reset zoom</button>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--os-text-3)', marginBottom: 4 }}>
              {normed
                ? '% change from window start · one line per ticker'
                : 'raw close · buy/sell markers per selected trade'}
              {' · VIX (market-wide index) · drag the bottom brush to zoom'}
            </div>
            {singleRows.length > 0 && (
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={singleRows} margin={{ top: 14, right: 56, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--os-border)" vertical={false} />
                  <XAxis dataKey="dt" tickFormatter={v => v?.slice(5, 13)}
                    tick={{ fontSize: 9, fill: 'var(--os-text-2)' }} interval="preserveStartEnd"
                    axisLine={false} tickLine={false} />
                  <YAxis yAxisId="price"
                    tick={{ fontSize: 9, fill: 'var(--os-text-2)' }} axisLine={false} tickLine={false} width={52}
                    tickFormatter={v => normed ? `${v}%` : `$${v.toFixed(2)}`} />
                  <YAxis yAxisId="vix" orientation="right"
                    tick={{ fontSize: 9, fill: 'var(--os-text-3)' }} axisLine={false} tickLine={false} width={34}
                    tickFormatter={v => v.toFixed(0)} />
                  <Tooltip content={<StockTip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {tickers.map((tk, i) => (
                    <Line key={tk} yAxisId="price" type="monotone" dataKey={tk} name={tk}
                      stroke={normed ? MULTI_PALETTE[i % MULTI_PALETTE.length] : '#1565c0'}
                      dot={false} strokeWidth={2} connectNulls />
                  ))}
                  {selectedPositions.map(p => {
                    const c = tradeColor(p.key);
                    const b = markerDt(singleRows, p.openDate, p.openDateTime);
                    const s = markerDt(singleRows, p.closeDate, p.closeDateTime);
                    return (
                      <React.Fragment key={p.key}>
                        {b && <ReferenceLine yAxisId="price" x={b} stroke={c} strokeWidth={1.5} strokeDasharray="4 3"
                          label={showLabels ? { value: '▲', position: 'insideTopRight', fill: c, fontSize: 9 } : undefined} />}
                        {s && <ReferenceLine yAxisId="price" x={s} stroke={c} strokeWidth={1.5} strokeDasharray="4 3"
                          label={showLabels ? { value: '▼', position: 'insideTopRight', fill: c, fontSize: 9 } : undefined} />}
                      </React.Fragment>
                    );
                  })}
                  <Line yAxisId="vix" type="monotone" dataKey="vix" name="VIX"
                    stroke="#ff9800" dot={false} strokeWidth={1.5} strokeDasharray="4 2" connectNulls />
                  <Brush dataKey="dt" height={24} travellerWidth={8}
                    stroke="#90caf9" fill="#f0f4ff"
                    startIndex={msBrush?.startIndex ?? 0}
                    endIndex={msBrush?.endIndex ?? Math.max(0, singleRows.length - 1)}
                    onChange={({ startIndex, endIndex }) => setMsBrush({ startIndex, endIndex })}
                    tickFormatter={() => ''} />
                 </ComposedChart>
              </ResponsiveContainer>
            )}

            {singleRsiRows.length > 0 && singleRsiRows.some(d => d.rsi !== null) && (
              <div style={{ marginTop: 4 }}>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: '#7b1fa2', marginBottom: 2, paddingLeft: 2 }}>
                  RSI ({singleRows.length >= 30 ? 14 : 7}) · {tickers[0]} — overbought &gt;70 · oversold &lt;30
                </div>
                <ResponsiveContainer width="100%" height={90}>
                  <ComposedChart data={singleRsiRows} margin={{ top: 4, right: 56, left: 0, bottom: 0 }}>
                    <XAxis dataKey="dt" tickFormatter={v => v?.slice(5, 13)}
                      tick={{ fontSize: 8, fill: 'var(--os-text-3)' }} interval="preserveStartEnd"
                      axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} ticks={[30, 50, 70]}
                      tick={{ fontSize: 8, fill: 'var(--os-text-3)' }} axisLine={false} tickLine={false} width={34} />
                    <Tooltip formatter={(v) => [v !== null ? v.toFixed(1) : '—', 'RSI']}
                      contentStyle={{ fontSize: 11, borderRadius: 6, padding: '4px 10px' }} />
                    <ReferenceArea y1={70} y2={100} fill="rgba(229,57,53,0.08)" stroke="none" />
                    <ReferenceArea y1={0} y2={30} fill="rgba(0,200,83,0.08)" stroke="none" />
                    <ReferenceLine y={70} stroke="#e53935" strokeDasharray="4 2" strokeWidth={1} />
                    <ReferenceLine y={30} stroke="#00c853" strokeDasharray="4 2" strokeWidth={1} />
                    <Line type="monotone" dataKey="rsi" name="RSI" stroke="#7b1fa2" dot={false} strokeWidth={1.5} connectNulls />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── selected trades · one separate card per ticker (Multi-ticker) ── */}
      {multiSel.size > 0 && tsMode === 'multi' && (() => {
        const MAX_TICKERS = 12;
        const groups = tickerGroups.slice(0, MAX_TICKERS);
        return (
          <>
            {(multiErr || multiLoading) && (
              <div style={{ margin: '10px 24px 0', fontSize: 12 }}>
                {multiLoading && <span style={{ color: 'var(--os-text-3)' }}>loading history…</span>}
                {multiErr && <span style={styles.err}>{multiErr}</span>}
              </div>
            )}
            {tickerGroups.length > MAX_TICKERS && (
              <div style={{ margin: '10px 24px 0', fontSize: 11, color: 'var(--os-text-3)' }}>
                +{tickerGroups.length - MAX_TICKERS} more tickers not charted (cap {MAX_TICKERS})
              </div>
            )}
            {groups.map(([tk, tradesIn]) => {
              const hist = multiHist[tk];
              const rows = (hist?.ohlcv || []).map(c => ({
                dt: c.datetime?.slice(0, 16).replace('T', ' '),
                close: c.Close != null ? +c.Close.toFixed(2) : null,
                high: c.High != null ? +c.High.toFixed(2) : undefined,
                low: c.Low != null ? +c.Low.toFixed(2) : undefined,
                open: c.Open != null ? +c.Open.toFixed(2) : undefined,
              })).filter(r => r.dt);
              // VIX merged into EVERY card — each ticker chart is self-contained.
              if (hist?.vix?.length) {
                const vmap = new Map(hist.vix.map(v => [v.datetime?.slice(0, 16).replace('T', ' '), v.vix]));
                rows.forEach(r => { if (vmap.has(r.dt)) r.vix = vmap.get(r.dt); });
              }
              const netPL = tradesIn.reduce((s, p) => s + (p.pl || 0), 0);
              const hasVix = rows.some(r => r.vix != null);
              const rsiRows = computeRsiSeries(rows);
              const br = mtBrushes[tk];
              const tkColor = MULTI_PALETTE[Math.max(0, tickerGroups.findIndex(g => g[0] === tk)) % MULTI_PALETTE.length];
              return (
                <div key={tk} style={{ ...styles.card, marginTop: 12 }}>
                  <div style={{ ...styles.cardTitle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ color: tkColor }}>{tk}</span>
                      <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--os-text-3)' }}>
                        {tradesIn.length} trade{tradesIn.length > 1 ? 's' : ''} · net P&amp;L
                      </span>
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: netPL >= 0 ? '#00a844' : '#e53935' }}>
                        {netPL >= 0 ? '+' : ''}{fmt(netPL)}
                      </span>
                      {hist?.interval && <span style={{ fontSize: 10, color: 'var(--os-text-3)' }}>· {hist.interval}</span>}
                      {hist?.error && <span style={styles.err}>{hist.error}</span>}
                      {multiLoading && !hist && <span style={{ fontSize: 11, color: 'var(--os-text-3)' }}>· loading…</span>}
                    </span>
                    {br && rows.length > 0 && (
                      <button onClick={() => setMtBrushes(prev => ({ ...prev, [tk]: null }))}
                              style={styles.resetZoom}>⟲ Reset zoom</button>
                    )}
                  </div>

                  {/* per-trade detail strip — same fields as the single-trade view */}
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginBottom: 8 }}>
                    <thead>
                      <tr style={{ color: 'var(--os-text-3)', textAlign: 'left' }}>
                        <th style={{ padding: '3px 8px 3px 0' }}>Trade</th>
                        <th style={{ padding: '3px 8px' }}>Gain Ratio</th>
                        <th style={{ padding: '3px 8px' }}>P&amp;L</th>
                        <th style={{ padding: '3px 8px' }}>Buy $/c</th>
                        <th style={{ padding: '3px 8px' }}>Sell $/c</th>
                        <th style={{ padding: '3px 8px' }}>Buy Time</th>
                        <th style={{ padding: '3px 8px' }}>Sell Time</th>
                        <th style={{ padding: '3px 8px' }}>Held</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tradesIn.map(p => {
                        const held = p.openDate && p.closeDate
                          ? Math.round((new Date(p.closeDate) - new Date(p.openDate)) / 86400000) : null;
                        return (
                          <tr key={p.key} style={{ borderTop: '1px solid var(--os-border)', color: 'var(--os-text)' }}>
                            <td style={{ padding: '4px 8px 4px 0', fontWeight: 600 }}>{p.type} @ ${p.strike} · {p.expiry}</td>
                            <td style={{ padding: '4px 8px', color: p.gainRatio >= 1 ? '#00a844' : '#e53935' }}>{p.gainRatio?.toFixed(2)}x</td>
                            <td style={{ padding: '4px 8px', color: p.pl >= 0 ? '#00a844' : '#e53935' }}>{fmt(p.pl)}</td>
                            <td style={{ padding: '4px 8px' }}>{fmt(p.buyAmount / (p.buyQty || 1))}</td>
                            <td style={{ padding: '4px 8px' }}>{fmt(p.sellAmount / (p.sellQty || 1))}</td>
                            <td style={{ padding: '4px 8px', color: 'var(--os-text-2)' }}>{fmtDateTime(p.openDateTime)}</td>
                            <td style={{ padding: '4px 8px', color: 'var(--os-text-2)' }}>{fmtDateTime(p.closeDateTime)}</td>
                            <td style={{ padding: '4px 8px' }}>{held != null ? `${held}d` : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  {rows.length > 0 && (
                    <>
                      <ResponsiveContainer width="100%" height={220}>
                        <ComposedChart data={rows} margin={{ top: 8, right: hasVix ? 56 : 16, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--os-border)" vertical={false} />
                          <XAxis dataKey="dt" tickFormatter={v => v?.slice(5, 13)}
                            tick={{ fontSize: 9, fill: 'var(--os-text-2)' }} interval="preserveStartEnd"
                            axisLine={false} tickLine={false} />
                          <YAxis yAxisId="price" domain={['auto', 'auto']}
                            tick={{ fontSize: 9, fill: 'var(--os-text-2)' }} axisLine={false} tickLine={false} width={52}
                            tickFormatter={v => `$${v.toFixed(2)}`} />
                          {hasVix && (
                            <YAxis yAxisId="vix" orientation="right"
                              tick={{ fontSize: 9, fill: 'var(--os-text-3)' }} axisLine={false} tickLine={false} width={34}
                              tickFormatter={v => v.toFixed(0)} />
                          )}
                          <Tooltip content={<StockTip />} />
                          {chartType === 'area' && (
                            <Area yAxisId="price" type="monotone" dataKey="close" name="Close"
                              stroke="none" fill="rgba(21,101,192,0.22)" dot={false} connectNulls />
                          )}
                          {tradesIn.map(p => {
                            const c = tradeColor(p.key);
                            const b = markerDt(rows, p.openDate, p.openDateTime);
                            const s = markerDt(rows, p.closeDate, p.closeDateTime);
                            return (
                              <React.Fragment key={p.key}>
                                {b && <ReferenceLine yAxisId="price" x={b} stroke={c} strokeWidth={1.5} strokeDasharray="4 3"
                                  label={{ value: '▲', position: 'insideTopRight', fill: c, fontSize: 9 }} />}
                                {s && <ReferenceLine yAxisId="price" x={s} stroke={c} strokeWidth={1.5} strokeDasharray="4 3"
                                  label={{ value: '▼', position: 'insideTopRight', fill: c, fontSize: 9 }} />}
                              </React.Fragment>
                            );
                          })}
                          {chartType === 'line' && (
                            <Line yAxisId="price" type="monotone" dataKey="close" name="Close"
                              stroke="#1565c0" dot={false} strokeWidth={2} connectNulls />
                          )}
                          {chartType === 'candle' && (
                            <>
                              <Line yAxisId="price" type="monotone" dataKey="close" name="Close"
                                stroke="none" dot={false} activeDot={false} strokeWidth={0} connectNulls isAnimationActive={false} />
                              <Customized component={CandlestickLayer} data={rows} />
                            </>
                          )}
                          {hasVix && (
                            <Line yAxisId="vix" type="monotone" dataKey="vix" name="VIX"
                              stroke="#ff9800" dot={false} strokeWidth={1.5} strokeDasharray="4 2" connectNulls />
                          )}
                          <Brush dataKey="dt" height={22} travellerWidth={8}
                            stroke="#90caf9" fill="#f0f4ff"
                            startIndex={br?.startIndex ?? 0}
                            endIndex={br?.endIndex ?? Math.max(0, rows.length - 1)}
                            onChange={({ startIndex, endIndex }) => setMtBrushes(prev => ({ ...prev, [tk]: { startIndex, endIndex } }))}
                            tickFormatter={() => ''} />
                        </ComposedChart>
                      </ResponsiveContainer>

                      {rsiRows.length > 0 && rsiRows.some(d => d.rsi !== null) && (
                        <div style={{ marginTop: 4 }}>
                          <div style={{ fontSize: 10.5, fontWeight: 600, color: '#7b1fa2', marginBottom: 2, paddingLeft: 2 }}>
                            RSI ({rows.length >= 30 ? 14 : 7}) — overbought &gt;70 · oversold &lt;30
                          </div>
                          <ResponsiveContainer width="100%" height={90}>
                            <ComposedChart data={rsiRows} margin={{ top: 4, right: hasVix ? 56 : 16, left: 0, bottom: 0 }}>
                              <XAxis dataKey="dt" tickFormatter={v => v?.slice(5, 13)}
                                tick={{ fontSize: 8, fill: 'var(--os-text-3)' }} interval="preserveStartEnd"
                                axisLine={false} tickLine={false} />
                              <YAxis domain={[0, 100]} ticks={[30, 50, 70]}
                                tick={{ fontSize: 8, fill: 'var(--os-text-3)' }} axisLine={false} tickLine={false} width={34} />
                              <Tooltip formatter={(v) => [v !== null ? v.toFixed(1) : '—', 'RSI']}
                                contentStyle={{ fontSize: 11, borderRadius: 6, padding: '4px 10px' }} />
                              <ReferenceArea y1={70} y2={100} fill="rgba(229,57,53,0.08)" stroke="none" />
                              <ReferenceArea y1={0} y2={30} fill="rgba(0,200,83,0.08)" stroke="none" />
                              <ReferenceLine y={70} stroke="#e53935" strokeDasharray="4 2" strokeWidth={1} />
                              <ReferenceLine y={30} stroke="#00c853" strokeDasharray="4 2" strokeWidth={1} />
                              <Line type="monotone" dataKey="rsi" name="RSI" stroke="#7b1fa2" dot={false} strokeWidth={1.5} connectNulls />
                            </ComposedChart>
                          </ResponsiveContainer>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </>
        );
      })()}

      {trades.length === 0 && (
        <div style={styles.empty}>
        <div style={{ color: '#4c7daf' }}><ChartUpIcon size={48} /></div>
          <div>Add your Robinhood credentials via the gear button, then click <strong>Load Trades</strong> to begin.</div>
        </div>
      )}

      {/* ── win / loss fingerprint comparison ──
          Always rendered once trades are loaded (persistent): with a narrow
          selection one side may simply have no qualifying trades — we show an
          explicit empty state instead of making the whole grid vanish. */}
      {positions.length > 0 && (
        <div style={{ margin: '12px 24px 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

          {/* WIN fingerprint */}
          <div style={{ ...styles.patternCard, background: 'linear-gradient(135deg,#e8f5e9,#f1f8e9)', border: '1px solid #c8e6c9' }}>
            <div style={{ ...styles.patternTitle, color: '#2e7d32' }}>
              <TrophyIcon size={17} /> Winning Pattern
              {multiSel.size > 0 && (
                <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, background: '#ff9800', color: '#fff', borderRadius: 4, padding: '1px 6px', verticalAlign: 'middle' }}>
                  SELECTED {multiSel.size}
                </span>
              )}
              <span style={styles.patternSub}> — {winPattern ? `${winPattern.count} trades with 2x+ gain` : 'none in scope'}</span>
            </div>
            {winPattern
              ? <PatternStats pattern={winPattern} color="#2e7d32" chipColor="#2e7d32" onTickerClick={setTF} />
              : <div style={{ fontSize: 12, color: 'var(--os-text-3)', padding: '10px 0' }}>
                  No trades with gain ratio ≥ 2x {multiSel.size > 0 ? 'in the selection' : 'in the current filter'}.
                </div>}
          </div>

          {/* LOSS fingerprint */}
          <div style={{ ...styles.patternCard, background: 'linear-gradient(135deg,#fce4ec,#fff8f8)', border: '1px solid #ffcdd2' }}>
            <div style={{ ...styles.patternTitle, color: '#c62828' }}>
              <TrendDownIcon size={17} /> Losing Pattern
              {multiSel.size > 0 && (
                <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, background: '#ff9800', color: '#fff', borderRadius: 4, padding: '1px 6px', verticalAlign: 'middle' }}>
                  SELECTED {multiSel.size}
                </span>
              )}
              <span style={styles.patternSub}> — {lossPattern ? `${lossPattern.count} trades losing &gt;50%` : 'none in scope'}</span>
            </div>
            {lossPattern
              ? <PatternStats pattern={lossPattern} color="#c62828" chipColor="#c62828" onTickerClick={setTF} />
              : <div style={{ fontSize: 12, color: 'var(--os-text-3)', padding: '10px 0' }}>
                  No trades losing more than 50% {multiSel.size > 0 ? 'in the selection' : 'in the current filter'}.
                </div>}
          </div>

        </div>
      )}

      {/* ── top performers table ── */}
      {positions.length > 0 && (
        <div style={styles.card}>
          {/* tab + sort controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--os-border)' }}>
              {['wins', 'losses'].map(v => (
                <button key={v} onClick={() => setTableView(v)}
                  style={{ ...styles.tabBtn, background: tableView === v ? '#1976d2' : 'var(--os-surface)',
                    color: tableView === v ? '#fff' : 'var(--os-text-2)' }}>
                  {v === 'wins' ? `▲ Top Wins` : `▼ Worst Losses`}
                </button>
              ))}
            </div>
            <span style={{ fontSize: 11, color: 'var(--os-text-3)' }}>Sort by:</span>
            {[['gainRatio', 'Gain Ratio'], ['pl', 'P&L'], ['held', 'Hold Time']].map(([k, label]) => (
              <button key={k} onClick={() => setTableSort(k)}
                style={{ ...styles.sortBtn, fontWeight: tableSort === k ? 700 : 400,
                  color: tableSort === k ? '#1976d2' : 'var(--os-text-2)',
                  borderBottom: tableSort === k ? '2px solid #1976d2' : '2px solid transparent' }}>
                {label}
              </button>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--os-text-3)' }}>
              Top 15 — click a row to replay
            </span>
          </div>

          {/* table */}
          <div style={{ overflowX: 'auto' }}>
          <table style={styles.table}>
            <thead>
              <tr style={{ borderBottom: '2px solid #f0f0f0' }}>
                {['Ticker', 'Type', 'Strike', 'Expiry', 'Buy Time', 'Sell Time', 'Held', 'Buy $', 'Sell $', 'Gain Ratio', 'P&L'].map(h => (
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
                    style={{ ...styles.tr, background: isSel ? 'rgba(25,118,210,0.16)' : i % 2 ? 'rgba(127,127,127,0.06)' : 'transparent',
                      cursor: 'pointer' }}>
                    <td style={{ ...styles.td, fontWeight: 600 }}>{row.ticker}</td>
                    <td style={{ ...styles.td, color: row.type === 'Call' ? '#1976d2' : '#7b1fa2' }}>{row.type}</td>
                    <td style={styles.td}>${row.strike}</td>
                    <td style={styles.td}>{row.expiry}</td>
                    <td style={styles.td}>{fmtDateTime(row.openDateTime)}</td>
                    <td style={styles.td}>{fmtDateTime(row.closeDateTime)}</td>
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
            <button style={{ ...styles.closeBtn, display: 'flex', alignItems: 'center' }} onClick={() => setSelected(null)} aria-label="Close trade detail"><CloseIcon size={14} /></button>
          </div>

          {/* KPI strip */}
          <div style={styles.kpiRow}>
            {[
              { label: 'Gain Ratio', value: `${selected.gainRatio?.toFixed(2)}x`,
                color: selected.gainRatio >= 2 ? '#00c853' : selected.gainRatio >= 1 ? '#66bb6a' : '#ef5350' },
              { label: 'P&L', value: holdPnl,
                color: selected.pl >= 0 ? '#00c853' : '#ef5350' },
              { label: 'Buy Price', value: fmt(selected.buyAmount / (selected.buyQty || 1)) + '/contract', color: 'var(--os-text)' },
              { label: 'Sell Price', value: fmt(selected.sellAmount / (selected.sellQty || 1)) + '/contract', color: 'var(--os-text)' },
              { label: 'Buy Time',  value: fmtDateTime(selected.openDateTime),  color: '#1976d2' },
              { label: 'Sell Time', value: fmtDateTime(selected.closeDateTime), color: '#e53935' },
              { label: 'Held',       value: holdDays != null ? `${holdDays}d` : '—', color: 'var(--os-text-2)' },
            ].map(k => (
              <div key={k.label} style={styles.kpi}>
                <div style={styles.kpiLabel}>{k.label}</div>
                <div style={{ ...styles.kpiValue, color: k.color }}>{k.value}</div>
              </div>
            ))}
          </div>

          {/* stock chart */}
          <div style={styles.chartSection}>
            {/* ── settings bar ── */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
              {[['line','Line'],['area','Area'],['candle','Candle']].map(([ct, label]) => (
                <button key={ct} onClick={() => setChartType(ct)} style={{
                  padding: '3px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer', fontWeight: 600,
                  background: chartType === ct ? '#1565c0' : 'var(--os-surface)',
                  color: chartType === ct ? '#fff' : 'var(--os-text-2)',
                  border: chartType === ct ? '1px solid #1565c0' : '1px solid var(--os-border)',
                }}>{label}</button>
              ))}
              <div style={{ width: 1, height: 18, background: 'var(--os-border)', margin: '0 4px' }} />
              <span style={{ fontSize: 11, color: 'var(--os-text-3)' }}>Interval:</span>
              {['auto','1m','5m','15m','1h','1d'].map(iv => (
                <button key={iv} onClick={() => setOI(iv)} style={{
                  padding: '3px 9px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                  background: overrideInterval === iv ? '#ff9800' : 'var(--os-border)',
                  color: overrideInterval === iv ? '#fff' : 'var(--os-text-2)',
                  border: overrideInterval === iv ? '1px solid #ff9800' : '1px solid var(--os-border)',
                  fontWeight: overrideInterval === iv ? 600 : 400,
                }}>{iv}</button>
              ))}
              {history?.interval && (() => {
                const degraded = history.requested_interval && history.interval !== history.requested_interval;
                const providerLabel = history.provider && history.provider !== 'yfinance'
                  ? ` · via ${history.provider}` : '';
                const needsKey = degraded && history.provider === 'yfinance-fallback';
                return (
                  <>
                    <span style={{ fontSize: 10, marginLeft: 4, color: degraded ? '#e53935' : 'var(--os-text-3)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      {degraded
                        ? (<><AlertIcon size={10} /> {history.requested_interval} unavailable → {history.interval}{providerLabel}</>)
                        : `(actual: ${history.interval}${providerLabel})`}
                    </span>
                    {needsKey && (
                      <button onClick={() => setKeysOpen(true)} style={{
                        marginLeft: 8, fontSize: 10, padding: '1px 8px', borderRadius: 4,
                        background: '#fff3e0', border: '1px solid #ff9800', color: '#e65100',
                        cursor: 'pointer', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3,
                      }}>
                        <KeyIcon size={10} /> Add API key for {history.requested_interval} data ↓
                      </button>
                    )}
                  </>
                );
              })()}
            </div>

            <div style={styles.sectionTitle}>
              {selected.ticker} stock price · {history?.interval || '…'} candles
              {loadingHist && <span style={styles.loading}> Loading…</span>}
              {histError && <span style={styles.err}> {histError}</span>}
            </div>

            {chartWithVix.length > 0 && (
              <>
              {priceBrush && (
                <div style={{ textAlign: 'right', marginBottom: 4 }}>
                  <button onClick={() => setPriceBrush(null)} style={styles.resetZoom}>
                    ⟲ Reset zoom
                  </button>
                </div>
              )}
              <ResponsiveContainer width="100%" height={350}>
                <ComposedChart data={chartWithVix} margin={{ top: 14, right: 60, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--os-border)" vertical={false} />
                  <XAxis dataKey="dt"
                    tickFormatter={v => v?.slice(5, 13)}
                    tick={{ fontSize: 9, fill: 'var(--os-text-2)' }} interval="preserveStartEnd"
                    axisLine={false} tickLine={false} />
                  <YAxis yAxisId="price" domain={priceRange}
                    tick={{ fontSize: 9, fill: 'var(--os-text-2)' }} axisLine={false} tickLine={false} width={52}
                    tickFormatter={v => '$' + v.toFixed(2)} />
                  <YAxis yAxisId="vix" orientation="right"
                    tick={{ fontSize: 9, fill: 'var(--os-text-3)' }} axisLine={false} tickLine={false} width={38}
                    tickFormatter={v => v.toFixed(0)} />
                  <Tooltip content={<StockTip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />

                  {/* Area fill under close — area mode only. Exclusive by design:
                      line mode = pure line, area mode = pure fill (no stroke),
                      candle mode = candles. The old high/low shaded band was
                      removed — it read as a stray area plot in line mode and
                      its white "mask" fill broke the night theme. */}
                  {chartType === 'area' && (
                    <Area yAxisId="price" type="monotone" dataKey="close" name="Close"
                      stroke="none" fill="rgba(21,101,192,0.22)"
                      dot={false} connectNulls />
                  )}

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

                  {/* Close line — line mode only (area mode uses Area above, candle skips) */}
                  {chartType === 'line' && (
                    <Line yAxisId="price" type="monotone" dataKey="close" name="Close"
                      stroke="#1565c0" dot={false} strokeWidth={2.5} connectNulls />
                  )}

                  {/* Candlestick SVG layer — a Customized layer is invisible to Recharts'
                      Tooltip (it only reads Line/Area/Bar series), so without a real
                      series here the tooltip has nothing to key hover position off of.
                      This invisible Close line supplies that (and the actual candles) —
                      it's rendered with stroke="none" so only CandlestickLayer is seen. */}
                  {chartType === 'candle' && (
                    <>
                      <Line yAxisId="price" type="monotone" dataKey="close" name="Close"
                        stroke="none" dot={false} activeDot={false} strokeWidth={0} connectNulls
                        isAnimationActive={false} />
                      <Customized component={CandlestickLayer} data={chartWithVix} />
                    </>
                  )}

                  <Line yAxisId="vix" type="monotone" dataKey="vix" name="VIX"
                    stroke="#ff9800" dot={false} strokeWidth={1.5}
                    strokeDasharray="4 2" connectNulls />

                  <Brush dataKey="dt" height={26} travellerWidth={8}
                    stroke="#90caf9" fill="#f0f4ff"
                    startIndex={priceBrush?.startIndex ?? 0}
                    endIndex={priceBrush?.endIndex ?? Math.max(0, chartWithVix.length - 1)}
                    onChange={({ startIndex, endIndex }) => setPriceBrush({ startIndex, endIndex })}
                    tickFormatter={() => ''} />
                </ComposedChart>
              </ResponsiveContainer>
              </>
            )}

            {/* RSI (14) panel */}
            {rsiData.length > 0 && rsiData.some(d => d.rsi !== null) && (
              <div style={{ marginTop: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, paddingLeft: 2 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#7b1fa2' }}>
                    RSI ({chartData.length >= 30 ? 14 : 7}) — overbought &gt;70 · oversold &lt;30
                  </span>
                  {rsiBrush && (
                    <button onClick={() => setRsiBrush(null)} style={styles.resetZoom}>
                      ⟲ Reset zoom
                    </button>
                  )}
                </div>
                <ResponsiveContainer width="100%" height={140}>
                  <ComposedChart data={rsiData} margin={{ top: 4, right: 60, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--os-border)" vertical={false} />
                    <XAxis dataKey="dt" tickFormatter={v => v?.slice(5, 13)}
                      tick={{ fontSize: 9, fill: 'var(--os-text-2)' }} interval="preserveStartEnd"
                      axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} ticks={[30, 50, 70]}
                      tick={{ fontSize: 9, fill: 'var(--os-text-2)' }} axisLine={false} tickLine={false}
                      width={52} tickFormatter={v => v} />
                    <Tooltip formatter={(v) => [v !== null ? v.toFixed(1) : '—', 'RSI']}
                      contentStyle={{ fontSize: 11, borderRadius: 6, padding: '4px 10px' }} />
                    {/* Overbought / oversold shaded zones */}
                    <ReferenceArea y1={70} y2={100} fill="rgba(229,57,53,0.08)" stroke="none" />
                    <ReferenceArea y1={0} y2={30} fill="rgba(0,200,83,0.08)" stroke="none" />
                    <ReferenceLine y={70} stroke="#e53935" strokeDasharray="4 2" strokeWidth={1}
                      label={{ value: 'OB', position: 'insideTopRight', fill: '#e53935', fontSize: 9 }} />
                    <ReferenceLine y={30} stroke="#00c853" strokeDasharray="4 2" strokeWidth={1}
                      label={{ value: 'OS', position: 'insideBottomRight', fill: '#00c853', fontSize: 9 }} />
                    <ReferenceLine y={50} stroke="var(--os-border)" strokeDasharray="2 2" strokeWidth={1} />
                    {/* Mirror buy/sell lines */}
                    {buyDt && <ReferenceLine x={buyDt} stroke="#00c853" strokeWidth={2} strokeDasharray="5 3" />}
                    {sellDt && <ReferenceLine x={sellDt} stroke="#e53935" strokeWidth={2} strokeDasharray="5 3" />}
                    <Line type="monotone" dataKey="rsi" name="RSI"
                      stroke="#7b1fa2" dot={false} strokeWidth={2} connectNulls />

                    <Brush dataKey="dt" height={22} travellerWidth={8}
                      stroke="#ce93d8" fill="#f9f0ff"
                      startIndex={rsiBrush?.startIndex ?? 0}
                      endIndex={rsiBrush?.endIndex ?? Math.max(0, rsiData.length - 1)}
                      onChange={({ startIndex, endIndex }) => setRsiBrush({ startIndex, endIndex })}
                      tickFormatter={() => ''} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
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
                <span style={{ marginLeft: 20, color: 'var(--os-text-3)', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  {vixAtBuy && vixAtBuy.vix > 25
                    ? (<><AlertIcon size={11} /> High VIX at entry — expensive premium</>)
                    : vixAtBuy && vixAtBuy.vix < 15
                    ? (<><TrendDownIcon size={11} /> Low VIX at entry — cheap premium</>)
                    : ''}
                </span>
              </div>
            );
          })()}

          {/* news context */}
          {news?.items?.length > 0 && (
            <div style={styles.newsSection}>
              <div style={styles.sectionTitle}>
                <NewsIcon size={13} /> News Context
                <span style={{ fontWeight: 400, color: 'var(--os-text-3)', fontSize: 11, marginLeft: 8 }}>
                  headlines around your trade dates · may not be historical for older trades
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(news?.items || []).map((n, i) => (
                  <div key={i} style={{
                    display: 'flex', gap: 10, alignItems: 'flex-start',
                    padding: '6px 10px', borderRadius: 6, background: 'var(--os-surface)', color: 'var(--os-text)',
                    border: `1px solid ${n.bucket === 'entry' ? '#c8e6c9' : n.bucket === 'exit' ? '#ffcdd2' : '#f0f0f0'}`,
                  }}>
                    <span style={{
                      fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 10,
                      background: n.bucket === 'entry' ? 'rgba(46,125,50,0.15)' : n.bucket === 'exit' ? 'rgba(198,40,40,0.15)' : 'var(--os-bg)',
                      color:      n.bucket === 'entry' ? '#2e7d32' : n.bucket === 'exit' ? '#c62828' : 'var(--os-text-3)',
                      whiteSpace: 'nowrap', alignSelf: 'center', flexShrink: 0,
                    }}>
                      {n.bucket === 'entry' ? '▲ ENTRY' : n.bucket === 'exit' ? '▼ EXIT' : 'CONTEXT'}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <a href={n.url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 12, color: '#1565c0', textDecoration: 'none', fontWeight: 500 }}>
                        {n.title}
                      </a>
                      <div style={{ fontSize: 10, color: 'var(--os-text-3)', marginTop: 2 }}>
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
                  <ListIcon size={13} /> Your other {selected.ticker} {selected.type} trades
                  <span style={{ fontWeight: 400, color: 'var(--os-text-3)', marginLeft: 8 }}>
                    {similar.length} trades · {wins}W/{similar.length - wins}L · avg {avgGR}x · avg {avgPL >= 0 ? '+' : ''}${Math.abs(avgPL).toLocaleString()}
                  </span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={styles.table}>
                    <thead>
              <tr style={{ borderBottom: '2px solid var(--os-border)' }}>
                        {['Strike','Expiry','Buy Time','Sell Time','Held','Gain','P&L'].map(h => (
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
                              background: selected?.key === s.key ? 'rgba(25,118,210,0.16)' : i % 2 ? 'rgba(127,127,127,0.06)' : 'transparent' }}>
                            <td style={styles.td}>${s.strike}</td>
                            <td style={styles.td}>{s.expiry}</td>
                            <td style={styles.td}>{fmtDateTime(s.openDateTime)}</td>
                            <td style={styles.td}>{fmtDateTime(s.closeDateTime)}</td>
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
            <div style={styles.sectionTitle}><BookIcon size={13} /> Trade Journal</div>
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

          {/* ── Provider API keys panel ── */}
          <div style={styles.keysSection}>
            <button onClick={() => setKeysOpen(o => !o)} style={{ ...styles.keysToggle, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <KeyIcon size={12} /> Intraday Data Provider Keys {keysOpen ? '▲' : '▼'}
              <span style={{ fontWeight: 400, marginLeft: 8, color: 'var(--os-text-3)' }}>
                {alpacaKey ? '· Alpaca ✓' : ''}{polygonKey ? ' · Polygon ✓' : ''}
                {!alpacaKey && !polygonKey ? '· not configured — 1h/5m data uses yfinance fallback' : ''}
              </span>
            </button>

            {keysOpen && (
              <div style={styles.keysBody}>
                <p style={styles.keysInfo}>
                  <strong>Alpaca</strong> (recommended · free) — sign up at <em>alpaca.markets</em> → paper account → API Keys.
                  Gives 1h candles back to 2016 for TSLA, NVDA, SPY and all major US stocks.
                </p>
                <div style={styles.keysRow}>
                  <label style={styles.keysLabel}>Alpaca API Key</label>
                  <input style={styles.keysInput} type="text" placeholder="PK…"
                    value={alpacaKey}
                    onChange={e => { setAlpacaKey(e.target.value); localStorage.setItem('alpaca_key', e.target.value); }} />
                  <label style={styles.keysLabel}>Alpaca Secret</label>
                  <input style={styles.keysInput} type="password" placeholder="••••••••"
                    value={alpacaSecret}
                    onChange={e => { setAlpacaSecret(e.target.value); localStorage.setItem('alpaca_secret', e.target.value); }} />
                </div>

                <p style={{ ...styles.keysInfo, marginTop: 10 }}>
                  <strong>Polygon.io</strong> (backup · free) — free key at <em>polygon.io</em>.
                  Covers ~2 years of 1h data (sufficient for 2023+ trades).
                </p>
                <div style={styles.keysRow}>
                  <label style={styles.keysLabel}>Polygon API Key</label>
                  <input style={styles.keysInput} type="text" placeholder="API key…"
                    value={polygonKey}
                    onChange={e => { setPolygonKey(e.target.value); localStorage.setItem('polygon_key', e.target.value); }} />
                </div>

                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                  <button style={styles.btn} onClick={() => {
                    if (selected) {
                      const openISO  = toISO(selected.openDate);
                      const closeISO = toISO(selected.closeDate);
                      setLH(true); setHE(''); setPriceBrush(null); setRsiBrush(null);
                      setTradeCandles({ buyDt: null, sellDt: null });
                      axios.post(`${API}/api/stock-history`, {
                        ticker: selected.ticker, start_date: openISO, end_date: closeISO,
                        interval: overrideInterval, force_refresh: true, ...providerKeys(),
                      }).then(r => {
                        setHistory(r.data);
                        const layout = computeTradeChartLayout(r.data?.ohlcv, openISO, closeISO, r.data?.interval, selected.openDateTime, selected.closeDateTime);
                        setPriceBrush(layout.brush);
                        setTradeCandles({ buyDt: layout.buyDt, sellDt: layout.sellDt });
                        setRsiBrush(null);
                      }).catch(e => setHE(e?.response?.data?.error || e.message))
                        .finally(() => setLH(false));
                    }
                  }}>
                    ↻ Re-fetch with new keys
                  </button>
                  <span style={{ fontSize: 11, color: 'var(--os-text-3)', alignSelf: 'center' }}>
                    Keys are saved in your browser — never sent anywhere except directly to the provider API.
                  </span>
                </div>
              </div>
            )}
          </div>

        </div>
      )}

      <TradingNotes />
    </div>
  );
}

// ── styles ─────────────────────────────────────────────────────────────────────

const styles = {
  // Theme-aware via index.css tokens (--os-*) — flips with the day/night
  // toggle instead of inheriting body text onto hardcoded white surfaces,
  // which rendered white-on-white in night mode.
  root: {
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    background: 'var(--os-bg)', color: 'var(--os-text)', minHeight: '100vh', padding: '0 0 60px',
    transition: 'background .25s ease, color .25s ease',
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
    padding: '14px 24px', background: 'var(--os-surface)', borderBottom: '1px solid var(--os-border)',
  },
  filterRow: {
    display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap',
    padding: '10px 24px', background: 'var(--os-surface)', borderBottom: '1px solid var(--os-border)',
  },
  filterLabel: { fontSize: 12, color: 'var(--os-text-2)', display: 'flex', alignItems: 'center', gap: 6 },
  inp: {
    padding: '7px 10px', border: '1px solid var(--os-border)', borderRadius: 6,
    fontSize: 13, outline: 'none', width: 200,
    background: 'var(--os-surface)', color: 'var(--os-text)',
  },
  sel: {
    padding: '6px 8px', border: '1px solid var(--os-border)', borderRadius: 6,
    fontSize: 13, outline: 'none', cursor: 'pointer',
    background: 'var(--os-surface)', color: 'var(--os-text)',
  },
  btn: {
    padding: '7px 16px', background: '#1976d2', color: '#fff',
    border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 500,
  },
  gearBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '7px 12px', background: 'var(--os-surface)', color: 'var(--os-text-2)',
    border: '1px solid var(--os-border)', borderRadius: 6, cursor: 'pointer', fontSize: 13,
  },
  err:  { fontSize: 12, color: '#e53935' },
  ok:   { fontSize: 12, color: '#00a844' },
  card: {
    margin: '16px 24px 0', background: 'var(--os-surface)', borderRadius: 8,
    padding: '14px 16px', boxShadow: 'var(--os-shadow-1)',
  },
  cardTitle: { fontSize: 13, fontWeight: 600, color: 'var(--os-text)', marginBottom: 10 },
  empty: {
    margin: '60px auto', textAlign: 'center', color: 'var(--os-text-3)', fontSize: 15,
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
  table:   { width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--os-text)' },
  th:      { padding: '6px 10px', textAlign: 'left', fontSize: 10, color: 'var(--os-text-3)',
             textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 },
  tr:      { transition: 'background 0.1s', borderBottom: '1px solid var(--os-border)' },
  td:      { padding: '7px 10px', whiteSpace: 'nowrap', color: 'var(--os-text)' },
  loading: { color: '#1976d2', fontSize: 12 },
  detailPanel: {
    margin: '16px 24px 0', background: 'var(--os-surface)', borderRadius: 8,
    boxShadow: 'var(--os-shadow-2)', overflow: 'hidden',
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
    borderBottom: '1px solid var(--os-border)',
  },
  kpi: {
    flex: '1 1 120px', padding: '12px 20px',
    borderRight: '1px solid var(--os-border)',
  },
  kpiLabel: { fontSize: 10, color: 'var(--os-text-3)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.5 },
  kpiValue: { fontSize: 16, fontWeight: 700, color: 'var(--os-text)' },
  chartSection: { padding: '16px 20px' },
  sectionTitle: { fontSize: 13, fontWeight: 600, color: 'var(--os-text-2)', marginBottom: 10 },
  vixContext: {
    padding: '10px 20px 14px', background: 'var(--os-bg)',
    borderTop: '1px solid var(--os-border)', fontSize: 13, color: 'var(--os-text)',
  },
  newsSection:    { padding: '14px 20px', borderTop: '1px solid var(--os-border)', background: 'var(--os-surface)' },
  similarSection: { padding: '14px 20px', borderTop: '1px solid var(--os-border)', background: 'var(--os-bg)' },
  journalSection: { padding: '16px 20px 20px', borderTop: '1px solid var(--os-border)' },
  resetZoom: {
    fontSize: 11, padding: '2px 10px', borderRadius: 4, cursor: 'pointer',
    background: '#e3f2fd', border: '1px solid #90caf9', color: '#1565c0', fontWeight: 600,
  },
  keysSection: { borderTop: '1px solid var(--os-border)', background: 'var(--os-bg)' },
  keysToggle: {
    width: '100%', textAlign: 'left', padding: '12px 20px',
    background: 'none', border: 'none', cursor: 'pointer',
    fontSize: 13, fontWeight: 600, color: 'var(--os-text-2)',
  },
  keysBody: { padding: '0 20px 16px', display: 'flex', flexDirection: 'column', gap: 4 },
  keysInfo: { fontSize: 12, color: 'var(--os-text-2)', margin: '4px 0' },
  keysRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  keysLabel: { fontSize: 11, color: 'var(--os-text-3)', whiteSpace: 'nowrap' },
  keysInput: {
    flex: '1 1 200px', padding: '5px 10px', fontSize: 12,
    border: '1px solid var(--os-border)', borderRadius: 6,
    outline: 'none', background: 'var(--os-surface)', color: 'var(--os-text)',
    fontFamily: 'monospace',
  },
  journalGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 },
  journalLabel: { display: 'flex', flexDirection: 'column', gap: 4 },
  journalQ: { fontSize: 12, fontWeight: 600, color: 'var(--os-text-2)' },
  journalTA: {
    resize: 'vertical', border: '1px solid var(--os-border)', borderRadius: 6,
    padding: '8px 10px', fontSize: 12, fontFamily: 'inherit', color: 'var(--os-text)',
    outline: 'none', background: 'var(--os-bg)', lineHeight: 1.5,
  },
};
