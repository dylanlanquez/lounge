import { addDaysIso, formatDateIso, getWeekStartIso, todayIso } from './calendarMonth.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Date-range primitive used across Reports and Financials.
//
// A `DateRange` is two ISO local-time YYYY-MM-DD strings, both inclusive:
// the range covers every calendar day from `start` through `end`. Reports
// translate that into millisecond bounds when querying timestamptz columns
// (start at 00:00:00 local, end at 23:59:59.999 local, then convert to UTC
// for the SQL filter — see `dateRangeToUtcBounds` below).
//
// `preset` records which preset shortcut produced the range, or 'custom' if
// the user picked dates by hand. The picker label uses this to show
// "Last 30 days" rather than "12 Apr → 25 Apr" when a preset is active.
//
// All helpers are pure and unit-tested in dateRange.test.ts. Time of day
// is intentionally NOT part of DateRange — reports work on calendar days,
// timezones make any sub-day precision a liability across daylight saving.
// ─────────────────────────────────────────────────────────────────────────────

export type DateRangePresetId =
  | 'today'
  | 'yesterday'
  | 'last_7'
  | 'last_30'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'this_year'
  | 'custom';

export interface DateRange {
  start: string; // YYYY-MM-DD inclusive
  end: string;   // YYYY-MM-DD inclusive
  preset: DateRangePresetId;
}

export interface DateRangePreset {
  id: DateRangePresetId;
  label: string;
  resolve: (now: Date) => Omit<DateRange, 'preset'>;
}

// The set of presets we offer in the picker. 'custom' is intentionally
// missing from this list — custom is what the user lands on after typing
// dates by hand. Every other entry surfaces as a clickable shortcut.
export const DATE_RANGE_PRESETS: DateRangePreset[] = [
  {
    id: 'today',
    label: 'Today',
    resolve: (now) => {
      const t = todayIso(now);
      return { start: t, end: t };
    },
  },
  {
    id: 'yesterday',
    label: 'Yesterday',
    resolve: (now) => {
      const y = addDaysIso(todayIso(now), -1);
      return { start: y, end: y };
    },
  },
  {
    id: 'last_7',
    label: 'Last 7 days',
    resolve: (now) => {
      const t = todayIso(now);
      return { start: addDaysIso(t, -6), end: t };
    },
  },
  {
    id: 'last_30',
    label: 'Last 30 days',
    resolve: (now) => {
      const t = todayIso(now);
      return { start: addDaysIso(t, -29), end: t };
    },
  },
  {
    id: 'this_week',
    label: 'This week',
    resolve: (now) => {
      const t = todayIso(now);
      const start = getWeekStartIso(t);
      return { start, end: addDaysIso(start, 6) };
    },
  },
  {
    id: 'last_week',
    label: 'Last week',
    resolve: (now) => {
      const t = todayIso(now);
      const lastWeekStart = addDaysIso(getWeekStartIso(t), -7);
      return { start: lastWeekStart, end: addDaysIso(lastWeekStart, 6) };
    },
  },
  {
    id: 'this_month',
    label: 'This month',
    resolve: (now) => monthRange(now.getFullYear(), now.getMonth()),
  },
  {
    id: 'last_month',
    label: 'Last month',
    resolve: (now) => {
      const m = now.getMonth() - 1;
      const carryYear = m < 0 ? now.getFullYear() - 1 : now.getFullYear();
      const carryMonth = m < 0 ? 11 : m;
      return monthRange(carryYear, carryMonth);
    },
  },
  {
    id: 'this_quarter',
    label: 'This quarter',
    resolve: (now) => quarterRange(now.getFullYear(), now.getMonth()),
  },
  {
    id: 'this_year',
    label: 'This year',
    resolve: (now) => ({
      start: formatDateIso(new Date(now.getFullYear(), 0, 1)),
      end: formatDateIso(new Date(now.getFullYear(), 11, 31)),
    }),
  },
];

