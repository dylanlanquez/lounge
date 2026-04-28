import { describe, expect, it } from 'vitest';
import { NO_SHOW_LATE_THRESHOLD_MIN, isBookingLate, minutesPastStart } from './appointments.ts';

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
