import { type CSSProperties, type ReactNode } from 'react';
import { theme } from '../../theme/index.ts';

export type StatusTone =
  | 'neutral'
  | 'arrived'
  | 'in_progress'
  | 'complete'
  | 'no_show'
  | 'cancelled'
  // Subtle outlined pill used for "not yet done" affordances on the
  // In Clinic board (waiver pending, payment pending). Reads as quiet
  // background information, never alarming.
  | 'pending'
  // Light, soft orange. Used for the "Unsuitable" status pill. No
  // strikethrough — staff still need to read the label clearly. The
  // colour communicates terminal but not destructive: the visit
  // ended without success, but it's reversible by an admin.
  | 'unsuitable'
  // Lighter green sibling of `arrived`. Used for "Deposit paid" — the
  // booking has money against it, but the cart isn't settled in full.
  // The lighter weight stops staff reading the row as "fully paid"
  // when only the deposit has cleared.
  | 'deposit_paid';

export interface StatusPillProps {
  tone: StatusTone;
  children: ReactNode;
  size?: 'sm' | 'md';
}

// Per `docs/05-design-references.md §2.5` — these are the only colours on the
// calendar. Mostly ink + outline; forest green only for active states.
const TONE_STYLES: Record<StatusTone, CSSProperties> = {
  neutral: {
    background: 'transparent',
    color: theme.color.ink,
    boxShadow: `inset 0 0 0 1px ${theme.color.ink}`,
  },
  arrived: {
    background: theme.color.accent,
    color: theme.color.surface,
  },
  in_progress: {
    background: 'transparent',
    color: theme.color.accent,
    boxShadow: `inset 0 0 0 1.5px ${theme.color.accent}`,
  },
  complete: {
    background: 'transparent',
    color: theme.color.inkMuted,
    boxShadow: `inset 0 0 0 1px ${theme.color.border}`,
  },
  no_show: {
    background: 'transparent',
    color: theme.color.alert,
    boxShadow: `inset 0 0 0 1.5px ${theme.color.alert}`,
  },
  cancelled: {
    // Soft alert-tinted card with red text. The earlier strikethrough
    // treatment (struck-through "Cancelled") read like the cancellation
    // itself had been undone, which is the opposite of the actual
    // state. Mirrors the unsuitable orange pattern but in red.
    background: 'rgba(184, 58, 42, 0.10)',
    color: theme.color.alert,
    boxShadow: `inset 0 0 0 1px rgba(184, 58, 42, 0.25)`,
  },
  pending: {
    background: 'transparent',
    color: theme.color.inkMuted,
    boxShadow: `inset 0 0 0 1px ${theme.color.border}`,
  },
  unsuitable: {
    background: 'rgba(179, 104, 21, 0.10)',
    color: theme.color.warn,
    boxShadow: `inset 0 0 0 1px rgba(179, 104, 21, 0.25)`,
  },
  deposit_paid: {
    // Tinted accent on a near-white wash with a quiet accent ring.
    // Pairs visually with `arrived` (solid forest green) but reads as
    // "partial" — strong enough to mean "money in", subtle enough to
    // not be confused with a fully paid sale.
    background: theme.color.accentBg,
    color: theme.color.accent,
    boxShadow: `inset 0 0 0 1px rgba(31, 77, 58, 0.22)`,
  },
};

export function StatusPill({ tone, children, size = 'md' }: StatusPillProps) {
  const padX = size === 'sm' ? theme.space[2] : theme.space[3];
  const padY = size === 'sm' ? 2 : 4;
  const fontSize = size === 'sm' ? theme.type.size.xs : theme.type.size.sm;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[1],
        borderRadius: theme.radius.pill,
        padding: `${padY}px ${padX}px`,
        fontSize,
        fontWeight: theme.type.weight.medium,
        lineHeight: 1.3,
        whiteSpace: 'nowrap',
        ...TONE_STYLES[tone],
      }}
    >
      {children}
    </span>
  );
}
