import { useMemo } from 'react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { theme } from '../../theme/index.ts';
import type { NormalisedDayHours } from '../../lib/queries/clinicSettings.ts';
import { useResourcePools } from '../../lib/queries/bookingTypes.ts';
import { useAllStaffPoolAssignments } from '../../lib/queries/staffPoolAssignments.ts';
import { useStaff } from '../../lib/queries/staff.ts';
import {
  type DayUsage,
  type GapRow,
  type ResourceUsage,
  type UsageKind,
  VIDEO_CALL_POOL,
  computeDayFreeTime,
  computeResourceUsage,
  formatMinutes,
} from '../../lib/scheduleGaps.ts';
import { formatTimeNoZone } from '../../lib/dateFormat.ts';

// Reception's work is booked under the "Miscellaneous" pool in Admin,
// Booking types (every Book-in phase names it), while the people are
// assigned to "Reception". Dylan, 7 Sep 2026: "dont include misc". So
// Miscellaneous is folded into Reception here and not listed on its
// own. If the Book-in phases are ever re-pointed at Reception in
// Admin, this alias becomes a no-op.
const POOL_ALIASES: Record<string, string[]> = { reception: ['miscellaneous'] };
const HIDDEN_POOLS = new Set(Object.values(POOL_ALIASES).flat());
const ROLE_ORDER = ['reception', 'impression-clinician', 'virtual-impression-clinician'];

// Down time, by who is needed.
//
// One booking needs different people at different moments: reception
// for the Book-in, the impression clinician for the Impression, the
// room for the Manufacture. So "down time" only makes sense per
// resource. This sheet lays the opening hours out as a bar for the
// day as a whole (patient in) and then for every staff role and room,
// with the minutes underneath.

export interface DownTimeSheetProps {
  open: boolean;
  onClose: () => void;
  rows: GapRow[];
  dateIso: string;
  dayLabel: string;
  hours: NormalisedDayHours | null;
  now: Date;
  isToday: boolean;
  isPast: boolean;
}

export function DownTimeSheet({ open, onClose, rows, dateIso, dayLabel, hours, now, isToday, isPast }: DownTimeSheetProps) {
  const pools = useResourcePools();
  const assignments = useAllStaffPoolAssignments();
  const staff = useStaff();

  const overall = useMemo(
    () => computeDayFreeTime({ rows, dateIso, hours, now, isToday, isPast }),
    [rows, dateIso, hours, now, isToday, isPast],
  );

  const resources: ResourceUsage[] = useMemo(() => {
    const nameById = new Map(staff.data.map((s) => [s.staff_member_id, s.display_name] as const));
    const order = (p: { id: string; kind: string; display_name: string }) => {
      const i = ROLE_ORDER.indexOf(p.id);
      return i >= 0 ? i : p.kind === 'staff_role' ? 50 : 100;
    };
    const inputs = [...pools.data]
      .filter((p) => !HIDDEN_POOLS.has(p.id))
      .sort((a, b) => order(a) - order(b) || a.display_name.localeCompare(b.display_name))
      .map((p) => ({
        id: p.id,
        name: p.display_name,
        kind: p.kind,
        units: p.units,
        staffNames: (assignments.byPoolId[p.id] ?? []).map((id) => nameById.get(id)).filter((n): n is string => !!n).sort(),
        aliases: POOL_ALIASES[p.id] ?? [],
      }));
    return computeResourceUsage({ rows, dateIso, hours, now, isToday, isPast, pools: inputs });
  }, [pools.data, assignments.byPoolId, staff.data, rows, dateIso, hours, now, isToday, isPast]);

  const closed = !overall.open;
  const span = closed ? '' : `${clock12(overall.opensAt!)} to ${clock12(overall.closesAt!)}`;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Down time"
      description={
        closed
          ? `The clinic is closed on ${dayLabel}.`
          : `${dayLabel}, open ${span}. Each bar is the day for one person or room: when a booking needs them, when nobody does.`
      }
    >
      {closed ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[6] }}>
          <Legend />
          <ResourceBlock
            name="Patients in"
            detail="Any patient in the building or on a call"
            usage={overall.usage!}
            unused={false}
            isPast={isPast}
            showLab
          />
          <div style={{ height: 1, background: theme.color.border }} aria-hidden />
          {pools.loading || assignments.loading || staff.loading ? (
            <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>Loading roles and rooms…</p>
          ) : pools.error || assignments.error || staff.error ? (
            <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert }}>
              Could not load roles and rooms. {pools.error ?? assignments.error ?? staff.error}
            </p>
          ) : (
            resources.map((r) => (
              <ResourceBlock
                key={r.id}
                name={r.name}
                detail={
                  (r.kind === 'staff_role'
                    ? r.staffNames.length > 0
                      ? r.staffNames.join(', ')
                      : 'No staff assigned'
                    : `${r.units} ${r.units === 1 ? 'room' : 'rooms'}`) + (r.id === VIDEO_CALL_POOL ? ' · measured from time on the call' : '')
                }
                usage={r.usage}
                unused={r.unused}
                isPast={isPast}
              />
            ))
          )}
        </div>
      )}
    </BottomSheet>
  );
}

