// src/components/spotreplay/MCHistogram.js
//
// Inline-SVG histogram of the blended 8-regime Monte Carlo final-price
// distribution — React port of the static report's chart. Bars in the ITM zone
// (below strike for puts, above for calls) are red; the rest are blue. A dashed
// strike line marks the boundary, with the ensemble P(ITM) annotated.

import React, { useMemo } from 'react';
import { C } from './reportTheme';

const W = 940;
const H = 220;
const PAD = { top: 16, right: 86, bottom: 24, left: 8 };
const BINS = 50;

export default function MCHistogram({ analysis }) {
  const { monte_carlo: mc, position } = analysis;
  const sample = mc.blended_sample || [];
  const isPut = position.option_type === 'Put';

  const bars = useMemo(() => {
    if (!sample.length) return [];
    const lo = Math.min(...sample);
    const hi = Math.max(...sample);
    const binW = (hi - lo) / BINS || 1;
    const counts = new Array(BINS).fill(0);
    for (const v of sample) {
      const b = Math.min(BINS - 1, Math.floor((v - lo) / binW));
      counts[b] += 1;
    }
    const maxC = Math.max(...counts, 1);
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    return counts.map((cnt, b) => {
      const midPrice = lo + (b + 0.5) * binW;
      // ITM zone: below strike for a put, above for a call.
      const itm = isPut ? midPrice <= position.strike : midPrice >= position.strike;
      return {
        x: PAD.left + (b / BINS) * innerW,
        w: innerW / BINS - 1,
        h: (cnt / maxC) * innerH,
        itm,
        price: midPrice,
      };
    });
  }, [sample, isPut, position.strike]);

  if (!bars.length) return null;

  const innerH = H - PAD.top - PAD.bottom;
  const baseY = PAD.top + innerH;
  const strikeX = (() => {
    const lo = Math.min(...sample), hi = Math.max(...sample);
    const t = (position.strike - lo) / ((hi - lo) || 1);
    return PAD.left + Math.min(1, Math.max(0, t)) * (W - PAD.left - PAD.right);
  })();

  // Price labels at the histogram edges.
  const lo = Math.min(...sample), hi = Math.max(...sample);

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={W} height={H} style={{ display: 'block' }} role="img"
           aria-label="Monte Carlo blended final price distribution">
        {/* baseline */}
        <line x1={PAD.left} x2={PAD.left + W - PAD.right - PAD.left} y1={baseY} y2={baseY}
              stroke={C.baseline} />

        {/* bars */}
        {bars.map((b, i) => (
          <rect key={i} x={b.x} y={baseY - b.h} width={Math.max(1, b.w)} height={b.h}
                fill={b.itm ? C.red : C.blue} fillOpacity="0.82" />
        ))}

        {/* strike marker */}
        <line x1={strikeX} x2={strikeX} y1={PAD.top - 4} y2={baseY}
              stroke={C.critical} strokeWidth="1.5" strokeDasharray="6 4" />
        <text x={strikeX + 6} y={PAD.top + 8} fontSize="11" fontWeight="700" fill={C.critical}>
          ${position.strike.toFixed(0)} · P(ITM) {mc.ensemble_prob_itm_pct.toFixed(1)}%
        </text>

        {/* edge price labels */}
        <text x={PAD.left} y={baseY + 15} fontSize="10" fill={C.textMuted}>${lo.toFixed(0)}</text>
        <text x={W - PAD.right} y={baseY + 15} fontSize="10" fill={C.textMuted} textAnchor="end">${hi.toFixed(0)}</text>
      </svg>
      <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 2 }}>
        Blended distribution of expiry prices · {(mc.n_sim_per_regime / 1000).toFixed(0)}K paths × 8 regimes ·{' '}
        red = {isPut ? 'ITM (≤ strike)' : 'ITM (≥ strike)'} zone
      </div>
    </div>
  );
}
