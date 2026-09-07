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
  computeDayFreeTime,
  computeResourceUsage,
  formatMinutes,
} from '../../lib/scheduleGaps.ts';
import { formatTimeNoZone } from '../../lib/dateFormat.ts';

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
    const inputs = [...pools.data]
      .sort((a, b) => (a.kind === b.kind ? a.display_name.localeCompare(b.display_name) : a.kind === 'staff_role' ? -1 : 1))
      .map((p) => ({
        id: p.id,
        name: p.display_name,
        kind: p.kind,
        units: p.units,
        staffNames: (assignments.byPoolId[p.id] ?? []).map((id) => nameById.get(id)).filter((n): n is string => !!n).sort(),
      }));
    return computeResourceUsage({ rows, dateIso, hours, now, isToday, isPast, pools: inputs });
  }, [pools.data, assignments.byPoolId, staff.data, rows, dateIso, hours, now, isToday, isPast]);

  const tense = isPast ? 'was' : isToday ? 'is' : 'will be';
  const closed = !overall.open;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Down time"
      description={
        closed
          ? `The clinic is closed on ${dayLabel}.`
          : `How ${dayLabel} ${tense} used, ${formatTimeNoZone(overall.opensAt!)} to ${formatTimeNoZone(overall.closesAt!)}. Busy means a booking needs them in that phase; a repair or manufacture phase leaves the desk free.`
      }
    >
      {closed ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          <ResourceBlock
            name="Patients in"
            detail="Any patient in the building or on a call"
            usage={overall.usage!}
            unused={false}
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
                  r.kind === 'staff_role'
                    ? r.staffNames.length > 0
                      ? r.staffNames.join(', ')
                      : 'No staff assigned'
                    : `${r.units} ${r.units === 1 ? 'room' : 'rooms'}`
                }
                usage={r.usage}
                unused={r.unused}
              />
            ))
          )}
          <Legend />
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
  showLab = false,
}: {
  name: string;
  detail: string;
  usage: DayUsage;
  unused: boolean;
  /** Lab and manufacture time only means something for the day as a
   *  whole; for a role it is just "the phases that are not mine". */
  showLab?: boolean;
}) {
  return (
    <section aria-label={name} style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: theme.space[3], flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>{name}</span>
          <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>{detail}</span>
        </div>
        <Figures usage={usage} unused={unused} showLab={showLab} />
      </div>
      <UsageBar usage={usage} />
    </section>
  );
}

function Figures({ usage, unused, showLab }: { usage: DayUsage; unused: boolean; showLab: boolean }) {
  if (unused) {
    return <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkSubtle }}>No booking needs this</span>;
  }
  const parts: Array<{ label: string; minutes: number; colour: string }> = [
    { label: 'busy', minutes: usage.bookedMinutes, colour: theme.color.ink },
    { label: 'down', minutes: usage.downMinutes, colour: theme.color.inkMuted },
    { label: 'free to fill', minutes: usage.freeMinutes, colour: theme.color.accent },
  ].filter((p) => p.minutes > 0);
  return (
    <span style={{ display: 'inline-flex', gap: theme.space[3], fontSize: theme.type.size.sm, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
      {parts.map((p) => (
        <span key={p.label} style={{ color: p.colour, fontWeight: theme.type.weight.semibold }}>
          {formatMinutes(p.minutes)} <span style={{ fontWeight: theme.type.weight.regular }}>{p.label}</span>
        </span>
      ))}
      {showLab && usage.labMinutes > 0 ? (
        <span style={{ color: theme.color.inkSubtle }}>
          {formatMinutes(usage.labMinutes)} <span>lab alongside</span>
        </span>
      ) : null}
    </span>
  );
}

// The opening hours as one bar, opening on the left, closing on the
// right. Each segment is sized by its minutes. A thin ink tick marks
// now on today's view.
export function UsageBar({ usage }: { usage: DayUsage }) {
  return (
    <div
      role="img"
      aria-label={`${formatMinutes(usage.bookedMinutes)} busy, ${formatMinutes(usage.downMinutes)} down, ${formatMinutes(usage.freeMinutes)} free to fill, ${formatMinutes(usage.lunchMinutes)} lunch`}
      style={{ position: 'relative', display: 'flex', height: 14, borderRadius: theme.radius.pill, overflow: 'hidden', background: theme.color.bg, border: `1px solid ${theme.color.border}` }}
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
  const items: UsageKind[] = ['booked', 'down', 'free', 'lunch'];
  return (
    <div style={{ display: 'flex', gap: theme.space[4], flexWrap: 'wrap' }} aria-hidden>
      {items.map((k) => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2], fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
          <span style={{ width: 14, height: 10, borderRadius: 3, border: `1px solid ${theme.color.border}`, ...styleFor(k) }} />
          {labelFor(k)}
        </span>
      ))}
    </div>
  );
}
