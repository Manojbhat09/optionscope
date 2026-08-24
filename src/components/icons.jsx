// src/components/icons.jsx
//
// Inline SVG icon set — replaces emoji glyphs that rendered as tofu boxes
// on systems without a color-emoji font (WSLg, minimal Linux desktops).
// Stroke-based, currentColor-aware, so they inherit button/text colors and
// work in both day and night themes.

import React from 'react';

const I = ({ size = 18, sw = 2, children, ...rest }) => (
  <svg
    width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={sw}
    strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false"
    style={{ flexShrink: 0, verticalAlign: '-0.15em' }}
    {...rest}
  >
    {children}
  </svg>
);

/* Brand — ascending bars with a trend line */
export const LogoIcon = ({ size = 20, ...rest }) => (
  <I size={size} {...rest}>
    <path d="M3 21h18" />
    <rect x="4" y="12" width="3.6" height="9" rx="0.8" fill="currentColor" stroke="none" />
    <rect x="10.2" y="7" width="3.6" height="14" rx="0.8" fill="currentColor" stroke="none" opacity=".55" />
    <rect x="16.4" y="10" width="3.6" height="11" rx="0.8" fill="currentColor" stroke="none" opacity=".75" />
    <path d="M4 9l5-4 3.5 2.5L19 3" strokeWidth="1.6" />
    <path d="M19.5 6.2V3H16.3" strokeWidth="1.6" />
  </I>
);

export const TargetIcon = ({ size = 16, ...rest }) => (
  <I size={size} {...rest}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </I>
);

export const ReplayIcon = ({ size = 16, ...rest }) => (
  <I size={size} {...rest}>
    <path d="M3 12a9 9 0 1 0 3.2-6.9" />
    <path d="M3 4v5h5" />
  </I>
);

export const RefreshIcon = ({ size = 16, ...rest }) => (
  <I size={size} {...rest}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v5h-5" />
  </I>
);

export const DownloadIcon = ({ size = 16, ...rest }) => (
  <I size={size} {...rest}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </I>
);

export const GearIcon = ({ size = 16, ...rest }) => (
  <I size={size} sw={1.8} {...rest}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.63.28 1.1.86 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </I>
);

export const SunIcon = ({ size = 16, ...rest }) => (
  <I size={size} {...rest}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </I>
);

export const MoonIcon = ({ size = 16, ...rest }) => (
  <I size={size} {...rest}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" fill="currentColor" stroke="none" />
  </I>
);

export const BulbIcon = ({ size = 14, ...rest }) => (
  <I size={size} sw={1.8} {...rest}>
    <path d="M9 18h6" />
    <path d="M10 22h4" />
    <path d="M12 2a7 7 0 0 0-4.1 12.7c.7.5 1.1 1.4 1.1 2.3v1h6v-1c0-.9.4-1.8 1.1-2.3A7 7 0 0 0 12 2z" />
  </I>
);

export const ChartUpIcon = ({ size = 44, ...rest }) => (
  <I size={size} sw={1.8} {...rest}>
    <path d="M3 3v18h18" />
    <path d="m7 14 4-4 3 3 5.5-6.5" />
    <path d="M15.5 6.5h4v4" />
  </I>
);

export const CloseIcon = ({ size = 16, ...rest }) => (
  <I size={size} {...rest}>
    <path d="M18 6 6 18M6 6l12 12" />
  </I>
);

export const BotIcon = ({ size = 15, ...rest }) => (
  <I size={size} sw={1.8} {...rest}>
    <rect x="4.5" y="8.5" width="15" height="11" rx="2.5" />
    <path d="M12 8.5V5" />
    <circle cx="12" cy="3.6" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="9.3" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="14.7" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
    <path d="M9.5 16.8h5" />
  </I>
);

export const SearchIcon = ({ size = 14, ...rest }) => (
  <I size={size} sw={2.2} {...rest}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.8-3.8" />
  </I>
);

export const SpinnerIcon = ({ size = 14, ...rest }) => (
  <I size={size} sw={2.4} {...rest}>
    <path d="M12 3a9 9 0 1 0 9 9" />
  </I>
);

