import { useMemo, useState } from 'react';
import { Check, Hourglass, UserRound } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { Button } from '../Button/Button.tsx';
import { StatusPill } from '../StatusPill/StatusPill.tsx';
import type { AppointmentPhaseSummary } from '../../lib/queries/appointments.ts';
import { advanceAppointmentPhase } from '../../lib/queries/appointmentPhases.ts';

// AppointmentPhaseTimeline — vertical timeline shown on the
// appointment detail. One row per materialised phase. Each row
// shows the time, the label, a "Patient in chair" or "Patient may
// leave" subtitle, and a status pill. Below the rows: an action
// button that advances the next-undone phase forward.
//
// Status semantics on the rows:
//   pending       → "Up next" pill, plain row
//   in_progress   → "In progress" pill, accented row
//   complete      → "Done" pill, muted row + checkmark
//   skipped       → "Skipped" pill, muted row
//   overdue       → derived: pending or in_progress with end_at < now
//                   → shown as a soft-red "Overdue" pill
//
// Single-phase appointments (the default after backfill) hide the
// whole timeline — the booking is one block, the schedule card and
// detail header already say everything there is to say.

export interface AppointmentPhaseTimelineProps {
  appointmentId: string;
  phases: AppointmentPhaseSummary[];
  // Called after a successful status change so the parent can refresh
  // upstream data (the schedule card's two-tone strip etc.).
  onChanged?: () => void;
  // Patient-facing time. When this is meaningfully different from the
  // operational total, the detail page header surfaces it; the
  // timeline doesn't repeat it. We accept it here in case future
  // copy needs it.
  patientFacingMinutes?: number | null;
}

export function AppointmentPhaseTimeline({
  appointmentId,
  phases,
  onChanged,
}: AppointmentPhaseTimelineProps) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Multi-phase only — single-phase bookings don't need this surface.
  if (phases.length < 2) return null;

  // The next phase the receptionist could act on. "Mark patient may
  // leave" advances the current in-progress active phase to complete
  // AND moves the next phase to in_progress. "Mark ready for
  // collection" advances the final phase to complete.
  const nextActionable = useMemo(() => findNextActionable(phases), [phases]);

  const handleAction = async (phaseIndex: number, toStatus: 'in_progress' | 'complete') => {
    setBusy(phaseIndex);
    setError(null);
    try {
      await advanceAppointmentPhase({ appointmentId, phaseIndex, toStatus });
      // If we just completed a phase that has a next phase, also
      // move the next phase to in_progress. Two server calls but
      // both go through the validating RPC so the receptionist
      // only sees a coherent state.
      if (toStatus === 'complete') {
        const next = phases.find((p) => p.phase_index === phaseIndex + 1);
        if (next && next.status === 'pending') {
          await advanceAppointmentPhase({
            appointmentId,
            phaseIndex: next.phase_index,
            toStatus: 'in_progress',
          });
        }
      }
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update phase');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[3],
        padding: theme.space[4],
        background: theme.color.surface,
        borderRadius: theme.radius.card,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <header>
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          Booking timeline
        </h3>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
          }}
        >
          Tap to advance when each phase is done.
        </p>
      </header>

      <ol
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {phases.map((phase, i) => (
          <PhaseRow
            key={phase.phase_index}
            phase={phase}
            isLast={i === phases.length - 1}
          />
        ))}
      </ol>

      {nextActionable && (
        <Button
          onClick={() =>
            handleAction(nextActionable.phase_index, nextActionable.actionTo)
          }
          loading={busy === nextActionable.phase_index}
          fullWidth
        >
          {nextActionable.actionLabel}
        </Button>
      )}

      {error && (
        <div
          style={{
            color: theme.color.alert,
            fontSize: theme.type.size.sm,
            padding: theme.space[2],
            background: 'rgba(184,58,42,0.06)',
            borderRadius: theme.radius.input,
          }}
        >
          {error}
        </div>
      )}
    </section>
  );
}

