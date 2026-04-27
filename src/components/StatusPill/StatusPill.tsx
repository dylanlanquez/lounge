import { type CSSProperties, type ReactNode } from 'react';
import { theme } from '../../theme/index.ts';

export type StatusTone = 'neutral' | 'arrived' | 'in_progress' | 'complete' | 'no_show' | 'cancelled';

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
    background: 'transparent',
    color: theme.color.inkSubtle,
    textDecoration: 'line-through',
    boxShadow: `inset 0 0 0 1px ${theme.color.border}`,
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
