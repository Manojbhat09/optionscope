// src/components/PnLCalendar.js
import React, { useMemo, useState } from 'react';
import CalendarHeatmap from 'react-calendar-heatmap';
import 'react-calendar-heatmap/dist/styles.css';
import {
  Bar, BarChart, CartesianGrid, Cell, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import './PnLCalendar.css';

// ── helpers ───────────────────────────────────────────────────────────────────

function parseAmount(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  if (typeof raw === 'number') return raw;
  const s = String(raw).replace(/"/g, '').trim();
  if (!s || s === 'nan' || s === 'None') return 0;
  const neg = s.startsWith('(') && s.endsWith(')');
  const num = parseFloat(s.replace(/[^0-9.-]/g, '')) || 0;
  return neg ? -num : num;
}

function fmt(n, compact = false) {
  if (n === undefined || n === null || isNaN(n)) return '$0';
  if (compact && Math.abs(n) >= 1000)
    return (n < 0 ? '-$' : '$') + (Math.abs(n) / 1000).toFixed(1) + 'k';
  return (n >= 0 ? '$' : '-$') + Math.abs(n).toFixed(2);
}

function toDateStr(v) {
  if (!v) return null;
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch { return null; }
}

function weekStart(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay() || 7;           // Mon=1
  d.setDate(d.getDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

function monthLabel(key) {                // "2024-03" → "Mar '24"
  const [y, m] = key.split('-');
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1] + " '" + y.slice(2);
}
function weekLabel(key) {                 // "2024-03-04" → "Mar 4"
  const d = new Date(key);
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + ' ' + d.getDate();
}

// ── aggregation ───────────────────────────────────────────────────────────────

function aggregateTrades(trades, startDate, endDate) {
  const start = startDate ? new Date(startDate) : null;
  const end   = endDate   ? new Date(endDate)   : null;

  // Group by position key first to compute per-trade P&L
  const positions = {};
  trades.forEach(t => {
    const amount = parseAmount(t['Amount']);
    if (amount === 0) return;

    const date = toDateStr(t['Activity Date']);
    if (!date) return;
    const d = new Date(date);
    if (start && d < start) return;
    if (end   && d > end)   return;

    const code = (t['Trans Code'] || '').toUpperCase();
    const key  = t['Description'] || date;

    if (!positions[key]) positions[key] = { date, bto: 0, stc: 0, description: key };
    if      (code === 'BTO')  positions[key].bto += amount;  // debit
    else if (code === 'STC')  positions[key].stc += amount;  // credit
    else if (code === 'OEXP') positions[key].oexp = true;     // expired worthless
    else                      positions[key].stc += amount;   // treat other codes as credit
  });

  // Aggregate P&L by day
  const byDay = {};
  Object.values(positions).forEach(pos => {
    const date = pos.date;
    const pnl  = pos.oexp ? -pos.bto : pos.stc - pos.bto;

    if (!byDay[date]) byDay[date] = { date, pnl: 0, trades: 0, wins: 0, losses: 0 };
    byDay[date].pnl    += pnl;
    byDay[date].trades += 1;
  });

  // Mark wins/losses at day level
  Object.values(byDay).forEach(d => {
    if (d.pnl > 0)      { d.wins   = 1; d.losses = 0; }
    else if (d.pnl < 0) { d.wins   = 0; d.losses = 1; }
  });

  return byDay;
}

function rollup(byDay, keyFn, labelFn) {
  const map = {};
  Object.values(byDay).forEach(d => {
    const k = keyFn(d.date);
    if (!map[k]) map[k] = { key: k, label: labelFn(k), pnl: 0, trades: 0, wins: 0, losses: 0 };
    map[k].pnl    += d.pnl;
    map[k].trades += d.trades;
    if (d.pnl > 0) map[k].wins   += 1;
    else           map[k].losses += 1;
  });
  return Object.values(map).sort((a, b) => a.key.localeCompare(b.key));
}

// ── share on X ────────────────────────────────────────────────────────────────

function shareOnX(rows, label) {
  const total = rows.reduce((s, r) => s + r.pnl, 0);
  const wins  = rows.filter(r => r.pnl > 0).length;
  const wr    = rows.length ? ((wins / rows.length) * 100).toFixed(0) : 0;
  const sign  = total >= 0 ? '🟢' : '🔴';
  const text  = encodeURIComponent(
    `${sign} ${label} P&L: ${fmt(total)}\n` +
    `Win rate: ${wr}% (${wins}/${rows.length} periods)\n` +
    `#TradingJournal #OptionsTrading #PnL`
  );
  window.open(`https://x.com/intent/tweet?text=${text}`, '_blank', 'width=600,height=400');
}

// ── custom tooltip ────────────────────────────────────────────────────────────

const BarTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const v = payload[0].payload;
  return (
    <div className="pnl-bar-tooltip">
      <strong>{v.label || label}</strong>
      <div style={{ color: v.pnl >= 0 ? '#00c853' : '#ff1744' }}>{fmt(v.pnl)}</div>
      <div className="pnl-bar-tooltip-sub">{v.trades} trades · {v.wins}W / {v.losses}L</div>
    </div>
  );
};

// ── heatmap cell colour ───────────────────────────────────────────────────────

function heatColor(value, max) {
  if (!value || value.pnl === 0) return '#e0e0e0';
  const ratio = Math.min(Math.abs(value.pnl) / (max || 1), 1);
  if (value.pnl > 0) {
    const g = Math.round(100 + 155 * ratio);
    return `rgb(0,${g},0)`;
  }
  const r = Math.round(100 + 155 * ratio);
  return `rgb(${r},0,0)`;
}

// ── monthly grid component ────────────────────────────────────────────────────

function MonthGrid({ monthRows }) {
  const maxAbs = useMemo(() => Math.max(...monthRows.map(r => Math.abs(r.pnl)), 1), [monthRows]);

  // Group by year
  const byYear = useMemo(() => {
    const map = {};
    monthRows.forEach(r => {
      const yr = r.key.slice(0, 4);
      if (!map[yr]) map[yr] = {};
      const mo = parseInt(r.key.slice(5, 7), 10) - 1; // 0-indexed
      map[yr][mo] = r;
    });
    return map;
  }, [monthRows]);

  const years = Object.keys(byYear).sort();
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  return (
    <div className="pnl-month-grid-section">
      <div className="pnl-heatmap-label">Monthly P&amp;L Grid</div>
      {years.map(yr => (
        <div key={yr} className="pnl-month-year-row">
          <span className="pnl-month-year-label">{yr}</span>
          <div className="pnl-month-cells">
            {MONTH_NAMES.map((name, mo) => {
              const cell = byYear[yr][mo];
              if (!cell) {
                return (
                  <div key={mo} className="pnl-month-cell empty">
                    <span className="pnl-month-name">{name}</span>
                  </div>
                );
              }
              const ratio = Math.min(Math.abs(cell.pnl) / maxAbs, 1);
              const bg = cell.pnl > 0
                ? `rgba(0, ${Math.round(130 + 125 * ratio)}, 60, ${0.25 + 0.75 * ratio})`
                : `rgba(${Math.round(180 + 75 * ratio)}, 30, 30, ${0.25 + 0.75 * ratio})`;
              const textColor = ratio > 0.4 ? '#fff' : (cell.pnl > 0 ? '#005a1f' : '#7a0000');
              return (
                <div key={mo} className="pnl-month-cell" style={{ background: bg, color: textColor }}
                  title={`${name} ${yr}: ${fmt(cell.pnl)} | ${cell.trades} trades | ${cell.wins}W/${cell.losses}L`}>
                  <span className="pnl-month-name">{name}</span>
                  <span className="pnl-month-amount">{fmt(cell.pnl, true)}</span>
                  <span className="pnl-month-wr">{cell.trades}t · {cell.wins}W</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="pnl-legend" style={{ marginTop: 10 }}>
        <span>Loss</span>
        {['rgba(200,30,30,0.9)','rgba(200,30,30,0.45)','#e0e0e0','rgba(0,180,60,0.45)','rgba(0,200,60,0.9)'].map((c, i) => (
          <span key={i} style={{ display:'inline-block', width:14, height:14, background:c, borderRadius:3, verticalAlign:'middle' }} />
        ))}
        <span>Gain</span>
      </div>
    </div>
  );
}

// ── weekly grid component ─────────────────────────────────────────────────────

function WeekGrid({ weekRows }) {
  const maxAbs = useMemo(() => Math.max(...weekRows.map(r => Math.abs(r.pnl)), 1), [weekRows]);

  // Group by year
  const byYear = useMemo(() => {
    const map = {};
    weekRows.forEach(r => {
      const yr = r.key.slice(0, 4);
      if (!map[yr]) map[yr] = [];
      map[yr].push(r);
    });
    return map;
  }, [weekRows]);

  const years = Object.keys(byYear).sort();

  return (
    <div className="pnl-month-grid-section">
      <div className="pnl-heatmap-label">Weekly P&amp;L Grid</div>
      {years.map(yr => (
        <div key={yr} className="pnl-week-year-row">
          <span className="pnl-month-year-label">{yr}</span>
          <div className="pnl-week-cells">
            {byYear[yr].map((r, i) => {
              const ratio = Math.min(Math.abs(r.pnl) / maxAbs, 1);
              const bg = r.pnl > 0
                ? `rgba(0, ${Math.round(130 + 125 * ratio)}, 60, ${0.25 + 0.75 * ratio})`
                : `rgba(${Math.round(180 + 75 * ratio)}, 30, 30, ${0.25 + 0.75 * ratio})`;
              const textColor = ratio > 0.4 ? '#fff' : (r.pnl > 0 ? '#005a1f' : '#7a0000');
              return (
                <div key={i} className="pnl-week-cell" style={{ background: bg, color: textColor }}
                  title={`Week of ${r.key}: ${fmt(r.pnl)} | ${r.trades} trades | ${r.wins}W/${r.losses}L`}>
                  <span className="pnl-week-label">{r.label}</span>
                  <span className="pnl-week-amount">{fmt(r.pnl, true)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="pnl-legend" style={{ marginTop: 10 }}>
        <span>Loss</span>
        {['rgba(200,30,30,0.9)','rgba(200,30,30,0.45)','#e0e0e0','rgba(0,180,60,0.45)','rgba(0,200,60,0.9)'].map((c, i) => (
          <span key={i} style={{ display:'inline-block', width:14, height:14, background:c, borderRadius:3, verticalAlign:'middle' }} />
        ))}
        <span>Gain</span>
      </div>
    </div>
  );
}

// ── yearly grid component ─────────────────────────────────────────────────────

function YearGrid({ yearRows }) {
  const maxAbs = useMemo(() => Math.max(...yearRows.map(r => Math.abs(r.pnl)), 1), [yearRows]);

  return (
    <div className="pnl-month-grid-section">
      <div className="pnl-heatmap-label">Yearly P&amp;L Grid</div>
      <div className="pnl-year-cells">
        {yearRows.map((r, i) => {
          const ratio = Math.min(Math.abs(r.pnl) / maxAbs, 1);
          const bg = r.pnl > 0
            ? `rgba(0, ${Math.round(130 + 125 * ratio)}, 60, ${0.25 + 0.75 * ratio})`
            : `rgba(${Math.round(180 + 75 * ratio)}, 30, 30, ${0.25 + 0.75 * ratio})`;
          const textColor = ratio > 0.35 ? '#fff' : (r.pnl > 0 ? '#005a1f' : '#7a0000');
          return (
            <div key={i} className="pnl-year-cell" style={{ background: bg, color: textColor }}
              title={`${r.key}: ${fmt(r.pnl)} | ${r.trades} trades | ${r.wins}W/${r.losses}L`}>
              <span className="pnl-year-label">{r.key}</span>
              <span className="pnl-year-amount">{fmt(r.pnl, true)}</span>
              <span className="pnl-year-sub">{r.trades} trades · {r.wins}W / {r.losses}L</span>
            </div>
          );
        })}
      </div>
      <div className="pnl-legend" style={{ marginTop: 10 }}>
        <span>Loss</span>
        {['rgba(200,30,30,0.9)','rgba(200,30,30,0.45)','#e0e0e0','rgba(0,180,60,0.45)','rgba(0,200,60,0.9)'].map((c, i) => (
          <span key={i} style={{ display:'inline-block', width:14, height:14, background:c, borderRadius:3, verticalAlign:'middle' }} />
        ))}
        <span>Gain</span>
      </div>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

const VIEWS = ['Daily', 'Weekly', 'Monthly', 'Yearly'];

export default function PnLCalendar({ trades }) {
  // detect data range
  const dataRange = useMemo(() => {
    const dates = trades
      .map(t => toDateStr(t['Activity Date']))
      .filter(Boolean)
      .sort();
    if (!dates.length) return { min: '', max: '' };
    return { min: dates[0], max: dates[dates.length - 1] };
  }, [trades]);

  const [view, setView]           = useState('Monthly');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate]     = useState('');
  const [tooltip, setTooltip]     = useState(null);  // for heatmap only

  // sync pickers to data range once data arrives
  const effectiveStart = startDate || dataRange.min;
  const effectiveEnd   = endDate   || dataRange.max;

  // ── aggregated data ─────────────────────────────────────────────────────────
  const byDay = useMemo(
    () => aggregateTrades(trades, effectiveStart, effectiveEnd),
    [trades, effectiveStart, effectiveEnd]
  );

  const dayRows   = useMemo(() => Object.values(byDay).sort((a,b) => a.date.localeCompare(b.date)).map(d => ({ ...d, label: d.date })), [byDay]);
  const weekRows  = useMemo(() => rollup(byDay, d => weekStart(d), weekLabel), [byDay]);
  const monthRows = useMemo(() => rollup(byDay, d => d.slice(0,7), monthLabel), [byDay]);
  const yearRows  = useMemo(() => rollup(byDay, d => d.slice(0,4), k => k), [byDay]);

  const chartRows = { Daily: dayRows, Weekly: weekRows, Monthly: monthRows, Yearly: yearRows }[view];
  const maxPnl    = useMemo(() => Math.max(...dayRows.map(d => Math.abs(d.pnl)), 1), [dayRows]);

  // ── summary stats ───────────────────────────────────────────────────────────
  const total   = chartRows.reduce((s, r) => s + r.pnl, 0);
  const wins    = chartRows.filter(r => r.pnl > 0).length;
  const losses  = chartRows.filter(r => r.pnl < 0).length;
  const bigWin  = chartRows.reduce((best, r) => r.pnl > best.pnl ? r : best, { pnl: 0, label: '—' });
  const bigLoss = chartRows.reduce((worst, r) => r.pnl < worst.pnl ? r : worst, { pnl: 0, label: '—' });

  const noData = !trades.length;
  const noFiltered = !chartRows.length;

  // ── x-axis label density ────────────────────────────────────────────────────
  const xInterval = chartRows.length > 60 ? Math.floor(chartRows.length / 20)
                  : chartRows.length > 20 ? 2 : 0;

  const shareLabel = `${view} (${effectiveStart} → ${effectiveEnd})`;

  return (
    <div className="pnl-calendar-root">
      {/* ── header ── */}
      <div className="pnl-calendar-header">
        <span className="pnl-title">📅 P&amp;L Calendar</span>

        {/* date pickers */}
        <div className="pnl-pickers">
          <label>From
            <input type="date" value={effectiveStart} min={dataRange.min} max={effectiveEnd}
              onChange={e => setStartDate(e.target.value)} />
          </label>
          <label>To
            <input type="date" value={effectiveEnd} min={effectiveStart} max={dataRange.max}
              onChange={e => setEndDate(e.target.value)} />
          </label>
          {(startDate || endDate) && (
            <button className="cal-reset-btn" onClick={() => { setStartDate(''); setEndDate(''); }}>
              Reset
            </button>
          )}
        </div>

        {/* view tabs */}
        <div className="pnl-view-tabs">
          {VIEWS.map(v => (
            <button key={v} className={`cal-view-btn ${view === v ? 'active' : ''}`}
              onClick={() => setView(v)}>
              {v}
            </button>
          ))}
          {!noFiltered && (
            <button className="cal-share-btn"
              onClick={() => shareOnX(chartRows, shareLabel)}
              title="Share on X (Twitter)">
              Share 𝕏
            </button>
          )}
        </div>
      </div>

      {/* ── no data state ── */}
      {noData && (
        <div className="pnl-empty">
          <span>📊</span>
          <p>No trading data loaded yet.</p>
          <p style={{ fontSize: 13 }}>Enter your credentials above and click <strong>Fetch Data</strong>.</p>
        </div>
      )}

      {!noData && noFiltered && (
        <div className="pnl-empty">
          <span>🔍</span>
          <p>No trades with P&amp;L in the selected date range.</p>
        </div>
      )}

      {!noData && !noFiltered && (<>

        {/* ── stat cards ── */}
        <div className="pnl-stats-row">
          {[
            { label: `${view} Total P&L`,       value: fmt(total, true),       color: total >= 0 ? 'green' : 'red' },
            { label: 'Profitable Periods',      value: `${wins}`,              color: 'green' },
            { label: 'Losing Periods',          value: `${losses}`,            color: 'red' },
            { label: 'Win Rate',                value: chartRows.length ? `${((wins/chartRows.length)*100).toFixed(0)}%` : '—', color: 'neutral' },
            { label: 'Best Period',             value: bigWin.pnl  ? `${bigWin.label} · ${fmt(bigWin.pnl, true)}`   : '—', color: 'green' },
            { label: 'Worst Period',            value: bigLoss.pnl ? `${bigLoss.label} · ${fmt(bigLoss.pnl, true)}` : '—', color: 'red'   },
          ].map(({ label, value, color }) => (
            <div key={label} className="pnl-stat-card">
              <div className="pnl-stat-label">{label}</div>
              <div className={`pnl-stat-value ${color}`}>{value}</div>
            </div>
          ))}
        </div>

        {/* ── bar chart ── */}
        <div className="pnl-chart-wrap">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartRows} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}
              barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: '#888' }}
                interval={xInterval}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={v => fmt(v, true)}
                tick={{ fontSize: 10, fill: '#888' }}
                axisLine={false}
                tickLine={false}
                width={54}
              />
              <Tooltip content={<BarTooltip />} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
              <ReferenceLine y={0} stroke="#ccc" strokeWidth={1} />
              <Bar dataKey="pnl" radius={[3, 3, 0, 0]} maxBarSize={40}>
                {chartRows.map((r, i) => (
                  <Cell key={i} fill={r.pnl >= 0 ? '#00c853' : '#ff1744'} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* ── grids below bar chart ── */}
        {view === 'Monthly' && monthRows.length > 0 && (
          <MonthGrid monthRows={monthRows} />
        )}
        {view === 'Weekly' && weekRows.length > 0 && (
          <WeekGrid weekRows={weekRows} />
        )}
        {view === 'Yearly' && yearRows.length > 0 && (
          <YearGrid yearRows={yearRows} />
        )}

        {/* ── daily heatmap (only in Daily view) ── */}
        {view === 'Daily' && effectiveStart && effectiveEnd && (
          <div className="pnl-heatmap-section">
            <div className="pnl-heatmap-label">Heatmap · {effectiveStart} → {effectiveEnd}</div>
            <div className="pnl-heatmap-wrap" onMouseLeave={() => setTooltip(null)}>
              <CalendarHeatmap
                startDate={effectiveStart}
                endDate={effectiveEnd}
                values={dayRows}
                classForValue={() => 'pnl-cell'}
                transformDayElement={(el, value) => {
                  if (!value) return el;
                  return React.cloneElement(el, {
                    style: { fill: heatColor(value, maxPnl), cursor: 'pointer' },
                    onMouseEnter: e => setTooltip({ x: e.clientX, y: e.clientY, data: value }),
                    onMouseMove:  e => setTooltip(t => t ? { ...t, x: e.clientX, y: e.clientY } : t),
                  });
                }}
                showWeekdayLabels
              />
            </div>

            {/* legend */}
            <div className="pnl-legend">
              <span>Loss</span>
              {['#b30000','#e06060','#e0e0e0','#60c060','#006600'].map((c, i) => (
                <span key={i} style={{
                  display: 'inline-block', width: 13, height: 13,
                  background: c, borderRadius: 3, verticalAlign: 'middle'
                }} />
              ))}
              <span>Gain</span>
            </div>
          </div>
        )}

        {/* heatmap tooltip */}
        {tooltip && tooltip.data && (
          <div className="pnl-tooltip" style={{ left: tooltip.x + 14, top: tooltip.y - 70 }}>
            <strong>{tooltip.data.date}</strong><br />
            P&amp;L: <span style={{ color: tooltip.data.pnl >= 0 ? '#00c853' : '#ff1744' }}>
              {fmt(tooltip.data.pnl)}
            </span><br />
            Trades: {tooltip.data.trades} &nbsp;·&nbsp; W: {tooltip.data.wins} / L: {tooltip.data.losses}
          </div>
        )}
      </>)}
    </div>
  );
}
