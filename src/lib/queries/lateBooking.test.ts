import { describe, expect, it } from 'vitest';
import {
  NO_SHOW_LATE_THRESHOLD_MIN,
  formatLateDuration,
  isBookingLate,
  minutesPastStart,
} from './appointments.ts';

const start = '2026-04-28T09:00:00Z';
const at = (iso: string) => new Date(iso);

describe('minutesPastStart', () => {
  it('returns 0 at the exact start moment', () => {
    expect(minutesPastStart(start, at('2026-04-28T09:00:00Z'))).toBe(0);
  });

  it('returns negative when the appointment is still in the future', () => {
    expect(minutesPastStart(start, at('2026-04-28T08:55:00Z'))).toBe(-5);
  });

  it('returns whole minutes elapsed past start', () => {
    expect(minutesPastStart(start, at('2026-04-28T09:14:00Z'))).toBe(14);
    expect(minutesPastStart(start, at('2026-04-28T09:15:00Z'))).toBe(15);
    expect(minutesPastStart(start, at('2026-04-28T09:30:00Z'))).toBe(30);
  });

  it('floors so 14:59 elapsed reads as 14, not 15', () => {
    expect(minutesPastStart(start, at('2026-04-28T09:14:59Z'))).toBe(14);
  });

  it('accepts a number (epoch ms) as well as Date', () => {
    expect(minutesPastStart(start, at('2026-04-28T09:20:00Z').getTime())).toBe(20);
  });
});

describe('isBookingLate', () => {
  it('is false before the threshold', () => {
    expect(isBookingLate(start, at('2026-04-28T09:14:00Z'))).toBe(false);
  });

  it('flips at exactly 15 min past start (matches the threshold)', () => {
    expect(NO_SHOW_LATE_THRESHOLD_MIN).toBe(15);
    expect(isBookingLate(start, at('2026-04-28T09:15:00Z'))).toBe(true);
  });

  it('is true comfortably past the threshold', () => {
    expect(isBookingLate(start, at('2026-04-28T09:45:00Z'))).toBe(true);
  });

  it('is false when the appointment has not started yet', () => {
    expect(isBookingLate(start, at('2026-04-28T08:50:00Z'))).toBe(false);
  });
});

describe('formatLateDuration', () => {
  it('formats single-digit minutes', () => {
    expect(formatLateDuration(1)).toBe('1 min');
    expect(formatLateDuration(5)).toBe('5 mins');
    expect(formatLateDuration(15)).toBe('15 mins');
    expect(formatLateDuration(59)).toBe('59 mins');
  });

  it('formats whole hours', () => {
    expect(formatLateDuration(60)).toBe('1 hr');
    expect(formatLateDuration(120)).toBe('2 hr');
    expect(formatLateDuration(23 * 60)).toBe('23 hr');
  });

  it('formats hours plus minutes', () => {
    expect(formatLateDuration(61)).toBe('1 hr 1 min');
    expect(formatLateDuration(63)).toBe('1 hr 3 mins');
    expect(formatLateDuration(90)).toBe('1 hr 30 mins');
    expect(formatLateDuration(23 * 60 + 59)).toBe('23 hr 59 mins');
  });

  it('formats days plus hours plus minutes', () => {
    expect(formatLateDuration(1440)).toBe('1 day');
    expect(formatLateDuration(1440 + 60)).toBe('1 day 1 hr');
    expect(formatLateDuration(1440 + 90)).toBe('1 day 1 hr 30 mins');
    expect(formatLateDuration(2 * 1440 + 5 * 60 + 30)).toBe('2 days 5 hr 30 mins');
  });

  it('clamps negative or zero inputs', () => {
    expect(formatLateDuration(0)).toBe('0 mins');
    expect(formatLateDuration(-10)).toBe('0 mins');
  });

  it('floors fractional minutes', () => {
    expect(formatLateDuration(15.9)).toBe('15 mins');
  });
});
