// src/components/spotreplay/CandleChart.js
//
// Inline-SVG candlestick chart for the Spot Replay report — a React port of
// the static crwd_analysis_report.html chart so the interactive page looks
// identical to the reports it replaces. Renders:
//   - last `window` daily candles (green up / red down)
//   - SMA20 overlay
//   - dashed strike line + breakeven line
//   - GB (orange) / RF (violet) / ARIMA (blue) forecast paths extending right
// No charting library: pure SVG, same as the static report.

import React, { useMemo } from 'react';
import { C } from './reportTheme';

const CHART_W = 940;
const CHART_H = 340;
const PAD = { top: 14, right: 86, bottom: 26, left: 8 };
const FORECAST_EXT = 64; // px of runway to the right of the last candle for forecasts

export default function CandleChart({ analysis, window: windowN = 60 }) {
  const { chart, position, ml, arima } = analysis;
  const n = Math.min(windowN, chart.dates.length);
  const start = chart.dates.length - n;

  // ── scales ────────────────────────────────────────────────────────────────
  const loHi = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (let i = start; i < chart.lows.length; i++) {
      lo = Math.min(lo, chart.lows[i]);
      hi = Math.max(hi, chart.highs[i]);
    }
    // Include strike/breakeven/forecast endpoints so reference lines never clip.
    const extras = [
      position.strike, position.breakeven,
      ...(ml?.GradientBoosting?.path || []),
      ...(ml?.RandomForest?.path || []),
      ...(arima?.forecast || []),
      ...(arima?.ci95_lower || []), ...(arima?.ci95_upper || []),
    ].filter(v => v != null && isFinite(v));
    for (const v of extras) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const padY = (hi - lo) * 0.06 || 1;
    return [lo - padY, hi + padY];
  }, [chart, start, position, ml, arima]);

  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = CHART_H - PAD.top - PAD.bottom;
  const x = i => PAD.left + (i / Math.max(1, n - 1)) * (innerW - FORECAST_EXT);
  const y = v => PAD.top + (1 - (v - loHi[0]) / (loHi[1] - loHi[0])) * innerH;

  const candleW = Math.max(2.5, ((innerW - FORECAST_EXT) / n) * 0.62);

  // Forecast projection geometry: each path starts at the last close and steps
  // one day per point across the extension runway.
  const forecastLines = useMemo(() => {
    const lines = [];
    const addPath = (pts, color, name) => {
      if (!pts || pts.length < 2) return;
      const x0 = x(n - 1);
      const step = pts.length > 1 ? FORECAST_EXT / (pts.length - 1) : FORECAST_EXT;
      const d = pts.map((v, j) => `${j === 0 ? 'M' : 'L'} ${x0 + j * step} ${y(v)}`).join(' ');
      lines.push({ d, color, name, lastX: x0 + (pts.length - 1) * step, lastV: pts[pts.length - 1] });
    };
    addPath(ml?.GradientBoosting?.path, C.orange, 'GB');
    addPath(ml?.RandomForest?.path, C.violet, 'RF');
    addPath(arima?.forecast && [chart.closes[chart.closes.length - 1], ...arima.forecast], C.blue, 'ARIMA');
    return lines;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ml, arima, chart.closes, n, loHi[0], loHi[1]]);

  // Gridlines: 5 evenly spaced price levels with labels.
  const gridLevels = useMemo(() => {
    const levels = [];
    for (let g = 0; g <= 4; g++) {
      const v = loHi[0] + ((loHi[1] - loHi[0]) * g) / 4;
      levels.push({ v, yy: y(v) });
    }
    return levels;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loHi[0], loHi[1]]);

  // Sparse date ticks (~6).
  const dateTicks = useMemo(() => {
    const step = Math.max(1, Math.floor(n / 6));
    const ticks = [];
    for (let i = 0; i < n; i += step) {
      ticks.push({ i, label: (chart.dates[start + i] || '').slice(5) });
    }
    return ticks;
  }, [chart.dates, n, start]);

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={CHART_W} height={CHART_H} style={{ display: 'block' }} role="img"
           aria-label={`${position.ticker} price history with strike and model forecasts`}>
        {/* gridlines + right-side price axis */}
        {gridLevels.map((g, gi) => (
          <g key={gi}>
            <line x1={PAD.left} x2={PAD.left + innerW} y1={g.yy} y2={g.yy}
                  stroke={C.gridline} strokeWidth="1" />
            <text x={PAD.left + innerW + 6} y={g.yy + 3.5}
                  fontSize="10" fill={C.textMuted} fontVariantNumeric="tabular-nums">
              ${g.v.toFixed(0)}
            </text>
          </g>
        ))}

        {/* candles */}
        {Array.from({ length: n }, (_, k) => {
          const i = start + k;
          const o = chart.opens[i], cl = chart.closes[i];
          const h = chart.highs[i], l = chart.lows[i];
          const up = cl >= o;
          const col = up ? C.green : C.red;
          const cx = x(k);
          const bodyTop = y(Math.max(o, cl));
          const bodyH = Math.max(1, Math.abs(y(o) - y(cl)));
          return (
            <g key={i}>
              <line x1={cx} x2={cx} y1={y(h)} y2={y(l)} stroke={col} strokeWidth="1" />
              <rect x={cx - candleW / 2} y={bodyTop} width={candleW} height={bodyH}
                    fill={col} rx={candleW > 4 ? 1 : 0} />
            </g>
          );
        })}

        {/* SMA20 overlay */}
        <polyline
          points={chart.sma20.map((v, i) => (v == null ? '' : `${x(i - start)},${y(v)}`))
            .filter(Boolean).join(' ')}
          fill="none" stroke={C.textMuted} strokeWidth="1.2" strokeOpacity="0.7"
        />

        {/* strike + breakeven reference lines */}
        <line x1={PAD.left} x2={PAD.left + innerW} y1={y(position.strike)} y2={y(position.strike)}
              stroke={C.critical} strokeWidth="1.4" strokeDasharray="6 4" />
        <text x={PAD.left + 4} y={y(position.strike) - 5} fontSize="10.5" fontWeight="700" fill={C.critical}>
          STRIKE ${position.strike.toFixed(0)}
        </text>
        <line x1={PAD.left} x2={PAD.left + innerW} y1={y(position.breakeven)} y2={y(position.breakeven)}
              stroke={C.orange} strokeWidth="1.2" strokeDasharray="3 4" />
        <text x={PAD.left + 4} y={y(position.breakeven) - 5} fontSize="10" fill={C.orange}>
          breakeven ${position.breakeven.toFixed(2)}
        </text>

        {/* model forecast projections */}
        {forecastLines.map(fl => (
          <g key={fl.name}>
            <path d={fl.d} fill="none" stroke={fl.color} strokeWidth="1.8"
                  strokeDasharray="5 4" strokeLinecap="round" />
            <circle cx={fl.lastX} cy={y(fl.lastV)} r="3" fill={fl.color} />
            <text x={Math.min(fl.lastX + 5, CHART_W - 40)} y={y(fl.lastV) + 3.5}
                  fontSize="10" fontWeight="700" fill={fl.color}>
              {fl.name}
            </text>
          </g>
        ))}

        {/* date axis */}
        <line x1={PAD.left} x2={PAD.left + innerW} y1={PAD.top + innerH} y2={PAD.top + innerH}
              stroke={C.baseline} />
        {dateTicks.map(t => (
          <text key={t.i} x={x(t.i)} y={PAD.top + innerH + 16} fontSize="9.5"
                fill={C.textMuted} textAnchor="middle">{t.label}</text>
        ))}
      </svg>

      {/* legend */}
      <div style={{ display: 'flex', gap: 14, fontSize: 11, color: C.textSecondary, flexWrap: 'wrap', marginTop: 4 }}>
        {[['GB forecast', C.orange], ['RF forecast', C.violet], ['ARIMA forecast', C.blue],
          ['SMA20', C.textMuted]].map(([label, col]) => (
          <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 16, height: 0, borderTop: `2px dashed ${col}`, display: 'inline-block' }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
