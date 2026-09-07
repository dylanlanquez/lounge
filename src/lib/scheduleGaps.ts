import type { NormalisedDayHours } from './queries/clinicSettings.ts';

// Free time and down time on the schedule, from reception's chair.
//
// Dylan, 7 Sep 2026: the list read as though the day ended at the last
// appointment. It must show how much of the day is still open before
// closing, and the real down time through the day, so the desk knows
// what needs filling.
//
// "Busy" is measured the way reception experiences it: a booking only
// ties the desk up while the patient is in (its patient_required
// phases: Book-in, Impression, Try In, Video call). A denture repair
// booked for 40 minutes has the patient in for 10 of them; the 30
// minutes of Repair are lab work, and another patient can be booked in
// then. Lab and manufacture phases are totted up separately so the day
// summary still shows the work that ran alongside.
//
// A booking with no stored phases (should not happen: every booking
// materialises them) counts its whole span as patient time, which is
// the safe over-estimate.

export interface FreeWindow {
  /** ISO instants. */
  start: string;
  end: string;
  minutes: number;
}

export interface DayFreeTime {
  /** The clinic is open on this date. */
  open: boolean;
  /** ISO instants for opening and closing, null when closed. */
  opensAt: string | null;
  closesAt: string | null;
  /** Lunch break, when set for the day. */
  lunch: { start: string; end: string } | null;
  /** Free stretches still ahead, in chronological order, each at least
   *  MIN_FREE_MINUTES. */
  windows: FreeWindow[];
  /** Sum of the windows. */
  freeMinutes: number;
  /** Down time: stretches that have already gone by with nothing
   *  booked (today up to now; a past day in full). Same threshold. */
  downWindows: FreeWindow[];
  downMinutes: number;
  /** Today only: the clinic has already closed. */
  closedForToday: boolean;
  /** The date is before today. */
  past: boolean;
  usage: DayUsage | null;
}

/** Shorter gaps are changeovers, not bookable slots. A Book-in phase
 *  is 5 to 10 minutes, so 15 minutes is the smallest useful stretch. */
export const MIN_FREE_MINUTES = 15;

/** Statuses that hold their slot. Cancelled, rescheduled and no-show
 *  rows free the time up again. */
const BLOCKING = new Set(['booked', 'arrived', 'joined', 'in_progress', 'complete', 'ended_early', 'unsuitable']);

export interface GapRowPhase {
  patient_required: boolean;
  start_at: string;
  end_at: string;
  pool_ids?: string[];
}

export interface GapRow {
  start_at: string;
  end_at: string;
  status: string;
  phases?: GapRowPhase[];
}

export type UsageKind = 'booked' | 'lunch' | 'down' | 'free';

export interface UsageSegment {
  kind: UsageKind;
  start: string;
  end: string;
  minutes: number;
}

/** How the opening hours were, and will be, used. Segments run from
 *  opening to closing in order and sum to openMinutes. */
export interface DayUsage {
  segments: UsageSegment[];
  openMinutes: number;
  /** Patient in (and the short changeovers between): open − lunch − down − free. */
  bookedMinutes: number;
  lunchMinutes: number;
  downMinutes: number;
  freeMinutes: number;
  /** Repair and manufacture phases, which run alongside the desk. */
  labMinutes: number;
  /** Where "now" falls as a fraction of the opening hours, today only. */
  nowFraction: number | null;
}

const NONE: DayFreeTime = {
  open: false,
  opensAt: null,
  closesAt: null,
  lunch: null,
  windows: [],
  freeMinutes: 0,
  downWindows: [],
  downMinutes: 0,
  closedForToday: false,
  past: false,
  usage: null,
};

