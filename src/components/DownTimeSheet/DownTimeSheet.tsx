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
          : `${dayLabel}, open ${span}. For each person and room: how much of the day a booking needed them, how much nobody did, and how much is still open to book. Percentages are of the open day.`
      }
    >
      {closed ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[6] }}>
          <Legend />
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold, color: theme.color.ink, letterSpacing: theme.type.tracking.tight }}>
          {name}
        </span>
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>{detail}</span>
      </div>
      {unused ? (
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkSubtle }}>
          {isPast ? 'No booking needed them that day.' : 'No booking needs them.'}
        </p>
      ) : (
        <>
          <Stats usage={usage} />
          <SummaryBar usage={usage} />
        </>
      )}
      {showLab && usage.labMinutes > 0 ? (
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          Repairs and manufacturing {isPast ? 'ran' : 'run'} for {formatMinutes(usage.labMinutes)} alongside. That time needs nobody at the desk.
        </p>
      ) : null}
    </section>
  );
}

// Three tiles: busy, down, free. A big figure, a plain word, and the
// share of the open day, so "3h 5m down · 39% of the day" lands
// without reading a chart.
function Stats({ usage }: { usage: DayUsage }) {
  const share = (m: number) => (usage.openMinutes > 0 ? Math.round((m / usage.openMinutes) * 100) : 0);
  const tiles: Array<{ kind: UsageKind; minutes: number }> = [
    { kind: 'booked', minutes: usage.bookedMinutes },
    { kind: 'down', minutes: usage.downMinutes },
    { kind: 'free', minutes: usage.freeMinutes },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: theme.space[2] }}>
      {tiles.map((t) => (
        <div
          key={t.kind}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            padding: `${theme.space[3]}px ${theme.space[3]}px`,
            borderRadius: theme.radius.input,
            background: theme.color.bg,
            border: `1px solid ${theme.color.border}`,
            minWidth: 0,
            opacity: t.minutes === 0 ? 0.55 : 1,
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2], fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
            <Swatch kind={t.kind} />
            {labelFor(t.kind)}
          </span>
          <span
            style={{
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              color: t.kind === 'free' ? theme.color.accent : theme.color.ink,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: theme.type.tracking.tight,
              lineHeight: theme.type.leading.tight,
            }}
          >
            {t.minutes === 0 ? 'None' : formatMinutes(t.minutes)}
          </span>
          <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle, fontVariantNumeric: 'tabular-nums' }}>
            {t.minutes === 0 ? '\u00a0' : `${share(t.minutes)}%`}
          </span>
        </div>
      ))}
    </div>
  );
}

// One bar, always in the same order: busy, down, free, lunch. Not a
// timeline; just how the open hours divide up.
function SummaryBar({ usage }: { usage: DayUsage }) {
  const all: Array<{ kind: UsageKind; minutes: number }> = [
    { kind: 'booked', minutes: usage.bookedMinutes },
    { kind: 'down', minutes: usage.downMinutes },
    { kind: 'free', minutes: usage.freeMinutes },
    { kind: 'lunch', minutes: usage.lunchMinutes },
  ];
  const parts = all.filter((p) => p.minutes > 0);
  return (
    <div
      role="img"
      aria-label={parts.map((p) => `${labelFor(p.kind)} ${formatMinutes(p.minutes)}`).join(', ')}
      style={{ display: 'flex', height: 12, borderRadius: theme.radius.pill, overflow: 'hidden', background: theme.color.bg, border: `1px solid ${theme.color.border}` }}
    >
      {parts.map((p, i) => (
        <div key={p.kind} title={`${labelFor(p.kind)} ${formatMinutes(p.minutes)}`} style={{ flex: `${p.minutes} 0 0`, minWidth: 0, ...styleFor(p.kind), borderLeft: i === 0 ? 'none' : `2px solid ${theme.color.surface}` }} />
      ))}
    </div>
  );
}

function Swatch({ kind }: { kind: UsageKind }) {
  return <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, border: `1px solid ${theme.color.border}`, flexShrink: 0, ...styleFor(kind) }} />;
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
    { kind: 'booked', hint: 'a booking needed them' },
    { kind: 'down', hint: 'nobody did' },
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
