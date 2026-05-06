import { type CSSProperties } from 'react';
import { Ban, Footprints, RotateCcw } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import type { StatusTone } from '../StatusPill/StatusPill.tsx';
import { CalendlyIcon } from '../Icons/CalendlyIcon.tsx';
import {
  type AppointmentSource,
  formatLateDuration,
} from '../../lib/queries/appointments.ts';
import googleMeetIcon from '../../assets/google-meet.png';

// Subset of lng_appointment_phases the card needs to render its
// two-tone phase ribbon. Always passed in phase_index order. When the
// array has 0 or 1 phase the ribbon is suppressed and the card looks
// the same as it always did.
export interface AppointmentCardPhase {
  patient_required: boolean;
  start_at: string;
  end_at: string;
  status: 'pending' | 'in_progress' | 'complete' | 'skipped';
}

export interface AppointmentCardProps {
  patientName: string;
  startAt: string; // ISO
  endAt: string;
  staffName?: string;
  status?: AppointmentStatus;
  serviceLabel?: string;
  // Layout — provided by the parent CalendarGrid:
  top: number;
  height: number;
  // Overlap layout. Default lane=0, lanesInGroup=1 = full-width.
  // Compute via assignAppointmentLanes() before rendering.
  lane?: number;
  lanesInGroup?: number;
  // Optional event-type accent for the left bar. Only applies when
  // status='booked' — once the patient arrives the status color takes over.
  barColor?: string;
  // Where the appointment came from. Drives the small badge next to the
  // patient name — Calendly glyph for public bookings, walking figure
  // for walk-ins / native rows.
  source?: AppointmentSource;
  // Minutes past start_at. Set on booked rows that have crossed the late
  // threshold so the card flags the receptionist to mark a no-show. Ignored
  // on every status other than 'booked'.
  lateMinutes?: number | null;
  // Show the Google Meet icon in the subtitle so virtual appointments are
  // instantly recognisable at a glance on the calendar grid.
  isVirtual?: boolean;
  // Reduce opacity to push the row into the visual background — used on
  // appointments whose slot has finished or whose status is terminal so
  // the eye lands on active work first. Parent decides; the card just
  // renders.
  dimmed?: boolean;
  // Materialised phases for this appointment. Two or more phases triggers
  // the two-tone ribbon at the bottom of the card; one phase leaves the
  // card visually identical to today. Phases must be in phase_index order.
  phases?: AppointmentCardPhase[];
  onClick?: () => void;
}

export type AppointmentStatus =
  | 'booked'
  | 'arrived'
  | 'joined'
  | 'complete'
  | 'no_show'
  | 'cancelled'
  | 'rescheduled';

const STATUS_TO_TONE: Record<AppointmentStatus, StatusTone> = {
  booked: 'neutral',
  arrived: 'arrived',
  joined: 'arrived',
  complete: 'complete',
  no_show: 'no_show',
  cancelled: 'cancelled',
  rescheduled: 'cancelled',
};

const BAR_COLOR: Record<AppointmentStatus, string> = {
  booked: theme.color.ink,
  arrived: theme.color.accent,
  joined: theme.color.accent,
  complete: theme.color.inkSubtle,
  no_show: theme.color.alert,
  cancelled: theme.color.inkSubtle,
  rescheduled: theme.color.inkSubtle,
};

const FILL_COLOR: Record<AppointmentStatus, string> = {
  booked: theme.color.surface,
  arrived: theme.color.accentBg,
  joined: theme.color.accentBg,
  complete: theme.color.surface,
  no_show: theme.color.surface,
  cancelled: theme.color.surface,
  rescheduled: theme.color.surface,
};