export function computeDayFreeTime(input: {
  rows: GapRow[];
  dateIso: string;
  hours: NormalisedDayHours | null;
  now: Date;
  isToday: boolean;
  /** The date is before today: the whole day is down time, nothing left to fill. */
  isPast: boolean;
  /** Which phases tie the resource up. Default: the patient is in. For
   *  a staff role or a room: the phase names its pool. */
  busyPhase?: (phase: GapRowPhase) => boolean;
  /** A booking with no stored phases: count its whole span as busy
   *  (true, the safe default for the desk) or skip it (a pool view has
   *  no way to know). */
  countUnphased?: boolean;
}): DayFreeTime {
  const { rows, dateIso, hours, now, isToday, isPast } = input;
  const busyPhase = input.busyPhase ?? ((p: GapRowPhase) => p.patient_required);
  const countUnphased = input.countUnphased ?? true;
  if (!hours) return NONE;

  const opensAt = londonWallClockToDate(dateIso, hours.open);
  const closesAt = londonWallClockToDate(dateIso, hours.close);
  if (!opensAt || !closesAt || closesAt.getTime() <= opensAt.getTime()) return NONE;
  const lunch =
    hours.break
      ? (() => {
          const s = londonWallClockToDate(dateIso, hours.break.start);
          const e = londonWallClockToDate(dateIso, hours.break.end);
          return s && e && e.getTime() > s.getTime() ? { start: s.toISOString(), end: e.toISOString() } : null;
        })()
      : null;

  const base = {
    open: true,
    opensAt: opensAt.toISOString(),
    closesAt: closesAt.toISOString(),
    lunch,
  };

  // Busy intervals: the patient-present phases of every blocking
  // booking, plus lunch. Lab phases are kept aside for the summary.
  const busy: Array<[number, number]> = [];
  const lab: Array<[number, number]> = [];
  for (const r of rows) {
    if (!BLOCKING.has(r.status)) continue;
    const phases = (r.phases ?? []).filter((p) => validSpan(p.start_at, p.end_at));
    if (phases.length === 0) {
      if (countUnphased && validSpan(r.start_at, r.end_at)) busy.push([ms(r.start_at), ms(r.end_at)]);
      continue;
    }
    for (const p of phases) {
      (busyPhase(p) ? busy : lab).push([ms(p.start_at), ms(p.end_at)]);
    }
  }
  const lunchSpan: [number, number] | null = lunch ? [ms(lunch.start), ms(lunch.end)] : null;
  if (lunchSpan) busy.push(lunchSpan);
  busy.sort((a, b) => a[0] - b[0]);

  // The day splits at "now": what went by is down time, what is ahead
  // is free to fill. Today's split is the next whole minute so the
  // first free row sits just after the live now-line, never a few
  // seconds before it. A past day is all down time; a future day is
  // all still to fill.
  const nextMinute = Math.ceil(now.getTime() / 60_000) * 60_000;
  const open = opensAt.getTime();
  const close = closesAt.getTime();
  const split = isPast ? close : isToday ? Math.min(Math.max(nextMinute, open), close) : open;

  const downWindows = gapsBetween(busy, open, split);
  const windows = gapsBetween(busy, split, close);
  const freeMinutes = windows.reduce((sum, w) => sum + w.minutes, 0);
  const downMinutes = downWindows.reduce((sum, w) => sum + w.minutes, 0);

  return {
    ...base,
    windows,
    freeMinutes,
    downWindows,
    downMinutes,
    closedForToday: isToday && split >= close,
    past: isPast,
    usage: buildUsage({ open, close, lunchSpan, downWindows, windows, lab, now, isToday }),
  };
}

// The opening hours laid out as segments. Lunch, down and free are
// exact intervals; whatever is left is booked (patient in, plus the
// short changeovers the threshold folded in). Lab time overlaps and
// is only totalled.
function buildUsage(input: {
  open: number;
  close: number;
  lunchSpan: [number, number] | null;
  downWindows: FreeWindow[];
  windows: FreeWindow[];
  lab: Array<[number, number]>;
  now: Date;
  isToday: boolean;
}): DayUsage {
  const { open, close, lunchSpan, downWindows, windows, lab, now, isToday } = input;
  const fixed: Array<{ kind: UsageKind; s: number; e: number }> = [];
  if (lunchSpan) fixed.push({ kind: 'lunch', s: clamp(lunchSpan[0], open, close), e: clamp(lunchSpan[1], open, close) });
  for (const w of downWindows) fixed.push({ kind: 'down', s: ms(w.start), e: ms(w.end) });
  for (const w of windows) fixed.push({ kind: 'free', s: ms(w.start), e: ms(w.end) });
  fixed.sort((a, b) => a.s - b.s);

  const segments: UsageSegment[] = [];
  const add = (kind: UsageKind, s: number, e: number) => {
    if (e <= s) return;
    const last = segments[segments.length - 1];
    if (last && last.kind === kind && ms(last.end) === s) {
      last.end = new Date(e).toISOString();
      last.minutes = Math.round((e - ms(last.start)) / 60_000);
      return;
    }
    segments.push({ kind, start: new Date(s).toISOString(), end: new Date(e).toISOString(), minutes: Math.round((e - s) / 60_000) });
  };
  let cursor = open;
  for (const f of fixed) {
    if (f.e <= cursor) continue;
    if (f.s > cursor) add('booked', cursor, f.s);
    add(f.kind, Math.max(f.s, cursor), f.e);
    cursor = Math.max(cursor, f.e);
  }
  if (cursor < close) add('booked', cursor, close);

  const total = (kind: UsageKind) => segments.filter((x) => x.kind === kind).reduce((sum, x) => sum + x.minutes, 0);
  const openMinutes = Math.round((close - open) / 60_000);
  const nowMs = now.getTime();
  return {
    segments,
    openMinutes,
    bookedMinutes: total('booked'),
    lunchMinutes: total('lunch'),
    downMinutes: total('down'),
    freeMinutes: total('free'),
    labMinutes: unionMinutes(lab.map(([s, e]) => [clamp(s, open, close), clamp(e, open, close)])),
    nowFraction: isToday && nowMs >= open && nowMs <= close ? (nowMs - open) / (close - open) : null,
  };
}

