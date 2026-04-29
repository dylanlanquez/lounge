export const theme = {
  color: {
    bg: '#F7F6F2',
    surface: '#FFFFFF',
    ink: '#0E1414',
    inkMuted: 'rgba(14, 20, 20, 0.6)',
    inkSubtle: 'rgba(14, 20, 20, 0.4)',
    accent: '#1F4D3A',
    accentBg: '#E8F5EC',
    alert: '#B83A2A',
    // Amber for medium-urgency states that aren't full alert (e.g.
    // battery at 25% — warn but not yet critical).
    warn: '#B36815',
    border: 'rgba(14, 20, 20, 0.08)',
    overlay: 'rgba(14, 20, 20, 0.5)',
  },
  // Category palette for the appointment-card left bar. Hues span the
  // colour wheel (orange → green → blue → magenta) so the four types are
  // unambiguous at a glance. Saturation moderate, lightness consistent —
  // applied only to a 6px bar (not the card body) so the calendar still
  // reads as grown-up. Status colours take over post-arrival.
  category: {
    repair: '#B36815',     // amber — denture repairs
    sameDay: '#1F4D3A',    // forest green (accent) — click-in veneers
    appliance: '#1E5BA8',  // clear blue — same-day appliances
    impression: '#8C2A5A', // magenta — impression appointments
    consult: '#4A4F55',    // graphite — anything else
  },
  type: {
    family: '"Inter", "SF Pro Text", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    size: {
      xs: 12,
      sm: 14,
      base: 16,
      md: 18,
      lg: 22,
      xl: 28,
      xxl: 36,
      display: 48,
      hero: 64,
    },
    weight: {
      regular: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
    leading: {
      tight: 1.15,
      snug: 1.3,
      normal: 1.5,
      relaxed: 1.65,
    },
    tracking: {
      tight: '-0.01em',
      normal: '0',
      wide: '0.04em',
    },
  },
  space: {
    0: 0,
    1: 4,
    2: 8,
    3: 12,
    4: 16,
    5: 20,
    6: 24,
    8: 32,
    10: 40,
    12: 48,
    16: 64,
    24: 96,
  },
  radius: {
    none: 0,
    input: 14,
    card: 18,
    pill: 999,
  },
  shadow: {
    // Subtle two-layer drop shadow — soft outer (lifts off the cream bg)
    // plus a tight inner (defines the edge). Visible but quiet.
    card: '0 4px 12px rgba(14, 20, 20, 0.05), 0 1px 2px rgba(14, 20, 20, 0.04)',
    raised: '0 12px 32px rgba(14, 20, 20, 0.08), 0 2px 8px rgba(14, 20, 20, 0.04)',
    overlay: '0 24px 48px rgba(14, 20, 20, 0.12), 0 8px 16px rgba(14, 20, 20, 0.06)',
  },
  motion: {
    duration: {
      fast: 160,
      base: 240,
      slow: 320,
    },
    easing: {
      spring: 'cubic-bezier(0.25, 1, 0.3, 1)',
      standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
    },
  },
  layout: {
    tabletMin: 1024,
    desktopMin: 1280,
    sidebarWidth: 264,
    primaryButtonHeight: 56,
    inputHeight: 56,
    minTouchTarget: 48,
    safeAreaPaddingY: 16,
    // Single source of truth for the page-content max width across
    // every route (Schedule, Patients, In clinic, Walk-in, Visit,
    // Pay, Patient profile, Arrival, etc). Pages render their inner
    // max-width container at this value so the chrome rhythm
    // matches as the receptionist tabs between surfaces.
    pageMaxWidth: 960,
  },
} as const;

export type Theme = typeof theme;