/* Trophy — winning pattern fingerprint */
export const TrophyIcon = ({ size = 16, ...rest }) => (
  <I size={size} sw={1.8} {...rest}>
    <path d="M8 21h8" />
    <path d="M12 17v4" />
    <path d="M7 4h10v6a5 5 0 0 1-10 0V4z" />
    <path d="M7 6H4.5A1.5 1.5 0 0 0 3 7.5C3 9.6 4.9 11 7.2 11" />
    <path d="M17 6h2.5A1.5 1.5 0 0 1 21 7.5c0 2.1-1.9 3.5-4.2 3.5" />
    <path d="M9.5 8.2l1.7 1.7 3.3-3.4" strokeWidth="1.7" />
  </I>
);

/* Warning triangle — losing pattern fingerprint */
export const AlertIcon = ({ size = 16, ...rest }) => (
  <I size={size} sw={1.9} {...rest}>
    <path d="M10.3 4.1 2.9 17a1.9 1.9 0 0 0 1.65 2.85h14.9A1.9 1.9 0 0 0 21.1 17L13.7 4.1a1.95 1.95 0 0 0-3.4 0z" />
    <path d="M12 9.5v4" />
    <circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none" />
  </I>
);

/* Notebook — trading notes */
export const BookIcon = ({ size = 15, ...rest }) => (
  <I size={size} sw={1.8} {...rest}>
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v18H6.5A1.5 1.5 0 0 1 5 19.5v-15z" />
    <path d="M5 17.5h14" />
    <path d="M9 3v14.5" />
    <path d="M12.5 8h3.5M12.5 11h3.5" />
  </I>
);

/* Key — API keys */
export const KeyIcon = ({ size = 14, ...rest }) => (
  <I size={size} sw={1.9} {...rest}>
    <circle cx="8" cy="15.5" r="4" />
    <path d="M10.8 12.7 20 3.5" />
    <path d="M16.5 7l3 3" />
    <path d="M14 9.5l2 2" />
  </I>
);

/* Newspaper — news context */
export const NewsIcon = ({ size = 14, ...rest }) => (
  <I size={size} sw={1.8} {...rest}>
    <path d="M4 5h13v14H5.5A1.5 1.5 0 0 1 4 17.5V5z" />
    <path d="M17 8h3v9.5a1.5 1.5 0 0 1-3 0" />
    <path d="M7 8.5h7M7 11.5h7M7 14.5h4.5" />
  </I>
);

/* Clipboard list — similar trades */
export const ListIcon = ({ size = 14, ...rest }) => (
  <I size={size} sw={1.8} {...rest}>
    <rect x="5" y="4" width="14" height="17" rx="1.5" />
    <path d="M9 4.5V3h6v1.5" />
    <path d="M8.5 9.5h7M8.5 13h7M8.5 16.5h4.5" />
  </I>
);

/* Calendar — P&L calendar */
export const CalendarIcon = ({ size = 15, ...rest }) => (
  <I size={size} sw={1.8} {...rest}>
    <rect x="3.5" y="5" width="17" height="16" rx="1.5" />
    <path d="M3.5 9.5h17" />
    <path d="M8 3v4M16 3v4" />
    <path d="M7.5 13.5h3M13.5 13.5h3M7.5 17h3M13.5 17h3" strokeWidth="1.5" />
  </I>
);

/* Trend down — cheap premium marker */
export const TrendDownIcon = ({ size = 14, ...rest }) => (
  <I size={size} sw={2} {...rest}>
    <path d="m3 7 6.5 6.5 3-3L21 19" />
    <path d="M21 13.5V19h-5.5" />
  </I>
);

/* Copy — chat message copy */
export const CopyIcon = ({ size = 12, ...rest }) => (
  <I size={size} sw={1.9} {...rest}>
    <rect x="9" y="9" width="12" height="12" rx="1.5" />
    <path d="M5 15H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 3h9A1.5 1.5 0 0 1 14.5 4.5V5" />
  </I>
);

/* Monitor — custom / local endpoint */
export const MonitorIcon = ({ size = 14, ...rest }) => (
  <I size={size} sw={1.8} {...rest}>
    <rect x="3" y="4.5" width="18" height="12.5" rx="1.5" />
    <path d="M9 21h6M12 17v4" />
  </I>
);

/* Accessibility — a11y section */
export const AccessibilityIcon = ({ size = 14, ...rest }) => (
  <I size={size} sw={1.9} {...rest}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="7.2" r="1.1" fill="currentColor" stroke="none" />
    <path d="M7.5 10h9M12 10v4.5M12 14.5l-2.6 4.7M12 14.5l2.6 4.7" />
  </I>
);
