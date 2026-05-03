import { Hourglass, Pencil, Plus, UserRound } from 'lucide-react';
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
  // patient-facing min to hide the chip entirely. Set max to surface
  // a range ("30 to 45 min" / "1 to 2 hours") rather than a fixed
  // value.
  operational_minutes: number;
  patient_in_minutes: number;
  patient_facing_min_minutes: number | null;
  patient_facing_max_minutes: number | null;
  // Optional per-phase tap handler — opens the editor in the admin.
  // When omitted, chips are not interactive.
  onPhaseClick?: (key: string) => void;
  // Optional "+ Add phase" handler — appends a chip at the end with
  // a plus icon; tap fires this. Omit for read-only ribbons.
  onAddPhase?: () => void;
  // Optional handler for tapping the "Telling patient" summary chip.
  // When provided, the chip renders with a pencil affordance and is
  // a button. When omitted the chip stays plain text.
  onEditPatientFacing?: () => void;
  // Compact mode shrinks chips and hides the summary line. Used when
  // the ribbon needs to fit inside a tight admin row.
  compact?: boolean;
}

export function PhaseRibbon({
  phases,
  operational_minutes,
  patient_in_minutes,
  patient_facing_min_minutes,
  patient_facing_max_minutes,
  onPhaseClick,
  onAddPhase,
  onEditPatientFacing,
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
          patient_facing_min={patient_facing_min_minutes}
          patient_facing_max={patient_facing_max_minutes}
          onEditPatientFacing={onEditPatientFacing}
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
          // Defensive: if a service has many short phases or the
          // container is narrower than the sum of chip min-widths,
          // let the ribbon scroll horizontally instead of forcing
          // every chip to compress past readability.
          overflowX: 'auto',
          flexWrap: 'nowrap',
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
        // Min-width floor so short phases stay readable even when
        // proportional sizing would otherwise crush them. Click-in
        // Veneers' 30m / 4h / 10m split was previously dropping the
        // 10-min "Try In" chip down to ~50px wide and truncating
        // the label to a single letter. 96px in full mode fits any
        // reasonable label + duration with breathing room; 48px in
        // compact mode (no label, just duration) is enough.
        minWidth: compact ? 48 : 96,
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
  patient_facing_min,
  patient_facing_max,
  onEditPatientFacing,
}: {
  operational: number;
  patient_in: number;
  patient_facing_min: number | null;
  patient_facing_max: number | null;
  onEditPatientFacing?: () => void;
}) {
  const facingLabel = formatPatientFacing(patient_facing_min, patient_facing_max);
  // "Attention" tone fires when the patient-facing line meaningfully
  // diverges from the operational total. Range counts as divergent
  // (it's never equal to a single operational number); fixed values
  // count when min differs from operational.
  const isRange =
    patient_facing_max !== null &&
    patient_facing_min !== null &&
    patient_facing_max > patient_facing_min;
  const fixedDiverges =
    patient_facing_min !== null &&
    !isRange &&
    patient_facing_min !== operational;
  const tone = isRange || fixedDiverges ? 'attention' : 'default';

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
      {facingLabel && (
        <SummaryItem
          label="Telling patient"
          value={facingLabel}
          tone={tone}
          onClick={onEditPatientFacing}
        />
      )}
    </div>
  );
}

// Compact format for the ribbon summary. Single value or range,
// short-form ("30 min" / "1 h 30") to match the operational and
// patient-in pills next to it. Empty when min isn't set.
function formatPatientFacing(
  min: number | null,
  max: number | null,
): string {
  if (!min || min <= 0) return '';
  if (!max || max <= min) return formatMinutes(min);
  return `${formatMinutes(min)} to ${formatMinutes(max)}`;
}

function SummaryItem({
  label,
  value,
  tone = 'default',
  onClick,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'attention';
  onClick?: () => void;
}) {
  const valueStyle = {
    fontWeight: theme.type.weight.semibold,
    color: tone === 'attention' ? theme.color.alert : theme.color.ink,
  } as const;

  if (!onClick) {
    return (
      <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: theme.space[1] }}>
        <span>{label}</span>
        <span style={valueStyle}>{value}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Edit ${label.toLowerCase()}`}
      style={{
        appearance: 'none',
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        padding: `${theme.space[1]}px ${theme.space[2]}px`,
        borderRadius: theme.radius.pill,
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[1],
        cursor: 'pointer',
        fontSize: theme.type.size.sm,
        color: theme.color.inkMuted,
        fontFamily: 'inherit',
      }}
    >
      <span>{label}</span>
      <span style={valueStyle}>{value}</span>
      <Pencil size={11} strokeWidth={2.25} aria-hidden style={{ color: theme.color.inkMuted }} />
    </button>
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