export function AppointmentCard({
  patientName,
  startAt,
  endAt,
  staffName,
  status = 'booked',
  serviceLabel,
  top,
  height,
  lane = 0,
  lanesInGroup = 1,
  barColor,
  source = 'calendly',
  lateMinutes,
  isVirtual = false,
  dimmed = false,
  phases,
  onClick,
}: AppointmentCardProps) {
  const isInteractive = Boolean(onClick);
  const lanePct = 100 / lanesInGroup;
  const showLate = status === 'booked' && typeof lateMinutes === 'number' && lateMinutes > 0;
  // Sit above the now-indicator line; below the now-time pill.
  const styles: CSSProperties = {
    position: 'absolute',
    top,
    left: `calc(${lane * lanePct}% + 2px)`,
    width: `calc(${lanePct}% - 4px)`,
    height,
    background: FILL_COLOR[status],
    borderRadius: 12,
    boxShadow: theme.shadow.card,
    overflow: 'hidden',
    display: 'flex',
    cursor: isInteractive ? 'pointer' : 'default',
    transition: `box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, transform ${theme.motion.duration.fast}ms ${theme.motion.easing.spring}, opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
    textDecoration: 'none',
    opacity: dimmed ? 0.55 : 1,
    zIndex: 1,
  };
  const effectiveBarColor = showLate
    ? theme.color.alert
    : status === 'booked' && barColor
      ? barColor
      : BAR_COLOR[status];

  // Render the phase ribbon only when there's something interesting
  // to show (2+ phases). 1-phase cards (the default after backfill)
  // look identical to today.
  const showPhaseRibbon = (phases?.length ?? 0) > 1;

  return (
    <div
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (isInteractive && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick?.();
        }
      }}
      style={styles}
      aria-label={`${patientName}, ${formatTimeRange(startAt, endAt)}${staffName ? `, with ${staffName}` : ''}`}
    >
      <div
        style={{
          width: 6,
          background: effectiveBarColor,
          flexShrink: 0,
        }}
        aria-hidden
      />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          padding: `${theme.space[2]}px ${theme.space[3]}px`,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          color: status === 'complete' || status === 'cancelled' || status === 'rescheduled' ? theme.color.inkMuted : theme.color.ink,
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            lineHeight: theme.type.leading.snug,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <SourceGlyph source={source} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{patientName}</span>
        </p>
        {status === 'cancelled' || status === 'rescheduled' ? (
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.xs,
              lineHeight: theme.type.leading.snug,
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              color: status === 'cancelled' ? theme.color.alert : theme.color.warn,
              fontWeight: theme.type.weight.medium,
            }}
          >
            {status === 'cancelled'
              ? <Ban size={10} aria-hidden style={{ flexShrink: 0 }} />
              : <RotateCcw size={10} aria-hidden style={{ flexShrink: 0 }} />
            }
            {status === 'cancelled' ? 'Cancelled' : 'Rescheduled'}
          </p>
        ) : (
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              lineHeight: theme.type.leading.snug,
              fontVariantNumeric: 'tabular-nums',
              display: 'flex',
              alignItems: 'center',
              gap: 3,
            }}
          >
            {isVirtual && (
              <img src={googleMeetIcon} height={11} aria-label="Virtual meeting" style={{ flexShrink: 0, display: 'block', width: 'auto' }} />
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {formatTime(startAt)}
              {serviceLabel ? ` · ${serviceLabel}` : staffName ? ` · ${staffName}` : ''}
              {showLate ? (
                <span style={{ color: theme.color.alert, fontWeight: theme.type.weight.semibold }}>
                  {' · '}
                  {formatLateDuration(lateMinutes!)} late
                </span>
              ) : null}
            </span>
          </p>
        )}
        {showPhaseRibbon && (
          <PhaseStrip
            phases={phases!}
            apptStart={startAt}
            apptEnd={endAt}
          />
        )}
      </div>
    </div>
  );
}

// Thin two-tone ribbon shown at the bottom of a multi-phase card.
// One band per phase, sized proportional to its share of the booking
// window. Active phases (patient in chair) render solid in the accent
// colour; passive phases (patient may leave) render at lower opacity
// with a diagonal hatch overlay so the eye reads them as "still
// booked, just no patient". Completed phases dim themselves slightly
// so the receptionist can see at a glance how far through the booking
// is — without needing to open the detail.
function PhaseStrip({
  phases,
  apptStart,
  apptEnd,
}: {
  phases: AppointmentCardPhase[];
  apptStart: string;
  apptEnd: string;
}) {
  const totalMs = new Date(apptEnd).getTime() - new Date(apptStart).getTime();
  if (totalMs <= 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        marginTop: 4,
        height: 6,
        borderRadius: 3,
        overflow: 'hidden',
        background: 'rgba(14,20,20,0.06)',
      }}
      aria-hidden
    >
      {phases.map((p, i) => {
        const phaseMs = new Date(p.end_at).getTime() - new Date(p.start_at).getTime();
        const widthPct = totalMs > 0 ? (phaseMs / totalMs) * 100 : 0;
        const passive = !p.patient_required;
        const done = p.status === 'complete' || p.status === 'skipped';
        return (
          <div
            key={i}
            style={{
              width: `${widthPct}%`,
              // Solid accent for active phases, pale accent fill
              // for passive — same colour family, no diagonal
              // hatch. The hatch read as "warning / pending" on
              // first ship; flat fill is calmer and still reads
              // as "still booked, no patient".
              backgroundColor: passive ? theme.color.accentBg : theme.color.accent,
              opacity: done ? 0.5 : 1,
              borderRight:
                i < phases.length - 1 ? `1px solid ${theme.color.surface}` : 'none',
            }}
          />
        );
      })}
    </div>
  );
}

function formatTimeRange(startIso: string, endIso: string): string {
  return `${formatTime(startIso)} to ${formatTime(endIso)}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const hh = h % 12 === 0 ? 12 : h % 12;
  const mm = m === 0 ? '' : `:${String(m).padStart(2, '0')}`;
  const ampm = h < 12 ? 'am' : 'pm';
  return `${hh}${mm}${ampm}`;
}

// Compact source glyph next to the patient name. CalendlyIcon for
// public bookings, Footprints for walk-ins / manual rows. Exported so
// the list view + cluster sheet + detail header share the same badge.
export function SourceGlyph({ source, size = 12 }: { source: AppointmentSource; size?: number }) {
  if (source === 'calendly') {
    return <CalendlyIcon size={size} title="Calendly booking" color={theme.color.inkSubtle} />;
  }
  return (
    <Footprints
      size={size + 2}
      color={theme.color.inkSubtle}
      aria-label="Walk-in"
      style={{ flexShrink: 0 }}
    />
  );
}

// Re-export the tone mapping so other surfaces can show consistent badges.
export { STATUS_TO_TONE };