function ResourceBlock({
  name,
  detail,
  usage,
  unused,
  isPast,
  showLab = false,
}: {
  name: string;
  detail: string;
  usage: DayUsage;
  unused: boolean;
  isPast: boolean;
  /** Lab and manufacture time only means something for the day as a
   *  whole; for a role it is just "the phases that are not mine". */
  showLab?: boolean;
}) {
  return (
    <section aria-label={name} style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: theme.space[3], flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold, color: theme.color.ink, letterSpacing: theme.type.tracking.tight }}>
            {name}
          </span>
          <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>{detail}</span>
        </div>
        <Figures usage={usage} unused={unused} isPast={isPast} />
      </div>
      <UsageBar usage={usage} />
      {showLab && usage.labMinutes > 0 ? (
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          Repairs and manufacturing {isPast ? 'ran' : 'run'} for {formatMinutes(usage.labMinutes)} alongside. That time needs nobody at the desk.
        </p>
      ) : null}
    </section>
  );
}

// Three chips, each with the same swatch the bar uses, so the numbers
// and the colours read as one thing.
function Figures({ usage, unused, isPast }: { usage: DayUsage; unused: boolean; isPast: boolean }) {
  if (unused) {
    return (
      <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkSubtle, paddingTop: 2 }}>
        {isPast ? 'Not needed that day' : 'Not needed'}
      </span>
    );
  }
  const all: Array<{ kind: UsageKind; minutes: number }> = [
    { kind: 'booked', minutes: usage.bookedMinutes },
    { kind: 'down', minutes: usage.downMinutes },
    { kind: 'free', minutes: usage.freeMinutes },
  ];
  const parts = all.filter((p) => p.minutes > 0);
  return (
    <span style={{ display: 'inline-flex', gap: theme.space[2], flexWrap: 'wrap' }}>
      {parts.map((p) => (
        <span
          key={p.kind}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[2],
            padding: `${theme.space[1]}px ${theme.space[3]}px`,
            borderRadius: theme.radius.pill,
            background: theme.color.bg,
            border: `1px solid ${theme.color.border}`,
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          <Swatch kind={p.kind} />
          <span style={{ fontWeight: theme.type.weight.semibold }}>{formatMinutes(p.minutes)}</span>
          <span style={{ color: theme.color.inkMuted }}>{labelFor(p.kind).toLowerCase()}</span>
        </span>
      ))}
    </span>
  );
}

function Swatch({ kind }: { kind: UsageKind }) {
  return <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, border: `1px solid ${theme.color.border}`, flexShrink: 0, ...styleFor(kind) }} />;
}

