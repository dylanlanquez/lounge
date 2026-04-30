import { type CSSProperties, type ReactNode } from 'react';
import { theme } from '../../theme/index.ts';

export type StatCardTone = 'normal' | 'alert' | 'accent' | 'warn';

export interface StatCardProps {
  // Uppercase eyebrow label (e.g. "Total visits"). Always rendered in
  // muted ink at the type system's xs size — readers' eye lands on
  // the value below.
  label: string;
  // Headline number or short string. Tabular-nums so columns of cards
  // line up vertically.
  value: ReactNode;
  // Optional smaller line under the value. Used for context like
  // "+12 % vs last month" or "across 14 visits". Rendered subtle.
  delta?: ReactNode;
  // Tone shifts the value colour:
  //   • accent — forest green, used for positive / revenue figures
  //   • alert  — alert red, used for failure counts
  //   • warn   — amber, used for "needs attention" counters
  //   • normal — ink, the everyday case
  tone?: StatCardTone;
  // Optional leading icon rendered on the right side of the eyebrow.
  // Keeps the card self-explanatory at a glance when there are many
  // tiles in a grid.
  icon?: ReactNode;
}

// StatCard — the dashboard tile primitive used across Admin > Calendly,
// Admin > Payments health, and the new Reports / Financials sections.
// Replaces the older Admin-local DiagTile so every numeric tile in the
// app has the same chrome (surface bg, rounded corners, soft shadow,
// uppercase eyebrow, tabular-numerals value). Single source of truth
// for stat-card styling.

export function StatCard({ label, value, delta, tone = 'normal', icon }: StatCardProps) {
  const wrapper: CSSProperties = {
    background: theme.color.surface,
    borderRadius: theme.radius.card,
    padding: theme.space[4],
    boxShadow: theme.shadow.card,
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space[2],
    minWidth: 0,
  };
  return (
    <div style={wrapper}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: theme.space[2],
        }}
      >
        <span
          style={{
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            fontWeight: theme.type.weight.medium,
            textTransform: 'uppercase',
            letterSpacing: theme.type.tracking.wide,
          }}
        >
          {label}
        </span>
        {icon ? (
          <span style={{ color: theme.color.inkSubtle, lineHeight: 0 }} aria-hidden>
            {icon}
          </span>
        ) : null}
      </div>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.lg,
          fontWeight: theme.type.weight.semibold,
          color: valueColour(tone),
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.2,
          // Allow long values (e.g. "£12,481.00") to break sensibly
          // when the card narrows on mobile.
          wordBreak: 'break-word',
        }}
      >
        {value}
      </p>
      {delta ? (
        <span
          style={{
            fontSize: theme.type.size.xs,
            color: theme.color.inkSubtle,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {delta}
        </span>
      ) : null}
    </div>
  );
}

function valueColour(tone: StatCardTone): string {
  switch (tone) {
    case 'alert':
      return theme.color.alert;
    case 'accent':
      return theme.color.accent;
    case 'warn':
      return theme.color.warn;
    case 'normal':
      return theme.color.ink;
    default: {
      // Exhaustive check: a new tone added to StatCardTone must be
      // handled here. Throwing rather than silently falling back to
      // ink keeps the component honest.
      const exhaustive: never = tone;
      throw new Error(`Unhandled StatCardTone: ${String(exhaustive)}`);
    }
  }
}
