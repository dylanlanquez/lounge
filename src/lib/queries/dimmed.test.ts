import { describe, expect, it } from 'vitest';
import { isAppointmentDimmed } from './appointments.ts';
import type { AppointmentStatus } from '../../components/AppointmentCard/AppointmentCard.tsx';

const now = new Date('2026-04-28T11:00:00Z');
const past = '2026-04-28T10:00:00Z';
const future = '2026-04-28T12:00:00Z';

const row = (status: AppointmentStatus, end_at: string) => ({ status, end_at });

describe('isAppointmentDimmed', () => {
  it('always dims terminal statuses regardless of time', () => {
    expect(isAppointmentDimmed(row('complete', future), now)).toBe(true);
    expect(isAppointmentDimmed(row('cancelled', future), now)).toBe(true);
    expect(isAppointmentDimmed(row('rescheduled', future), now)).toBe(true);
  });

  it('keeps active statuses (arrived, in_progress) at full strength even past end_at', () => {
    expect(isAppointmentDimmed(row('arrived', past), now)).toBe(false);
    expect(isAppointmentDimmed(row('in_progress', past), now)).toBe(false);
  });

  it('dims booked rows whose slot has ended', () => {
    expect(isAppointmentDimmed(row('booked', past), now)).toBe(true);
  });

  it('does not dim booked rows whose slot is still running or in the future', () => {
    expect(isAppointmentDimmed(row('booked', future), now)).toBe(false);
  });

  it('dims no_show rows whose slot has ended', () => {
    expect(isAppointmentDimmed(row('no_show', past), now)).toBe(true);
  });

  it('does not dim no_show rows whose slot is still in the future window', () => {
    // Marked no-show 30 min into a 60 min slot; end_at is still ahead of now.
    expect(isAppointmentDimmed(row('no_show', future), now)).toBe(false);
  });

  it('dims at the exact end_at moment', () => {
    expect(isAppointmentDimmed(row('booked', '2026-04-28T11:00:00Z'), now)).toBe(true);
  });

  it('accepts a number (epoch ms) as well as Date for now', () => {
    expect(isAppointmentDimmed(row('booked', past), now.getTime())).toBe(true);
    expect(isAppointmentDimmed(row('booked', future), now.getTime())).toBe(false);
  });
});