// The opening hours as one bar, opening on the left, closing on the
// right. Each segment is sized by its minutes. A thin ink tick marks
// now on today's view.
export function UsageBar({ usage }: { usage: DayUsage }) {
  const first = usage.segments[0];
  const last = usage.segments[usage.segments.length - 1];
  const lunch = usage.segments.find((x) => x.kind === 'lunch');
  const lunchLeft = lunch && first ? ((new Date(lunch.start).getTime() - new Date(first.start).getTime()) / (usage.openMinutes * 60_000)) * 100 : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
      <UsageTrack usage={usage} />
      {first && last ? (
        <div style={{ position: 'relative', height: 16, fontSize: theme.type.size.xs, color: theme.color.inkSubtle, fontVariantNumeric: 'tabular-nums' }} aria-hidden>
          <span style={{ position: 'absolute', left: 0 }}>{clock12(first.start)}</span>
          {lunchLeft !== null && lunchLeft > 12 && lunchLeft < 88 ? (
            <span style={{ position: 'absolute', left: `${lunchLeft}%`, transform: 'translateX(-50%)' }}>lunch</span>
          ) : null}
          <span style={{ position: 'absolute', right: 0 }}>{clock12(last.end)}</span>
        </div>
      ) : null}
    </div>
  );
}

function UsageTrack({ usage }: { usage: DayUsage }) {
  return (
    <div
      role="img"
      aria-label={`${formatMinutes(usage.bookedMinutes)} busy, ${formatMinutes(usage.downMinutes)} down, ${formatMinutes(usage.freeMinutes)} free to fill, ${formatMinutes(usage.lunchMinutes)} lunch`}
      style={{ position: 'relative', display: 'flex', height: 18, borderRadius: 6, overflow: 'hidden', background: theme.color.bg, border: `1px solid ${theme.color.border}` }}
    >
      {usage.segments.map((seg, i) => (
        <div
          key={`${seg.kind}-${seg.start}`}
          title={`${labelFor(seg.kind)} ${formatTimeNoZone(seg.start)} to ${formatTimeNoZone(seg.end)}, ${formatMinutes(seg.minutes)}`}
          style={{
            flex: `${seg.minutes} 0 0`,
            minWidth: 0,
            ...styleFor(seg.kind),
            borderLeft: i === 0 ? 'none' : `1px solid ${theme.color.surface}`,
          }}
        />
      ))}
      {usage.nowFraction !== null ? (
        <div
          aria-hidden
          style={{ position: 'absolute', top: -1, bottom: -1, left: `${usage.nowFraction * 100}%`, width: 2, background: theme.color.ink, transform: 'translateX(-1px)' }}
        />
      ) : null}
    </div>
  );
}

function styleFor(kind: UsageKind): { background: string; backgroundImage?: string } {
  switch (kind) {
    case 'booked':
      return { background: theme.color.accent };
    case 'free':
      return {
        background: theme.color.accentBg,
        backgroundImage: `repeating-linear-gradient(135deg, ${theme.color.accent} 0 1px, transparent 1px 6px)`,
      };
    case 'down':
      return { background: theme.color.inkSubtle };
    case 'lunch':
      return { background: theme.color.bg };
  }
}

function labelFor(kind: UsageKind): string {
  switch (kind) {
    case 'booked':
      return 'Busy';
    case 'free':
      return 'Free to fill';
    case 'down':
      return 'Down time';
    case 'lunch':
      return 'Lunch';
  }
}

function Legend() {
  const items: Array<{ kind: UsageKind; hint: string }> = [
    { kind: 'booked', hint: 'a booking needs them' },
    { kind: 'down', hint: 'nobody needed them' },
    { kind: 'free', hint: 'still open to book' },
    { kind: 'lunch', hint: '' },
  ];
  return (
    <div style={{ display: 'flex', gap: theme.space[5], flexWrap: 'wrap' }} aria-hidden>
      {items.map((it) => (
        <span key={it.kind} style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2], fontSize: theme.type.size.sm, color: theme.color.ink }}>
          <Swatch kind={it.kind} />
          <span style={{ fontWeight: theme.type.weight.semibold }}>{labelFor(it.kind)}</span>
          {it.hint ? <span style={{ color: theme.color.inkMuted }}>{it.hint}</span> : null}
        </span>
      ))}
    </div>
  );
}

// "9am", "12:30pm", "5pm": the short clock the schedule rows use.
function clock12(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}${m === 0 ? '' : `:${String(m).padStart(2, '0')}`}${h < 12 ? 'am' : 'pm'}`;
}