function PhaseRow({
  phase,
  isLast,
}: {
  phase: AppointmentPhaseSummary;
  isLast: boolean;
}) {
  const Icon = phase.patient_required ? UserRound : Hourglass;
  const subtitle = phase.patient_required
    ? 'Patient in chair'
    : `Patient may leave, ready ~${formatTime(phase.end_at)}`;
  const isDone = phase.status === 'complete' || phase.status === 'skipped';
  const isOverdue =
    !isDone &&
    new Date(phase.end_at).getTime() < Date.now() &&
    (phase.status === 'pending' || phase.status === 'in_progress');

  return (
    <li
      style={{
        display: 'grid',
        gridTemplateColumns: '64px 28px 1fr auto',
        alignItems: 'flex-start',
        columnGap: theme.space[2],
        paddingBottom: isLast ? 0 : theme.space[3],
        position: 'relative',
        opacity: isDone ? 0.6 : 1,
      }}
    >
      {/* Time column */}
      <div
        style={{
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          fontVariantNumeric: 'tabular-nums',
          paddingTop: 2,
        }}
      >
        {formatTime(phase.start_at)}
      </div>

      {/* Connector + dot column */}
      <div
        style={{
          position: 'relative',
          height: '100%',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          paddingTop: 4,
        }}
      >
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: isDone
              ? theme.color.accent
              : phase.status === 'in_progress'
                ? theme.color.accent
                : theme.color.surface,
            border: `2px solid ${
              isDone || phase.status === 'in_progress'
                ? theme.color.accent
                : theme.color.border
            }`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#FFFFFF',
            zIndex: 1,
          }}
        >
          {isDone && <Check size={10} strokeWidth={3} />}
        </span>
        {!isLast && (
          <span
            style={{
              position: 'absolute',
              top: 22,
              bottom: -4,
              width: 2,
              background: theme.color.border,
              left: 'calc(50% - 1px)',
            }}
          />
        )}
      </div>

      {/* Label + subtitle column */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[1],
          }}
        >
          <Icon size={14} strokeWidth={2.25} />
          {phase.label}
        </span>
        <span
          style={{
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
          }}
        >
          {subtitle}
        </span>
      </div>

      {/* Status pill column */}
      <div style={{ paddingTop: 2 }}>
        <StatusPill tone={pillTone(phase, isOverdue)} size="sm">
          {pillLabel(phase, isOverdue)}
        </StatusPill>
      </div>
    </li>
  );
}

function pillTone(
  phase: AppointmentPhaseSummary,
  isOverdue: boolean,
): 'neutral' | 'arrived' | 'in_progress' | 'complete' | 'no_show' {
  if (phase.status === 'complete') return 'complete';
  if (phase.status === 'skipped') return 'complete';
  if (isOverdue) return 'no_show';
  if (phase.status === 'in_progress') return 'in_progress';
  return 'neutral';
}

function pillLabel(phase: AppointmentPhaseSummary, isOverdue: boolean): string {
  if (phase.status === 'complete') return 'Done';
  if (phase.status === 'skipped') return 'Skipped';
  if (isOverdue) return 'Overdue';
  if (phase.status === 'in_progress') return 'In progress';
  return 'Up next';
}

// Find the next phase the receptionist can act on, plus the action
// label and target status. Logic:
//   - If any phase is in_progress: that one is actionable. Action
//     advances it to complete, which the parent will chain into
//     "next phase → in_progress" automatically.
//   - Else if any phase is pending and it's the first pending one:
//     action moves it to in_progress.
//   - Else (all done): no action.
function findNextActionable(
  phases: AppointmentPhaseSummary[],
): { phase_index: number; actionLabel: string; actionTo: 'in_progress' | 'complete' } | null {
  const inProgress = phases.find((p) => p.status === 'in_progress');
  if (inProgress) {
    const isFinal = inProgress.phase_index === Math.max(...phases.map((p) => p.phase_index));
    return {
      phase_index: inProgress.phase_index,
      actionTo: 'complete',
      actionLabel: isFinal
        ? 'Mark ready for collection'
        : inProgress.patient_required
          ? 'Mark patient may leave'
          : `Mark ${inProgress.label.toLowerCase()} done`,
    };
  }
  const firstPending = phases.find((p) => p.status === 'pending');
  if (firstPending) {
    return {
      phase_index: firstPending.phase_index,
      actionTo: 'in_progress',
      actionLabel: firstPending.phase_index === 1
        ? 'Start booking'
        : `Start ${firstPending.label.toLowerCase()}`,
    };
  }
  return null;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${hh}:${mm}`;
}
