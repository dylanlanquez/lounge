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

export interface MonthGridCell {
  dateIso: string;
  dayOfMonth: number;
  isCurrentMonth: boolean;
}

// Six-row × seven-column grid for the given month, Monday-first.
// Always 42 cells so the calendar height never jumps between months.
// Padding days from the previous and next month carry their real dateIso
// so the cell can still be tapped and the month nav advances accordingly.
export function getMonthGridDays(year: number, month: number): MonthGridCell[] {
  const firstOfMonth = new Date(year, month, 1);
  // JS getDay is 0=Sun..6=Sat. Monday-first offset: 0=Mon..6=Sun.
  const offset = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - offset);
  const out: MonthGridCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + i
    );
    out.push({
      dateIso: formatDateIso(d),
      dayOfMonth: d.getDate(),
      isCurrentMonth: d.getMonth() === month,
    });
  }
  return out;
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

export function isSameMonth(year: number, month: number, dateIso: string): boolean {
  const [y, m] = dateIso.split('-');
  return Number(y) === year && Number(m) - 1 === month;
}

// Keyboard-navigation arithmetic for the 6×7 (=42) month grid.
// Returns the destination cell index for the pressed key, or null when the
// key isn't a navigation key or the move would leave the visible grid.
// Keeping this pure makes the focus-shifting logic in <MonthGrid> trivial
// to unit-test without rendering the DOM.
export const MONTH_GRID_SIZE = 42;
export const MONTH_GRID_COLS = 7;
export function nextGridIndex(
  current: number,
  key: string,
  size: number = MONTH_GRID_SIZE,
  cols: number = MONTH_GRID_COLS
): number | null {
  let next: number;
  switch (key) {
    case 'ArrowLeft':
      next = current - 1;
      break;
    case 'ArrowRight':
      next = current + 1;
      break;
    case 'ArrowUp':
      next = current - cols;
      break;
    case 'ArrowDown':
      next = current + cols;
      break;
    case 'Home':
      next = current - (current % cols);
      break;
    case 'End':
      next = current - (current % cols) + (cols - 1);
      break;
    default:
      return null;
  }
  if (next < 0 || next >= size) return null;
  return next;
}