// Resolve a preset to a concrete range using the supplied "now" (defaults
// to the current time but parameterised so tests are deterministic). The
// returned range carries the preset id so the picker label stays human.
export function resolvePreset(id: DateRangePresetId, now: Date = new Date()): DateRange {
  if (id === 'custom') {
    // Custom has no resolver — caller must pass dates explicitly via
    // makeCustomRange() or by editing an existing range's dates.
    throw new Error("resolvePreset cannot expand 'custom' — use makeCustomRange()");
  }
  const preset = DATE_RANGE_PRESETS.find((p) => p.id === id);
  if (!preset) {
    throw new Error(`Unknown DateRange preset: ${id}`);
  }
  const { start, end } = preset.resolve(now);
  return { start, end, preset: id };
}

// Construct a custom range from arbitrary start/end ISO dates. Validates
// that both are well-formed YYYY-MM-DD and that end >= start. Throws on
// invalid input — every behaviour-driving check fails loudly.
export function makeCustomRange(start: string, end: string): DateRange {
  if (!isIsoDate(start)) throw new Error(`Invalid start date: ${start}`);
  if (!isIsoDate(end)) throw new Error(`Invalid end date: ${end}`);
  if (end < start) {
    throw new Error(`End date ${end} is before start date ${start}`);
  }
  return { start, end, preset: 'custom' };
}

// Default range a fresh page lands on. Matches the "Last 30 days" preset
// — long enough to show trends, short enough to keep queries fast. The
// caller can swap to any preset via the picker.
export function defaultDateRange(now: Date = new Date()): DateRange {
  return resolvePreset('last_30', now);
}

// Translates a calendar-day range into UTC ISO timestamps suitable for
// passing to .gte() / .lte() filters on timestamptz columns. Local
// midnight on `start` becomes the lower bound; the millisecond before
// local midnight on `end + 1 day` becomes the upper bound. This keeps
// the range inclusive on both ends and captures every payment / visit
// that landed on those calendar days as a UK clinic operator sees them.
export function dateRangeToUtcBounds(range: DateRange): { fromIso: string; toIso: string } {
  const fromLocal = new Date(`${range.start}T00:00:00`);
  // End-of-day = start of next day - 1ms
  const nextDay = addDaysIso(range.end, 1);
  const toLocal = new Date(`${nextDay}T00:00:00`);
  toLocal.setMilliseconds(toLocal.getMilliseconds() - 1);
  return {
    fromIso: fromLocal.toISOString(),
    toIso: toLocal.toISOString(),
  };
}

// Human label for the picker trigger. Shows the preset name when the
// range matches a preset; falls back to "12 Apr → 25 Apr" / "12 Apr 2026"
// for custom or single-day ranges.
export function dateRangeLabel(range: DateRange): string {
  if (range.preset !== 'custom') {
    const preset = DATE_RANGE_PRESETS.find((p) => p.id === range.preset);
    if (!preset) {
      throw new Error(`Unknown preset on DateRange: ${range.preset}`);
    }
    return preset.label;
  }
  if (range.start === range.end) {
    return formatDayLong(range.start);
  }
  return `${formatDayShort(range.start)} → ${formatDayShort(range.end)}`;
}

function formatDayShort(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
}

function formatDayLong(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function monthRange(year: number, month: number): Omit<DateRange, 'preset'> {
  const start = formatDateIso(new Date(year, month, 1));
  // Day 0 of next month = last day of this month, regardless of length.
  const end = formatDateIso(new Date(year, month + 1, 0));
  return { start, end };
}

function quarterRange(year: number, month: number): Omit<DateRange, 'preset'> {
  const quarterStartMonth = Math.floor(month / 3) * 3;
  const start = formatDateIso(new Date(year, quarterStartMonth, 1));
  const end = formatDateIso(new Date(year, quarterStartMonth + 3, 0));
  return { start, end };
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  return formatDateIso(d) === s; // round-trip catches e.g. 2026-02-31
}