function unionMinutes(spans: Array<[number, number]>): number {
  const sorted = spans.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = -1;
  let curE = -1;
  for (const [s, e] of sorted) {
    if (s > curE) {
      if (curE > curS) total += curE - curS;
      curS = s;
      curE = e;
    } else if (e > curE) {
      curE = e;
    }
  }
  if (curE > curS) total += curE - curS;
  return Math.round(total / 60_000);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

function validSpan(start: string, end: string): boolean {
  const s = ms(start);
  const e = ms(end);
  return !Number.isNaN(s) && !Number.isNaN(e) && e > s;
}

/** Free stretches inside [from, to) once the busy intervals are removed. */
function gapsBetween(busy: Array<[number, number]>, from: number, to: number): FreeWindow[] {
  const out: FreeWindow[] = [];
  if (from >= to) return out;
  let cursor = from;
  for (const [s, e] of busy) {
    if (e <= cursor) continue;
    if (s >= to) break;
    if (s > cursor) pushWindow(out, cursor, Math.min(s, to));
    cursor = Math.max(cursor, e);
    if (cursor >= to) break;
  }
  if (cursor < to) pushWindow(out, cursor, to);
  return out;
}

function pushWindow(out: FreeWindow[], start: number, end: number): void {
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < MIN_FREE_MINUTES) return;
  out.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), minutes });
}

/** "2h 40m", "45m", "3h". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** A London wall-clock time on a date, as an instant. Handles BST/GMT
 *  by asking Intl what the offset is on that date. */
export function londonWallClockToDate(dateIso: string, hhmm: string): Date | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!m || !d) return null;
  const [, hh, mm] = m;
  const [, y, mo, da] = d;
  // Start from the UTC instant with those digits, then correct by the
  // zone offset that applies at that moment in London.
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(da), Number(hh), Number(mm));
  const offsetMin = londonOffsetMinutes(new Date(guess));
  const corrected = guess - offsetMin * 60_000;
  // One more pass in case the correction crossed a DST boundary.
  const offset2 = londonOffsetMinutes(new Date(corrected));
  return new Date(guess - offset2 * 60_000);
}

function londonOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

// ── Per resource ───────────────────────────────────────────────────────
// Dylan, 7 Sep 2026: "it should be for each resource to make it actually
// make sense". Reception is only needed for Book-in, the impression
// clinician for Impression, the virtual clinician for Video call, the
// room for Impression and Manufacture. Each phase names the pools it
// needs, so each pool's busy time is the union of the phases naming it.

export interface ResourceUsageInput {
  id: string;
  name: string;
  kind: 'resource' | 'staff_role';
  /** Names of the staff assigned to the role (empty for a room). */
  staffNames: string[];
  units: number;
}

export interface ResourceUsage extends ResourceUsageInput {
  usage: DayUsage;
  /** No booking on the day names this pool at all. */
  unused: boolean;
}

export function computeResourceUsage(input: {
  rows: GapRow[];
  dateIso: string;
  hours: NormalisedDayHours | null;
  now: Date;
  isToday: boolean;
  isPast: boolean;
  pools: ResourceUsageInput[];
}): ResourceUsage[] {
  const { rows, dateIso, hours, now, isToday, isPast, pools } = input;
  const out: ResourceUsage[] = [];
  for (const pool of pools) {
    const named = rows.some((r) => BLOCKING.has(r.status) && (r.phases ?? []).some((p) => (p.pool_ids ?? []).includes(pool.id)));
    const day = computeDayFreeTime({
      rows,
      dateIso,
      hours,
      now,
      isToday,
      isPast,
      busyPhase: (p) => (p.pool_ids ?? []).includes(pool.id),
      countUnphased: false,
    });
    if (!day.usage) continue;
    out.push({ ...pool, usage: day.usage, unused: !named });
  }
  return out;
}
