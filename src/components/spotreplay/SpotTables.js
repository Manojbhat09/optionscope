// src/components/spotreplay/SpotTables.js
//
// The tabular sections of the Spot Replay report, rendered live from the
// analysis JSON: Monte Carlo regime breakdown, model predictions, and the
// sell-vs-hold decision matrix. React port of the static report's tables.

import React from 'react';
import { C, styles, fmtMoney, fmtPct } from './reportTheme';

// ── Monte Carlo regime table ─────────────────────────────────────────────────
export function RegimeTable({ analysis }) {
  const { monte_carlo: mc } = analysis;
  const rows = Object.entries(mc.regimes || {});
  const colorFor = p => (p >= 40 ? C.good : p <= 12 ? C.critical : C.text);

  return (
    <div style={styles.card}>
      <div style={styles.sectionTitle}>Monte Carlo Regime Breakdown</div>
      <table style={styles.table}>
        <thead>
          <tr>
            {['Regime', 'Weight', 'Daily σ', 'Ann. σ', 'Median final', '5th pct', '95th pct', 'P(ITM)'].map(h => (
              <th key={h} style={{ ...styles.th, textAlign: h === 'P(ITM)' ? 'right' : undefined }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, r]) => (
            <tr key={label}>
              <td style={styles.td}>{label}</td>
              <td style={styles.td}>{fmtPct((mc.weights?.[label] || 0) * 100, 0)}</td>
              <td style={styles.td}>{(r.sigma_daily * 100).toFixed(2)}%</td>
              <td style={styles.td}>{(r.sigma_annualized * 100).toFixed(0)}%</td>
              <td style={styles.td}>{fmtMoney(r.median_final)}</td>
              <td style={styles.td}>{fmtMoney(r.pct5)}</td>
              <td style={styles.td}>{fmtMoney(r.pct95)}</td>
              <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700, color: colorFor(r.p_itm_pct) }}>
                {fmtPct(r.p_itm_pct)}
              </td>
            </tr>
          ))}
          <tr>
            <td style={{ ...styles.td, fontWeight: 700 }}>BLENDED ENSEMBLE</td>
            <td colSpan={6} />
            <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700, color: colorFor(mc.ensemble_prob_itm_pct), fontSize: 14 }}>
              {fmtPct(mc.ensemble_prob_itm_pct)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── Model predictions table ──────────────────────────────────────────────────
export function ModelTable({ analysis }) {
  const { ml, arima, position, historical_analogs: analogs } = analysis;
  const days = position.days_left;

  const row = (name, detail, direction, callsItm, extra) => ({ name, detail, direction, callsItm, extra });

  const rows = [
    ml.GradientBoosting && row(
      'Gradient Boosting',
      `${fmtMoney(ml.GradientBoosting.final_price)} (day-${days})`,
      ml.GradientBoosting.direction,
      ml.GradientBoosting.calls_itm,
      (ml.GradientBoosting.top_features || []).slice(0, 3).map(f => f.feature).join(', ')),
    ml.RandomForest && row(
      'Random Forest',
      `${fmtMoney(ml.RandomForest.final_price)} (day-${days})`,
      ml.RandomForest.direction,
      ml.RandomForest.calls_itm,
      ''),
    arima.order && row(
      `ARIMA ${arima.order.join(',')} (AIC ${Math.round(arima.aic)})`,
      `${fmtMoney(arima.forecast[arima.forecast.length - 1])} · CI90 ${fmtMoney(Math.min(...arima.ci90_lower))}–${fmtMoney(Math.max(...arima.ci90_upper))}`,
      'FLAT',
      arima.final_calls_itm,
      `strike ${arima.final_in_ci90 ? 'inside' : 'outside'} CI90`),
    analogs.count > 0 && row(
      `Historical analogs (${analogs.count}${analogs.widened_search ? ', widened' : ''})`,
      analogs.implied_itm_pct != null ? fmtPct(analogs.implied_itm_pct) + ' ITM historically' : '—',
      analogs.forward_return_mean != null && (analogs.forward_return_mean >= 0 ? 'BULLISH' : 'BEARISH'),
      null,
      analogs.dates?.slice(0, 4).join(', ')),
  ].filter(Boolean);

  return (
    <div style={styles.card}>
      <div style={styles.sectionTitle}>Model Predictions</div>
      <table style={styles.table}>
        <thead>
          <tr>{['Model', 'Forecast', 'Direction', 'Calls ITM?', 'Notes'].map(h => (
            <th key={h} style={styles.th}>{h}</th>))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={{ ...styles.td, fontWeight: 600 }}>{r.name}</td>
              <td style={styles.td}>{r.detail}</td>
              <td style={{ ...styles.td, color: r.direction === 'BEARISH' ? C.red : r.direction === 'BULLISH' ? C.good : C.textMuted }}>
                {r.direction || '—'}
              </td>
              <td style={{ ...styles.td, fontWeight: 700, color: r.callsItm == null ? C.textMuted : r.callsItm ? C.good : C.critical }}>
                {r.callsItm == null ? '—' : r.callsItm ? 'YES' : 'NO'}
              </td>
              <td style={{ ...styles.td, fontSize: 11.5 }}>{r.extra}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Decision matrix ──────────────────────────────────────────────────────────
export function DecisionMatrix({ analysis }) {
  const d = analysis.decision;
  const mc = analysis.monte_carlo;
  const pos = analysis.position;
  const holdWins = d.recommendation === 'HOLD';

  const probOtm = 100 - mc.ensemble_prob_itm_pct;

  return (
    <div style={styles.card}>
      <div style={styles.sectionTitle}>Decision Matrix</div>
      <table style={styles.table}>
        <thead>
          <tr>{['Action', 'Probability', 'Value / position', 'EV'].map(h => <th key={h} style={styles.th}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ ...styles.td, fontWeight: 600 }}>Sell now</td>
            <td style={styles.td}>100%</td>
            <td style={styles.td}>{fmtMoney(pos.current_option_price)} × {pos.contracts} × 100</td>
            <td style={styles.td}>{fmtMoney(d.ev_sell)}</td>
          </tr>
          <tr>
            <td style={{ ...styles.td, fontWeight: 600 }} rowSpan={2}>Hold to expiry</td>
            <td style={styles.td}>{fmtPct(probOtm)} → OTM ($0)</td>
            <td style={styles.td}>$0.00</td>
            <td style={styles.td}>$0.00</td>
          </tr>
          <tr>
            <td style={styles.td}>{fmtPct(mc.ensemble_prob_itm_pct)} → ITM (avg {fmtMoney(mc.avg_payoff_if_itm)}/sh)</td>
            <td style={styles.td}>{fmtMoney(mc.avg_payoff_if_itm * 100 * pos.contracts)}</td>
            <td style={{ ...styles.td, fontWeight: 700 }}>{fmtMoney(d.ev_hold)}</td>
          </tr>
        </tbody>
      </table>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: 12,
        padding: '9px 12px', borderRadius: 8,
        background: holdWins ? 'rgba(27,175,122,0.09)' : 'rgba(227,73,72,0.09)',
      }}>
        <span style={{ fontWeight: 800, fontSize: 15, letterSpacing: 0.5, color: holdWins ? C.good : C.critical }}>
          EV ADVANTAGE: {holdWins ? 'HOLD' : 'SELL'} by {fmtMoney(d.ev_advantage)}
        </span>
        <span style={{ fontSize: 12, color: C.textSecondary }}>
          · Kelly fraction {d.kelly_fraction == null ? '—' : fmtPct(d.kelly_fraction * 100)}{' '}
          {d.kelly_fraction != null && (d.kelly_fraction > 0 ? '(positive edge)' : '(negative edge — do not size up)')}
        </span>
      </div>
    </div>
  );
}
