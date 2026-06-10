import { Fragment } from 'react';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import googleMeetIcon from '../../assets/google-meet.png';
import { SourceGlyph } from '../AppointmentCard/AppointmentCard.tsx';
import { StatusPill } from '../StatusPill/StatusPill.tsx';
import { theme } from '../../theme/index.ts';
import {
  type AppointmentRow,
  appointmentCategory,
  formatAppointmentSummary,
  formatLateDuration,
  humaniseStatus,
  isAppointmentDimmed,
  isBookingLate,
  minutesPastStart,
  patientDisplayName,
  staffDisplayName,
} from '../../lib/queries/appointments.ts';
import { useNow } from '../../lib/useNow.ts';
import { fmtTzAbbr } from '../../lib/dateFormat.ts';

export interface ScheduleListViewProps {
  rows: AppointmentRow[];
  onPick: (row: AppointmentRow) => void;
  // When true (the selected day is today) a live "now" marker is drawn
  // between the appointments that have already started and those still
  // to come, and re-positions itself as time passes.
  isToday?: boolean;
}

export function ScheduleListView({ rows, onPick, isToday = false }: ScheduleListViewProps) {
  const now = useNow();
  const sorted = [...rows].sort((a, b) =>
    a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : 0
  );
  // Morning/afternoon split is computed in clinic time so a 12:01 BST
  // booking always lands under Afternoon for every viewer, regardless
  // of the staff member's device timezone.
  const morning = sorted.filter((r) => londonHour(r.start_at) < 12);
  const afternoon = sorted.filter((r) => londonHour(r.start_at) >= 12);

  // Global index where the now-marker sits: the count of appointments
  // that have already started, so it lands just before the first one
  // still to come. -1 disables it (not today, or no appointments).
  const showNow = isToday && sorted.length > 0;
  const nowAt = showNow
    ? sorted.filter((r) => new Date(r.start_at).getTime() <= now.getTime()).length
    : -1;
  const hasAfternoon = afternoon.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      {morning.length > 0 ? (
        <Section
          label="Morning"
          rows={morning}
          onPick={onPick}
          now={now}
          startIndex={0}
          nowAt={nowAt}
          isLast={!hasAfternoon}
        />
      ) : null}
      {hasAfternoon ? (
        <Section
          label="Afternoon"
          rows={afternoon}
          onPick={onPick}
          now={now}
          startIndex={morning.length}
          nowAt={nowAt}
          isLast
        />
      ) : null}
    </div>
  );
}

function Section({
  label,
  rows,
  onPick,
  now,
  startIndex,
  nowAt,
  isLast,
}: {
  label: string;
  rows: AppointmentRow[];
  onPick: (r: AppointmentRow) => void;
  now: Date;
  // Index of this section's first row in the full sorted day, so the
  // now-marker can be placed by a single global index.
  startIndex: number;
  nowAt: number;
  isLast: boolean;
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
        {rows.map((r, i) => (
          <Fragment key={r.id}>
            {nowAt === startIndex + i ? <NowMarker now={now} /> : null}
            <ScheduleListRow row={r} onPick={() => onPick(r)} now={now} />
          </Fragment>
        ))}
        {/* Now is past every appointment in the day: marker at the foot
            of the last section. */}
        {isLast && nowAt === startIndex + rows.length ? <NowMarker now={now} /> : null}
      </ul>
    </div>
  );
}

// Live current-time line drawn inside the list on today's view. A small
// dot + clock label on the left, a hairline rule filling the rest.
function NowMarker({ now }: { now: Date }) {
  return (
    <li
      aria-label={`Current time, ${formatClock(now)}`}
      style={{ listStyle: 'none', display: 'flex', alignItems: 'center', gap: theme.space[2], padding: `${theme.space[1]}px 0` }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.accent,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: theme.color.accent }} aria-hidden />
        {formatClock(now)}
      </span>
      <span style={{ flex: 1, height: 2, background: theme.color.accent, borderRadius: 1 }} aria-hidden />
    </li>
  );
}

function formatClock(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const period = (parts.find((p) => p.type === 'dayPeriod')?.value ?? '').toLowerCase();
  return `${get('hour')}:${get('minute')} ${period}`.trim();
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
      ? theme.category[appointmentCategory(row)]
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
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: theme.space[4], padding: theme.space[4] }}>
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
              fontWeight: theme.type.weight.medium,
              color: theme.color.inkSubtle,
              letterSpacing: theme.type.tracking.wide,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {fmtTzAbbr(row.start_at)}
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
            {isLate ? (
              <AlertTriangle
                size={14}
                color={theme.color.alert}
                strokeWidth={2.25}
                aria-label={`${formatLateDuration(lateMin)} late — likely no-show`}
                style={{ flexShrink: 0 }}
              />
            ) : null}
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
              {[formatAppointmentSummary(row), staffDisplayName(row)].filter(Boolean).join(' · ') || '—'}
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
        <span style={{ flexShrink: 0 }}>
          <StatusPill tone={tone} size="sm">
            {humaniseStatus(row.status)}
          </StatusPill>
        </span>
        <ChevronRight size={18} color={theme.color.inkSubtle} aria-hidden style={{ flexShrink: 0 }} />
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
  // Per-row time is rendered without the BST/GMT suffix to keep
  // the 80px time column clean. The zone is surfaced once per
  // section in the Morning / Afternoon header above so the time
  // still reads unambiguously, just without the visual clutter of
  // repeating "BST" on every row.
  const { hour: h, minute: m } = londonHourMinute(iso);
  const hh = h % 12 === 0 ? 12 : h % 12;
  const mm = m === 0 ? '' : `:${String(m).padStart(2, '0')}`;
  const ampm = h < 12 ? 'am' : 'pm';
  return `${hh}${mm}${ampm}`;
}

function londonHour(iso: string): number {
  return londonHourMinute(iso).hour;
}

function londonHourMinute(iso: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { hour, minute };
}

