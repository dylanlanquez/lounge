import { Hourglass, Plus, UserRound } from 'lucide-react';
import { theme } from '../../theme/index.ts';

// PhaseRibbon — horizontal proportional ribbon showing the phases
// of a booking type. Active phases (patient_required=true) render
// as a solid accent block; passive phases (patient_required=false)
// render in the same accent at lower opacity with a diagonal-hatch
// pattern overlay so the operator can immediately tell "patient is
// here" from "patient may leave" by glance.
//
// The ribbon is the primary "I get the booking shape" surface for
// the booking-types admin tab. ADR-006 / slice docs/booking-phases.md.
//
// Three sums are surfaced above the ribbon:
//   Operational   — sum of all phase durations (the calendar block).
//   Patient in    — sum of active-phase durations (the time the
//                   patient is physically here).
//   Telling patient — what the confirmation says. Defaults to
//                     operational; can be overridden per-config.
//
// When a phase is too short to fit its label inside the chip, the
// chip just shows the duration; tap/hover reveals the label via
// the Tooltip wrapper that consumers attach.

export interface PhaseRibbonPhase {
  // Stable key for React. Use the DB id when editing, or
  // `${phase_index}` for read-only previews.
  key: string;
  phase_index: number;
  label: string;
  patient_required: boolean;
  // Duration shown on the chip and used to size it proportionally.
  duration_minutes: number;
  // Optional pool ids to show as a small subscript chip-set.
  pool_ids?: string[];
}

export interface PhaseRibbonProps {
  phases: PhaseRibbonPhase[];
  // Operational and patient-facing totals. The component does NOT
  // sum these itself — the caller knows whether a child override
  // changes them and is the source of truth. Pass null for the
  // patient-facing line to hide it.
  operational_minutes: number;
  patient_in_minutes: number;
  patient_facing_minutes: number | null;
  // Optional per-phase tap handler — opens the editor in the admin.
  // When omitted, chips are not interactive.
  onPhaseClick?: (key: string) => void;
  // Optional "+ Add phase" handler — appends a chip at the end with
  // a plus icon; tap fires this. Omit for read-only ribbons.
  onAddPhase?: () => void;
  // Compact mode shrinks chips and hides the summary line. Used when
  // the ribbon needs to fit inside a tight admin row.
  compact?: boolean;
}

export function PhaseRibbon({
  phases,
  operational_minutes,
  patient_in_minutes,
  patient_facing_minutes,
  onPhaseClick,
  onAddPhase,
  compact = false,
}: PhaseRibbonProps) {
  const totalMin = phases.reduce((acc, p) => acc + Math.max(p.duration_minutes, 1), 0);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? theme.space[1] : theme.space[2],
      }}
    >
      {!compact && (
        <SummaryLine
          operational={operational_minutes}
          patient_in={patient_in_minutes}
          patient_facing={patient_facing_minutes}
        />
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 2,
          minHeight: compact ? 32 : 44,
          background: 'rgba(14,20,20,0.04)',
          borderRadius: theme.radius.input,
          padding: 2,
        }}
        role="group"
        aria-label="Booking phase ribbon"
      >
        {phases.length === 0 && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: theme.space[2],
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
            }}
          >
            No phases yet. Add the first one to define the booking shape.
          </div>
        )}

        {phases.map((p) => (
          <PhaseChip
            key={p.key}
            phase={p}
            // grow proportional to its share of the total
            flexBasis={`${(Math.max(p.duration_minutes, 1) / totalMin) * 100}%`}
            compact={compact}
            onClick={onPhaseClick ? () => onPhaseClick(p.key) : undefined}
          />
        ))}

        {onAddPhase && (
          <button
            type="button"
            onClick={onAddPhase}
            aria-label="Add phase"
            style={{
              border: 'none',
              background: 'transparent',
              padding: `0 ${theme.space[3]}px`,
              borderRadius: theme.radius.input - 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: theme.space[1],
              color: theme.color.inkMuted,
              cursor: 'pointer',
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.medium,
              minWidth: 64,
            }}
          >
            <Plus size={16} strokeWidth={2.25} />
            <span>{compact ? '' : 'Add'}</span>
          </button>
        )}
      </div>
    </div>
  );
}

// One chip in the ribbon. Solid for active, hatched for passive.
function PhaseChip({
  phase,
  flexBasis,
  compact,
  onClick,
}: {
  phase: PhaseRibbonPhase;
  flexBasis: string;
  compact: boolean;
  onClick?: () => void;
}) {
  const passive = !phase.patient_required;
  const Icon = phase.patient_required ? UserRound : Hourglass;

  const interactive = !!onClick;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!interactive}
      aria-label={`${phase.label}, ${phase.duration_minutes} minutes, ${
        phase.patient_required ? 'patient required' : 'patient may leave'
      }`}
      style={{
        flex: `1 1 ${flexBasis}`,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: compact ? `0 ${theme.space[2]}px` : `${theme.space[1]}px ${theme.space[2]}px`,
        borderRadius: theme.radius.input - 4,
        border: 'none',
        cursor: interactive ? 'pointer' : 'default',
        // Solid accent for active; pale accent fill for passive.
        // Same colour family signals "still part of this booking";
        // lower saturation signals "patient not here right now".
        // No diagonal hatch — that pattern reads as "pending /
        // warning state" rather than "wait time".
        backgroundColor: passive ? theme.color.accentBg : theme.color.accent,
        // Text colour flips for legibility on the pale background.
        color: passive ? theme.color.accent : '#FFFFFF',
        textAlign: 'center',
        gap: 2,
        transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.spring}`,
        outline: 'none',
      }}
      onMouseDown={(e) => {
        if (!interactive) return;
        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(0.985)';
      }}
      onMouseUp={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = '';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = '';
      }}
    >
      {!compact && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: theme.type.size.xs,
            fontWeight: theme.type.weight.medium,
            opacity: 0.95,
            maxWidth: '100%',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          <Icon size={12} strokeWidth={2.25} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{phase.label}</span>
        </div>
      )}
      <div
        style={{
          fontSize: compact ? theme.type.size.xs : theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          letterSpacing: 0.2,
        }}
      >
        {formatMinutes(phase.duration_minutes)}
      </div>
    </button>
  );
}

function SummaryLine({
  operational,
  patient_in,
  patient_facing,
}: {
  operational: number;
  patient_in: number;
  patient_facing: number | null;
}) {
  const drift =
    patient_facing !== null && patient_facing !== operational
      ? Math.abs(patient_facing - operational)
      : 0;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: theme.space[3],
        fontSize: theme.type.size.sm,
        color: theme.color.inkMuted,
      }}
    >
      <SummaryItem label="Operational" value={formatMinutes(operational)} />
      <SummaryItem label="Patient in" value={formatMinutes(patient_in)} />
      {patient_facing !== null && (
        <SummaryItem
          label="Telling patient"
          value={formatMinutes(patient_facing)}
          tone={drift > 0 ? 'attention' : 'default'}
        />
      )}
    </div>
  );
}

function SummaryItem({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'attention';
}) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: theme.space[1] }}>
      <span>{label}</span>
      <span
        style={{
          fontWeight: theme.type.weight.semibold,
          color: tone === 'attention' ? theme.color.alert : theme.color.ink,
        }}
      >
        {value}
      </span>
    </div>
  );
}

// Format minutes as a compact human string. 35 → "35 min";
// 240 → "4 h"; 270 → "4 h 30"; 60 → "1 h". Used by the ribbon and
// summary line.
function formatMinutes(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (m === 0) return `${h} h`;
  return `${h} h ${m}`;
}
