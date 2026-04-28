import { describe, expect, it } from 'vitest';
import {
  formatDateIso,
  getMonthGridDays,
  isSameMonth,
  monthLabel,
  nextGridIndex,
  shiftMonth,
} from './calendarMonth.ts';

describe('formatDateIso', () => {
  it('returns YYYY-MM-DD with zero-padded month and day', () => {
    expect(formatDateIso(new Date(2026, 3, 5))).toBe('2026-04-05');
  });

  it('preserves single-digit days as 0-padded', () => {
    expect(formatDateIso(new Date(2026, 0, 1))).toBe('2026-01-01');
  });

  it('handles end-of-year', () => {
    expect(formatDateIso(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('getMonthGridDays', () => {
  it('returns 42 cells regardless of month length', () => {
    expect(getMonthGridDays(2026, 1)).toHaveLength(42); // Feb 2026 (28 days)
    expect(getMonthGridDays(2026, 0)).toHaveLength(42); // Jan 2026 (31 days)
  });

  it('starts on Monday for April 2026 (1st is a Wednesday)', () => {
    const grid = getMonthGridDays(2026, 3);
    // Apr 1 2026 = Wednesday → Mon=Mar 30, Tue=Mar 31, Wed=Apr 1
    expect(grid[0]).toEqual({ dateIso: '2026-03-30', dayOfMonth: 30, isCurrentMonth: false });
    expect(grid[1]).toEqual({ dateIso: '2026-03-31', dayOfMonth: 31, isCurrentMonth: false });
    expect(grid[2]).toEqual({ dateIso: '2026-04-01', dayOfMonth: 1, isCurrentMonth: true });
  });

  it('flags isCurrentMonth correctly for padding days', () => {
    const grid = getMonthGridDays(2026, 3);
    const inMonth = grid.filter((c) => c.isCurrentMonth);
    expect(inMonth).toHaveLength(30); // April has 30 days
    expect(inMonth[0]?.dayOfMonth).toBe(1);
    expect(inMonth[inMonth.length - 1]?.dayOfMonth).toBe(30);
  });

  it('handles a month that starts on Monday with no leading padding', () => {
    // June 2026 starts on Monday
    const grid = getMonthGridDays(2026, 5);
    expect(grid[0]).toEqual({ dateIso: '2026-06-01', dayOfMonth: 1, isCurrentMonth: true });
  });

  it('handles a month that starts on Sunday with full leading padding', () => {
    // March 2026 starts on a Sunday → 6 days of leading padding (Mon-Sat)
    const grid = getMonthGridDays(2026, 2);
    expect(grid[0]).toEqual({ dateIso: '2026-02-23', dayOfMonth: 23, isCurrentMonth: false });
    expect(grid[6]).toEqual({ dateIso: '2026-03-01', dayOfMonth: 1, isCurrentMonth: true });
  });

  it('handles February in a leap year', () => {
    // Feb 2024 (leap, 29 days). Starts Thursday.
    const grid = getMonthGridDays(2024, 1);
    const inMonth = grid.filter((c) => c.isCurrentMonth);
    expect(inMonth).toHaveLength(29);
    expect(inMonth[inMonth.length - 1]?.dateIso).toBe('2024-02-29');
  });

  it('produces consecutive ISO dates with no gaps', () => {
    const grid = getMonthGridDays(2026, 0);
    for (let i = 1; i < grid.length; i++) {
      const prev = new Date(grid[i - 1]!.dateIso + 'T00:00:00');
      const curr = new Date(grid[i]!.dateIso + 'T00:00:00');
      expect(curr.getTime() - prev.getTime()).toBe(24 * 60 * 60 * 1000);
    }
  });
});

describe('shiftMonth', () => {
  it('moves forward within a year', () => {
    expect(shiftMonth(2026, 3, 1)).toEqual({ year: 2026, month: 4 });
  });

  it('rolls forward into the next year', () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
  });

  it('rolls back into the previous year', () => {
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });

  it('handles multi-month deltas', () => {
    expect(shiftMonth(2026, 3, 15)).toEqual({ year: 2027, month: 6 });
    expect(shiftMonth(2026, 3, -15)).toEqual({ year: 2025, month: 0 });
  });
});

describe('monthLabel', () => {
  it('returns "Month YYYY" in en-GB', () => {
    expect(monthLabel(2026, 3)).toBe('April 2026');
    expect(monthLabel(2026, 0)).toBe('January 2026');
    expect(monthLabel(2026, 11)).toBe('December 2026');
  });
});

describe('isSameMonth', () => {
  it('matches when year and month line up', () => {
    expect(isSameMonth(2026, 3, '2026-04-15')).toBe(true);
  });

  it('rejects different month', () => {
    expect(isSameMonth(2026, 3, '2026-05-01')).toBe(false);
  });

  it('rejects different year', () => {
    expect(isSameMonth(2026, 3, '2025-04-15')).toBe(false);
  });
});

describe('nextGridIndex', () => {
  it('arrow keys move by ±1 / ±7 within bounds', () => {
    expect(nextGridIndex(15, 'ArrowLeft')).toBe(14);
    expect(nextGridIndex(15, 'ArrowRight')).toBe(16);
    expect(nextGridIndex(15, 'ArrowUp')).toBe(8);
    expect(nextGridIndex(15, 'ArrowDown')).toBe(22);
  });

  it('returns null when ArrowLeft would leave the grid', () => {
    expect(nextGridIndex(0, 'ArrowLeft')).toBeNull();
  });

  it('returns null when ArrowRight would leave the grid', () => {
    expect(nextGridIndex(41, 'ArrowRight')).toBeNull();
  });

  it('returns null when ArrowUp from the first row', () => {
    expect(nextGridIndex(3, 'ArrowUp')).toBeNull();
  });

  it('returns null when ArrowDown from the last row', () => {
    expect(nextGridIndex(38, 'ArrowDown')).toBeNull();
  });

  it('Home/End jump to row boundaries', () => {
    // Index 10 is in row 1 (0-6 = row 0, 7-13 = row 1)
    expect(nextGridIndex(10, 'Home')).toBe(7);
    expect(nextGridIndex(10, 'End')).toBe(13);
  });

  it('Home is a no-op on a row-start', () => {
    expect(nextGridIndex(7, 'Home')).toBe(7);
  });

  it('End is a no-op on a row-end', () => {
    expect(nextGridIndex(6, 'End')).toBe(6);
  });

  it('returns null for keys it does not handle', () => {
    expect(nextGridIndex(15, 'a')).toBeNull();
    expect(nextGridIndex(15, 'PageUp')).toBeNull();
  });

  it('respects custom grid sizes', () => {
    // 3-row × 7-col grid (21 cells)
    expect(nextGridIndex(20, 'ArrowDown', 21)).toBeNull();
    expect(nextGridIndex(13, 'ArrowDown', 21)).toBe(20);
  });
});
