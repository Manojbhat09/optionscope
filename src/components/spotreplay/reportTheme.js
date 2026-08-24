// src/components/spotreplay/reportTheme.js
//
// Shared palette + formatting helpers for the Spot Replay dynamic report.
// Colors mirror files/crwd_analysis_report.html (the dataviz-skill palette)
// so the interactive page reads exactly like the static reports it replaces.

// Shared palette + formatting helpers for the Spot Replay dynamic report.
// Neutral surfaces/text/borders consume the app's day/night CSS variables
// (index.css) so the page retints with html[data-theme] like every other
// page; series/accent colors stay fixed so charts read identically in both.
// Palette origins: files/crwd_analysis_report.html (dataviz-skill palette).

export const C = {
  bg: 'var(--os-bg)',            // page plane
  surface: 'var(--os-surface)',  // cards
  border: 'var(--os-border)',
  text: 'var(--os-text)',
  textSecondary: 'var(--os-text-2)',
  textMuted: 'var(--os-text-3)',
  gridline: 'var(--os-border)',
  baseline: 'var(--os-border)',
  blue: '#2a78d6',        // ARIMA / primary series
  orange: '#eb6834',      // Gradient Boosting
  green: '#1baf7a',       // bullish candles / positive
  violet: '#4a3aa7',      // Random Forest
  red: '#e34948',         // bearish candles / ITM zone
  good: 'var(--os-pos)',  // HOLD badge / bullish verdicts
  critical: 'var(--os-neg)', // SELL badge / strike line
};

// Consistent money formatting: "-$1,234.56" instead of "$-1234.56".
export function fmtMoney(n, decimals = 2) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  });
  return (n < 0 ? '-$' : '$') + abs;
}

export function fmtNum(n, decimals = 1) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toFixed(decimals);
}

export function fmtPct(n, decimals = 1) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `${Number(n).toFixed(decimals)}%`;
}

// Shared card/section/table styles so every section looks coherent.
export const styles = {
  card: {
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    padding: '16px 18px',
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 13, fontWeight: 700, color: C.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.6, margin: '0 0 10px',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    textAlign: 'left', padding: '6px 8px', color: C.textMuted,
    fontWeight: 600, borderBottom: `1px solid ${C.baseline}`,
    fontVariantNumeric: 'tabular-nums',
  },
  td: {
    padding: '6px 8px', borderBottom: `1px solid ${C.gridline}`,
    color: C.text, fontVariantNumeric: 'tabular-nums',
  },
};
