import { type ReactNode } from 'react';
import { theme } from '../../theme/index.ts';

// Small inline caption used inside a Section's content for dynamic
// per-section state (e.g. "45-minute slot. Hours that day: 09:00 to
// 18:00." once a service is picked, or "Goes to email@example.com"
// once a patient is picked).
//
// Distinct from the Section header — sits just under the input, in
// muted ink at the size we use for helper text. The header carries
// static "what does this field do" guidance via its tooltip; the
// inline hint carries live state.
//
// `tone` flips the colour to alert for the "out of working hours" /
// "clinic closed" cases so the same component handles both quiet
// helpers and louder warnings without a separate widget.

export interface InlineHintProps {
  children: ReactNode;
  tone?: 'muted' | 'alert';
}

export function InlineHint({ children, tone = 'muted' }: InlineHintProps) {
  return (
    <p
      style={{
        margin: `${theme.space[2]}px 0 0`,
        fontSize: theme.type.size.xs,
        color: tone === 'alert' ? theme.color.alert : theme.color.inkMuted,
        lineHeight: theme.type.leading.snug,
      }}
    >
      {children}
    </p>
  );
}
