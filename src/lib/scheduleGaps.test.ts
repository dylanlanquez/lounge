import { describe, expect, it } from 'vitest';
import { computeDayFreeTime, formatMinutes, londonWallClockToDate } from './scheduleGaps.ts';

const HOURS = { open: '09:00', close: '17:00', break: { start: '12:00', end: '13:00' } };
const DAY = '2026-09-07'; // BST, UTC+1
const at = (hhmm: string) => londonWallClockToDate(DAY, hhmm)!.toISOString();
const row = (s: string, e: string, status = 'booked') => ({ start_at: at(s), end_at: at(e), status });

describe('londonWallClockToDate', () => {
  it('maps a BST wall clock to the right instant', () => {
    expect(at('09:00')).toBe('2026-09-07T08:00:00.000Z');
  });
  it('maps a GMT wall clock to the right instant', () => {
    expect(londonWallClockToDate('2026-01-12', '09:00')!.toISOString()).toBe('2026-01-12T09:00:00.000Z');
  });
});

describe('computeDayFreeTime', () => {
  it('shows the rest of today from now to closing, minus bookings and lunch', () => {
    const now = new Date(at('14:18'));
    const out = computeDayFreeTime({
      rows: [row('09:45', '10:00', 'complete'), row('15:00', '15:30')],
      dateIso: DAY, hours: HOURS, now, isToday: true, isPast: false,
    });
    expect(out.open).toBe(true);
    expect(out.closesAt).toBe(at('17:00'));
    expect(out.windows.map((w) => [w.start, w.end, w.minutes])).toEqual([
      [at('14:18'), at('15:00'), 42],
      [at('15:30'), at('17:00'), 90],
    ]);
    expect(out.freeMinutes).toBe(132);
  });

  it('a future day is free from opening, around lunch', () => {
    const out = computeDayFreeTime({
      rows: [row('10:00', '11:00')],
      dateIso: DAY, hours: HOURS, now: new Date('2026-09-01T10:00:00Z'), isToday: false, isPast: false,
    });
    expect(out.windows.map((w) => [w.start, w.end])).toEqual([
      [at('09:00'), at('10:00')],
      [at('11:00'), at('12:00')],
      [at('13:00'), at('17:00')],
    ]);
  });

  it('cancelled, rescheduled and no-show rows do not hold their slot', () => {
    const out = computeDayFreeTime({
      rows: [row('14:30', '16:00', 'cancelled'), row('16:00', '16:30', 'no_show'), row('16:30', '17:00', 'rescheduled')],
      dateIso: DAY, hours: HOURS, now: new Date(at('14:00')), isToday: true, isPast: false,
    });
    expect(out.windows).toHaveLength(1);
    expect(out.windows[0]!.minutes).toBe(180);
  });

  it('drops gaps shorter than 30 minutes', () => {
    const out = computeDayFreeTime({
      rows: [row('14:20', '17:00')],
      dateIso: DAY, hours: HOURS, now: new Date(at('14:00')), isToday: true, isPast: false,
    });
    expect(out.windows).toEqual([]);
  });

  it('after closing today there is nothing to fill', () => {
    const out = computeDayFreeTime({ rows: [], dateIso: DAY, hours: HOURS, now: new Date(at('17:30')), isToday: true, isPast: false });
    expect(out.open).toBe(true);
    expect(out.closedForToday).toBe(true);
    expect(out.windows).toEqual([]);
  });

  it('closed days and past days have no free time', () => {
    expect(computeDayFreeTime({ rows: [], dateIso: DAY, hours: null, now: new Date(), isToday: false, isPast: false }).open).toBe(false);
    expect(computeDayFreeTime({ rows: [], dateIso: DAY, hours: HOURS, now: new Date(), isToday: false, isPast: true }).open).toBe(false);
  });

  it('overlapping bookings are merged', () => {
    const out = computeDayFreeTime({
      rows: [row('09:00', '11:00'), row('10:00', '12:00')],
      dateIso: DAY, hours: HOURS, now: new Date(), isToday: false, isPast: false,
    });
    expect(out.windows.map((w) => [w.start, w.end])).toEqual([[at('13:00'), at('17:00')]]);
  });
});

describe('formatMinutes', () => {
  it('reads naturally', () => {
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(120)).toBe('2h');
    expect(formatMinutes(162)).toBe('2h 42m');
  });
});
