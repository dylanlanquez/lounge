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

// Header label for a visible week range.
// - "April 2026" when both ends fall in the same month
// - "April-May 2026" when the week straddles a month boundary
// - "Dec 2025-Jan 2026" when it also crosses a year boundary
export function formatWeekLabel(startIso: string, endIso: string): string {
  const s = new Date(`${startIso}T00:00:00`);
  const e = new Date(`${endIso}T00:00:00`);
  const sameYear = s.getFullYear() === e.getFullYear();
  const sameMonth = sameYear && s.getMonth() === e.getMonth();
  if (sameMonth) {
    return s.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }
  if (sameYear) {
    const sMonth = s.toLocaleDateString('en-GB', { month: 'long' });
    const eMonth = e.toLocaleDateString('en-GB', { month: 'long' });
    return `${sMonth}-${eMonth} ${e.getFullYear()}`;
  }
  const sLabel = s.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  const eLabel = e.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  return `${sLabel}-${eLabel}`;
}
