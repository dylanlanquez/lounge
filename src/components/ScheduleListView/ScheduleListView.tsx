import { ChevronRight } from 'lucide-react';
import googleMeetIcon from '../../assets/google-meet.png';
import { SourceGlyph } from '../AppointmentCard/AppointmentCard.tsx';
import { StatusPill } from '../StatusPill/StatusPill.tsx';
import { theme } from '../../theme/index.ts';
import {
  type AppointmentRow,
  eventTypeCategory,
  formatBookingSummary,
  formatLateDuration,
  humaniseStatus,
  isAppointmentDimmed,
  isBookingLate,
  minutesPastStart,
  patientDisplayName,
  staffDisplayName,
} from '../../lib/queries/appointments.ts';
import { useNow } from '../../lib/useNow.ts';

export interface ScheduleListViewProps {
  rows: AppointmentRow[];
  onPick: (row: AppointmentRow) => void;
}

export function ScheduleListView({ rows, onPick }: ScheduleListViewProps) {
  const now = useNow();
  const sorted = [...rows].sort((a, b) =>
    a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : 0
  );
  const morning = sorted.filter((r) => new Date(r.start_at).getHours() < 12);
  const afternoon = sorted.filter((r) => new Date(r.start_at).getHours() >= 12);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      {morning.length > 0 ? <Section label="Morning" rows={morning} onPick={onPick} now={now} /> : null}
      {afternoon.length > 0 ? <Section label="Afternoon" rows={afternoon} onPick={onPick} now={now} /> : null}
    </div>
  );
}

function Section({
  label,
  rows,
  onPick,
  now,
}: {
  label: string;
  rows: AppointmentRow[];
  onPick: (r: AppointmentRow) => void;
  now: Date;
}) {
  return (
    <div>
      <p
        style={{
          margin: `0 0 ${theme.space[2]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkSubtle,
          fontWeight: theme.type.weight.medium,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
        }}
      >
        {label}
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        {rows.map((r) => (
          <ScheduleListRow key={r.id} row={r} onPick={() => onPick(r)} now={now} />
        ))}
      </ul>
    </div>
  );
}

// Shared list-row used by ScheduleListView and the cluster BottomSheet so
// both surfaces share the same category bar / time / duration / patient /
// status / chevron treatment plus the dim and late-nudge rules.
// Renders `<li>` so the parent should always wrap in `<ul>` for semantics.
export function ScheduleListRow({
  row,
  onPick,
  now,
}: {
  row: AppointmentRow;
  onPick: () => void;
  now: Date;
}) {
  const tone = statusToTone(row.status);
  const slotEnded = new Date(row.end_at).getTime() <= now.getTime();
  // Late nudge only fires while the slot is still running. After end_at the
  // dim treatment carries the signal — calling it "late" is past tense.
  const isLate = row.status === 'booked' && !slotEnded && isBookingLate(row.start_at, now);
  const lateMin = isLate ? minutesPastStart(row.start_at, now) : 0;
  const faded = isAppointmentDimmed(row, now);
  // Apply category bar only on booked rows (matches AppointmentCard:
  // status colour takes over once the visit is in progress). Late rows
  // override with alert red so the receptionist can scan for them.
  const barColor = isLate
    ? theme.color.alert
    : row.status === 'booked'
      ? theme.category[eventTypeCategory(row.event_type_label)]
      : undefined;
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        style={{
          appearance: 'none',
          width: '100%',
          textAlign: 'left',
          padding: 0,
          background: theme.color.surface,
          border: `1px solid ${theme.color.border}`,
          borderRadius: 14,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'stretch',
          // Card floor — was 64, raised to give each row a bit more
          // vertical breathing room (~5mm taller at typical kiosk DPI)
          // so the time / name / status read more comfortably without
          // changing the overall information density.
          minHeight: 84,
          overflow: 'hidden',
          opacity: faded ? 0.55 : 1,
          transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor = theme.color.accent;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor = theme.color.border;
        }}
      >
        {barColor ? (
          <div style={{ width: 6, background: barColor, flexShrink: 0 }} aria-hidden />
        ) : null}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: theme.space[4], padding: theme.space[4] }}>
        <div style={{ width: 80, flexShrink: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              fontVariantNumeric: 'tabular-nums',
              color: theme.color.ink,
            }}
          >
            {formatTime(row.start_at)}
          </p>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.xs,
              color: theme.color.inkSubtle,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {durationLabel(row.start_at, row.end_at)}
          </p>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <SourceGlyph source={row.source} size={13} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{patientDisplayName(row)}</span>
          </p>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {row.join_url && (
              <img src={googleMeetIcon} height={13} aria-label="Virtual meeting" style={{ flexShrink: 0, display: 'block', width: 'auto' }} />
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {[formatBookingSummary(row), staffDisplayName(row)].filter(Boolean).join(' · ') || '—'}
            </span>
          </p>
        </div>
        {isLate ? (
          <span
            style={{
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.alert,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}
          >
            {formatLateDuration(lateMin)} late
          </span>
        ) : null}
        <StatusPill tone={tone} size="sm">
          {humaniseStatus(row.status)}
        </StatusPill>
        <ChevronRight size={18} color={theme.color.inkSubtle} aria-hidden />
        </div>
      </button>
    </li>
  );
}

function statusToTone(s: AppointmentRow['status']) {
  switch (s) {
    case 'arrived':
      return 'arrived' as const;
    case 'complete':
      return 'complete' as const;
    case 'no_show':
    case 'cancelled':
      return 'no_show' as const;
    case 'rescheduled':
      return 'cancelled' as const;
    default:
      return 'neutral' as const;
  }
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

function durationLabel(startIso: string, endIso: string): string {
  const minutes = (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
