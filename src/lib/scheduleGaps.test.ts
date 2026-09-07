import { describe, expect, it } from 'vitest';
import { computeDayFreeTime, computeResourceUsage, formatMinutes, londonWallClockToDate } from './scheduleGaps.ts';

const HOURS = { open: '09:00', close: '17:00', break: { start: '12:00', end: '13:00' } };
const DAY = '2026-09-07'; // BST, UTC+1
const at = (hhmm: string) => londonWallClockToDate(DAY, hhmm)!.toISOString();
const row = (s: string, e: string, status = 'booked') => ({ start_at: at(s), end_at: at(e), status });
// A denture repair as it is really booked: patient in for Book-in and
// Try In, out during the Repair.
const repair = (s: string, status = 'booked') => {
  const t = (offset: number) => new Date(ms(at(s)) + offset * 60_000).toISOString();
  return {
    start_at: at(s), end_at: t(40), status,
    phases: [
      { patient_required: true, start_at: t(0), end_at: t(5), pool_ids: ['reception'] },
      { patient_required: false, start_at: t(5), end_at: t(35), pool_ids: [] },
      { patient_required: true, start_at: t(35), end_at: t(40), pool_ids: ['reception'] },
    ],
  };
};
const ms = (iso: string) => new Date(iso).getTime();

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

  it('drops gaps shorter than 15 minutes', () => {
    const out = computeDayFreeTime({
      rows: [row('14:10', '17:00')],
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

  it('closed days have nothing', () => {
    expect(computeDayFreeTime({ rows: [], dateIso: DAY, hours: null, now: new Date(), isToday: false, isPast: false }).open).toBe(false);
  });

  it('today splits into down time behind now and free time ahead', () => {
    const out = computeDayFreeTime({
      rows: [row('09:45', '10:00', 'complete'), row('11:00', '11:45', 'complete'), row('15:00', '15:30')],
      dateIso: DAY, hours: HOURS, now: new Date(at('14:18')), isToday: true, isPast: false,
    });
    expect(out.downWindows.map((w) => [w.start, w.end, w.minutes])).toEqual([
      [at('09:00'), at('09:45'), 45],
      [at('10:00'), at('11:00'), 60],
      [at('11:45'), at('12:00'), 15],
      [at('13:00'), at('14:18'), 78],
    ]);
    expect(out.downMinutes).toBe(198);
    expect(out.windows.map((w) => w.minutes)).toEqual([42, 90]);
  });

  it('a past day is all down time, nothing to fill', () => {
    const out = computeDayFreeTime({
      rows: [row('10:00', '16:00', 'complete')],
      dateIso: DAY, hours: HOURS, now: new Date('2026-09-20T10:00:00Z'), isToday: false, isPast: true,
    });
    expect(out.open).toBe(true);
    expect(out.windows).toEqual([]);
    expect(out.downWindows.map((w) => [w.start, w.end])).toEqual([
      [at('09:00'), at('10:00')],
      [at('16:00'), at('17:00')],
    ]);
  });

  it('a future day has no down time yet', () => {
    const out = computeDayFreeTime({ rows: [], dateIso: DAY, hours: HOURS, now: new Date('2026-09-01T10:00:00Z'), isToday: false, isPast: false });
    expect(out.downWindows).toEqual([]);
    expect(out.freeMinutes).toBe(420);
  });

  it('overlapping bookings are merged', () => {
    const out = computeDayFreeTime({
      rows: [row('09:00', '11:00'), row('10:00', '12:00')],
      dateIso: DAY, hours: HOURS, now: new Date(), isToday: false, isPast: false,
    });
    expect(out.windows.map((w) => [w.start, w.end])).toEqual([[at('13:00'), at('17:00')]]);
  });
});

describe('reception busy time from phases', () => {
  it('only the patient-present phases tie the desk up; lab time is free to book', () => {
    const out = computeDayFreeTime({
      rows: [repair('14:30')],
      dateIso: DAY, hours: HOURS, now: new Date(at('14:00')), isToday: true, isPast: false,
    });
    // 14:00 to 14:30 free, 14:30 to 14:35 book-in, 14:35 to 15:05 repair (free), 15:05 to 15:10 try-in, 15:10 to 17:00 free
    expect(out.windows.map((w) => [w.start, w.end, w.minutes])).toEqual([
      [at('14:00'), at('14:30'), 30],
      [at('14:35'), at('15:05'), 30],
      [at('15:10'), at('17:00'), 110],
    ]);
    expect(out.usage!.labMinutes).toBe(30);
    // Only the two 5-minute patient phases; 09:00 to 14:00 is down time, not booked.
    expect(out.usage!.bookedMinutes).toBe(10);
    expect(out.usage!.downMinutes).toBe(240);
  });

  it('a booking without phases counts its whole span', () => {
    const out = computeDayFreeTime({
      rows: [row('14:30', '15:10')],
      dateIso: DAY, hours: HOURS, now: new Date(at('14:00')), isToday: true, isPast: false,
    });
    expect(out.windows.map((w) => [w.start, w.end])).toEqual([[at('14:00'), at('14:30')], [at('15:10'), at('17:00')]]);
    expect(out.usage!.labMinutes).toBe(0);
  });
});

describe('day usage', () => {
  it('segments run from opening to closing and add up', () => {
    const out = computeDayFreeTime({
      rows: [repair('10:00'), row('15:00', '15:30')],
      dateIso: DAY, hours: HOURS, now: new Date(at('14:18')), isToday: true, isPast: false,
    });
    const u = out.usage!;
    expect(u.openMinutes).toBe(480);
    expect(u.bookedMinutes + u.lunchMinutes + u.downMinutes + u.freeMinutes).toBe(480);
    expect(u.segments[0]!.start).toBe(at('09:00'));
    expect(u.segments[u.segments.length - 1]!.end).toBe(at('17:00'));
    expect(u.segments.map((x) => x.kind)).toEqual(['down', 'booked', 'down', 'booked', 'down', 'lunch', 'down', 'free', 'booked', 'free']);
    expect(u.lunchMinutes).toBe(60);
    expect(u.labMinutes).toBe(30);
    expect(u.nowFraction).toBeCloseTo((5 * 60 + 18) / 480, 5);
  });
});

describe('computeResourceUsage', () => {
  const pools = [
    { id: 'reception', name: 'Reception', kind: 'staff_role' as const, staffNames: ['Karly Innes'], units: 2 },
    { id: 'impression-clinician', name: 'Impression Clinician', kind: 'staff_role' as const, staffNames: ['Lisa Mccomb'], units: 1 },
  ];
  it('each pool is busy only during the phases that name it', () => {
    const impression = {
      start_at: at('10:00'), end_at: at('10:30'), status: 'booked',
      phases: [
        { patient_required: true, start_at: at('10:00'), end_at: at('10:05'), pool_ids: ['reception'] },
        { patient_required: true, start_at: at('10:05'), end_at: at('10:30'), pool_ids: ['consult-room', 'impression-clinician'] },
      ],
    };
    const out = computeResourceUsage({
      rows: [repair('14:30'), impression], dateIso: DAY, hours: HOURS, now: new Date(at('16:00')), isToday: false, isPast: true, pools,
    });
    const rec = out.find((r) => r.id === 'reception')!;
    const imp = out.find((r) => r.id === 'impression-clinician')!;
    expect(rec.usage.bookedMinutes).toBe(5 + 5 + 5);
    expect(imp.usage.bookedMinutes).toBe(25);
    expect(rec.unused).toBe(false);
    expect(imp.usage.downMinutes).toBe(480 - 60 - 25);
  });

  it('flags a pool no booking needs', () => {
    const out = computeResourceUsage({ rows: [repair('14:30')], dateIso: DAY, hours: HOURS, now: new Date(), isToday: false, isPast: false, pools });
    expect(out.find((r) => r.id === 'impression-clinician')!.unused).toBe(true);
  });
});

describe('video calls are measured from the call itself', () => {
  const call = (s: string, status: string, sessions: Array<[string, string]>) => ({
    start_at: at(s), end_at: new Date(ms(at(s)) + 30 * 60_000).toISOString(), status, join_url: 'https://meet.google.com/x',
    phases: [{ patient_required: true, start_at: at(s), end_at: new Date(ms(at(s)) + 30 * 60_000).toISOString(), pool_ids: ['virtual-impression-clinician'] }],
    call_sessions: sessions.map(([a, b]) => ({ start_at: at(a), end_at: at(b) })),
  });
  const pools = [{ id: 'virtual-impression-clinician', name: 'Virtual Impression Clinician', kind: 'staff_role' as const, staffNames: [], units: 2 }];

  it('uses the host sessions, not the booked slot, once the call happened', () => {
    const out = computeResourceUsage({
      rows: [call('10:00', 'complete', [['09:56', '10:01'], ['10:01', '10:17']])],
      dateIso: DAY, hours: HOURS, now: new Date(at('16:00')), isToday: true, isPast: false, pools,
    });
    expect(out[0]!.usage.bookedMinutes).toBe(21);
  });

  it('a no-show still cost the clinician the time they waited on the call', () => {
    const out = computeResourceUsage({
      rows: [call('10:00', 'no_show', [['09:51', '10:15']])],
      dateIso: DAY, hours: HOURS, now: new Date(at('16:00')), isToday: true, isPast: false, pools,
    });
    expect(out[0]!.usage.bookedMinutes).toBe(24);
  });

  it('a past call nobody joined cost nothing; a future call is planned from its slot', () => {
    const out = computeResourceUsage({
      rows: [call('10:00', 'no_show', []), call('15:00', 'booked', [])],
      dateIso: DAY, hours: HOURS, now: new Date(at('14:00')), isToday: true, isPast: false, pools,
    });
    expect(out[0]!.usage.bookedMinutes).toBe(30);
    expect(out[0]!.usage.downMinutes).toBe(240);
  });
});

describe('formatMinutes', () => {
  it('reads naturally', () => {
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(120)).toBe('2h');
    expect(formatMinutes(162)).toBe('2h 42m');
  });
});
