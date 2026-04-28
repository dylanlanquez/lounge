import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  formatDateIso,
  getWeekDays,
  getWeekStartIso,
  monthLabel,
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
});

describe('monthLabel', () => {
  it('returns "Month YYYY" in en-GB', () => {
    expect(monthLabel(2026, 3)).toBe('April 2026');
    expect(monthLabel(2026, 0)).toBe('January 2026');
    expect(monthLabel(2026, 11)).toBe('December 2026');
  });
});

describe('addDaysIso', () => {
  it('adds days within a month', () => {
    expect(addDaysIso('2026-04-28', 1)).toBe('2026-04-29');
    expect(addDaysIso('2026-04-28', 7)).toBe('2026-05-05');
  });

  it('subtracts days', () => {
    expect(addDaysIso('2026-04-28', -7)).toBe('2026-04-21');
    expect(addDaysIso('2026-04-01', -1)).toBe('2026-03-31');
  });

  it('rolls across year boundaries', () => {
    expect(addDaysIso('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDaysIso('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('respects leap years', () => {
    expect(addDaysIso('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDaysIso('2024-02-29', 1)).toBe('2024-03-01');
  });

  it('is a no-op when delta is zero', () => {
    expect(addDaysIso('2026-04-28', 0)).toBe('2026-04-28');
  });
});

describe('getWeekStartIso', () => {
  it('returns Monday for any day in the week (Tue 28 Apr 2026)', () => {
    expect(getWeekStartIso('2026-04-28')).toBe('2026-04-27');
  });

  it('returns Monday when given Sunday (last day of the week)', () => {
    // Sun 3 May 2026
    expect(getWeekStartIso('2026-05-03')).toBe('2026-04-27');
  });

  it('is a no-op when given a Monday', () => {
    expect(getWeekStartIso('2026-04-27')).toBe('2026-04-27');
  });

  it('crosses month boundaries', () => {
    // Wed 1 Apr 2026 → Mon 30 Mar 2026
    expect(getWeekStartIso('2026-04-01')).toBe('2026-03-30');
  });

  it('crosses year boundaries', () => {
    // Thu 1 Jan 2026 → Mon 29 Dec 2025
    expect(getWeekStartIso('2026-01-01')).toBe('2025-12-29');
  });
});

describe('getWeekDays', () => {
  it('returns 7 consecutive ISO dates starting on Monday', () => {
    const days = getWeekDays('2026-04-28');
    expect(days).toEqual([
      '2026-04-27', // Mon
      '2026-04-28', // Tue
      '2026-04-29', // Wed
      '2026-04-30', // Thu
      '2026-05-01', // Fri
      '2026-05-02', // Sat
      '2026-05-03', // Sun
    ]);
  });

  it('returns the same week regardless of which day-in-week is passed', () => {
    const fromMon = getWeekDays('2026-04-27');
    const fromSun = getWeekDays('2026-05-03');
    expect(fromMon).toEqual(fromSun);
  });

  it('handles leap-year week spans (Feb 26-Mar 3 2024)', () => {
    const days = getWeekDays('2024-02-29');
    expect(days).toEqual([
      '2024-02-26',
      '2024-02-27',
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
      '2024-03-02',
      '2024-03-03',
    ]);
  });
});

