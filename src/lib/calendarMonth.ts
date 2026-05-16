// Local-time YYYY-MM-DD string. UTC would shift midnight-edge appointments
// to a different day in the receptionist's view of "today".
export function formatDateIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayIso(now: Date = new Date()): string {
  return formatDateIso(now);
}

export function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  });
}

// Adds delta months and returns the resulting (year, month) pair.
// Rolls over years correctly (e.g. Dec → Jan moves the year forward).
export function shiftMonth(
  year: number,
  month: number,
  delta: number
): { year: number; month: number } {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

// Adds n calendar days to an ISO date string, returning a new ISO string.
// Negative deltas walk backwards. Always works in local time so it doesn't
// drift across DST boundaries.
export function addDaysIso(dateIso: string, delta: number): string {
  const d = new Date(`${dateIso}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return formatDateIso(d);
}

// Monday-anchored start of the week containing the given date.
// e.g. for "2026-04-28" (Tuesday) → "2026-04-27" (Monday).
export function getWeekStartIso(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00`);
  const offset = (d.getDay() + 6) % 7; // 0=Sun..6=Sat → 0=Mon..6=Sun
  d.setDate(d.getDate() - offset);
  return formatDateIso(d);
}

// Seven consecutive ISO dates starting from the Monday of the given date's week.
export function getWeekDays(dateIso: string): string[] {
  const start = getWeekStartIso(dateIso);
  return [0, 1, 2, 3, 4, 5, 6].map((i) => addDaysIso(start, i));
}

// First and last ISO dates of the 42-cell Mon-anchored calendar grid for
// the given month. Mirrors the layout the DatePicker renders (its
// `buildMonthCells` produces the same 6-row grid starting on the Monday
// of the week containing day-1). Useful for pre-fetching availability
// before the picker mounts, so the first paint already has its dim/pill
// chrome correct rather than flashing from "all dim" to "pills appear".
export function getMonthGridWindow(year: number, month: number): {
  firstIso: string;
  lastIso: string;
} {
  const first = new Date(year, month, 1);
  const firstDow = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - firstDow);
  const end = new Date(start);
  end.setDate(start.getDate() + 41);
  return { firstIso: formatDateIso(start), lastIso: formatDateIso(end) };
}

// Convenience wrapper: 42-cell grid window for the month containing the
// supplied ISO date.
export function monthGridWindowForIso(dateIso: string): {
  firstIso: string;
  lastIso: string;
} {
  const d = new Date(`${dateIso}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    const now = new Date();
    return getMonthGridWindow(now.getFullYear(), now.getMonth());
  }
  return getMonthGridWindow(d.getFullYear(), d.getMonth());
}

