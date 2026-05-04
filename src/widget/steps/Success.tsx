import { Calendar, Check } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import type { WidgetState } from '../state.ts';

// Confirmation screen — shown after a successful (mock or real)
// submission. Plain, calm, single-column. Tells the patient
// exactly what happens next.
//
// Phase 2 wires this to the real booking write + .ics download +
// confirmation email send. For phase 1 it's a visual end-state
// only.

export function SuccessScreen({ state }: { state: WidgetState }) {
  const slot = state.slotIso ? new Date(state.slotIso) : null;
  const slotLabel = slot
    ? slot.toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }) +
      ', ' +
      formatHourMinute(slot)
    : '—';

  return (
    <div
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space[5],
      }}
    >
      <div
        style={{
          maxWidth: 440,
          width: '100%',
          background: theme.color.surface,
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.card,
          padding: theme.space[6],
          boxShadow: theme.shadow.card,
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: theme.color.accent,
            color: theme.color.surface,
            margin: `0 auto ${theme.space[4]}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Check size={28} strokeWidth={2.5} aria-hidden />
        </div>
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.xl,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          You're booked in
        </h2>
        <p
          style={{
            margin: `${theme.space[3]}px 0 0`,
            fontSize: theme.type.size.md,
            color: theme.color.ink,
            lineHeight: theme.type.leading.snug,
          }}
        >
          <span dangerouslySetInnerHTML={{ __html: state.service?.label ?? '' }} /> at{' '}
          {state.location?.name}
        </p>
        <p
          style={{
            margin: `${theme.space[2]}px 0 0`,
            fontSize: theme.type.size.md,
            color: theme.color.inkMuted,
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[2],
          }}
        >
          <Calendar size={14} aria-hidden />
          {slotLabel}
        </p>
        <p
          style={{
            margin: `${theme.space[5]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          A confirmation has gone to <strong>{state.details.email || 'your inbox'}</strong>{' '}
          with a calendar invite. We'll send a reminder a day before.
        </p>
      </div>
    </div>
  );
}

function formatHourMinute(d: Date): string {
  const hour = d.getHours();
  const minute = d.getMinutes();
  const period = hour < 12 ? 'am' : 'pm';
  const display = hour <= 12 ? hour : hour - 12;
  return `${display}:${String(minute).padStart(2, '0')} ${period}`;
}
