import type { NormalisedDayHours } from './queries/clinicSettings.ts';

// Free time on the schedule.
//
// Dylan, 7 Sep 2026: the list read as though the day ended at the last
// appointment. It must show how much of the day is still open before
// closing, so the desk knows those slots need filling. Every stretch of
// opening hours with nothing booked becomes a "free" row in the list,
// from now (today) or from opening time (a future day) until the
// clinic closes, minus the lunch break. Past days have no free time.

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
}

/** Shorter gaps are not bookable in practice and would litter the list. */
export const MIN_FREE_MINUTES = 30;

/** Statuses that hold their slot. Cancelled, rescheduled and no-show
 *  rows free the time up again. */
const BLOCKING = new Set(['booked', 'arrived', 'joined', 'in_progress', 'complete', 'ended_early', 'unsuitable']);

export interface GapRow {
  start_at: string;
  end_at: string;
  status: string;
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
};

export function computeDayFreeTime(input: {
  rows: GapRow[];
  dateIso: string;
  hours: NormalisedDayHours | null;
  now: Date;
  isToday: boolean;
  /** The date is before today: the whole day is down time, nothing left to fill. */
  isPast: boolean;
}): DayFreeTime {
  const { rows, dateIso, hours, now, isToday, isPast } = input;
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

  // Busy intervals: every blocking booking, plus lunch.
  const busy: Array<[number, number]> = [];
  for (const r of rows) {
    if (!BLOCKING.has(r.status)) continue;
    const s = new Date(r.start_at).getTime();
    const e = new Date(r.end_at).getTime();
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) continue;
    busy.push([s, e]);
  }
  if (lunch) busy.push([new Date(lunch.start).getTime(), new Date(lunch.end).getTime()]);
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

  return {
    ...base,
    windows,
    freeMinutes: windows.reduce((sum, w) => sum + w.minutes, 0),
    downWindows,
    downMinutes: downWindows.reduce((sum, w) => sum + w.minutes, 0),
    closedForToday: isToday && split >= close,
    past: isPast,
  };
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
