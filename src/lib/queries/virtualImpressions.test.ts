import { describe, expect, it } from 'vitest';
import {
  aggregateVirtualImpressions,
  buildDailyDurationSeries,
  computeDurationTrend,
  formatCallMinutes,
  formatVsSlot,
  summarizeCalls,
  type ViAppointmentRow,
  type ViAttendanceRow,
  type ViPatientRow,
  type VirtualImpressionCall,
} from './virtualImpressions.ts';

function mkCall(
  startAt: string,
  patientMinutes: number | null,
  opts: Partial<VirtualImpressionCall> = {},
): VirtualImpressionCall {
  return {
    id: startAt,
    ref: 'LAP',
    patientName: 'X',
    startAt,
    status: 'complete',
    arch: null,
    hostName: null,
    slotMinutes: 30,
    patientMinutes,
    hostMinutes: null,
    vsSlotMinutes: patientMinutes === null ? null : patientMinutes - 30,
    sessions: [],
    ...opts,
  };
}

// A 30 minute slot starting at the given hour, in UTC.
function appt(
  id: string,
  startHour: number,
  status: string,
  opts: Partial<ViAppointmentRow> = {},
): ViAppointmentRow {
  const start = `2026-06-10T${String(startHour).padStart(2, '0')}:00:00Z`;
  const end = `2026-06-10T${String(startHour).padStart(2, '0')}:30:00Z`;
  return {
    id,
    appointment_ref: `LAP-${id}`,
    patient_id: `p-${id}`,
    start_at: start,
    end_at: end,
    status,
    arch: null,
    conference_started_at: null,
    conference_ended_at: null,
    ...opts,
  };
}

function session(
  appointment_id: string,
  is_host: boolean,
  joinedMin: number,
  leftMin: number,
  startHour = 9,
  participant_name: string | null = null,
): ViAttendanceRow {
  const base = new Date(`2026-06-10T${String(startHour).padStart(2, '0')}:00:00Z`).getTime();
  return {
    appointment_id,
    is_host,
    participant_name,
    joined_at: new Date(base + joinedMin * 60000).toISOString(),
    left_at: new Date(base + leftMin * 60000).toISOString(),
  };
}

const patients: ViPatientRow[] = [
  { id: 'p-1', first_name: 'flora', last_name: 'sawers' },
  { id: 'p-2', first_name: 'lewis', last_name: 'ward' },
  { id: 'p-3', first_name: 'carmen', last_name: 'innes' },
];

describe('aggregateVirtualImpressions', () => {
  it('measures patient presence span, not the polluted room window', () => {
    // Host opens the room early and leaves it open for hours; patient is
    // only on for 22 minutes. We must report 22, not the room span.
    const appts = [
      appt('1', 9, 'complete', {
        conference_started_at: '2026-06-10T08:50:00Z',
        conference_ended_at: '2026-06-10T18:00:00Z',
      }),
    ];
    const attendance = [
      session('1', true, -10, 480), // host: 08:50 → 17:00
      session('1', false, 2, 24), // patient: 09:02 → 09:24 = 22 min
    ];
    const data = aggregateVirtualImpressions(appts, attendance, patients);
    expect(data.callsHeld).toBe(1);
    expect(data.patientJoined).toBe(1);
    expect(data.avgPatientMinutes).toBeCloseTo(22, 5);
    expect(data.calls[0]!.patientMinutes).toBeCloseTo(22, 5);
    expect(data.calls[0]!.vsSlotMinutes).toBeCloseTo(-8, 5);
  });

  it('counts a no-join call as held but not measured', () => {
    const appts = [
      appt('2', 10, 'no_show', { conference_started_at: '2026-06-10T10:00:00Z', conference_ended_at: '2026-06-10T10:40:00Z' }),
    ];
    const attendance = [session('2', true, 0, 40, 10)]; // host only
    const data = aggregateVirtualImpressions(appts, attendance, patients);
    expect(data.callsHeld).toBe(1);
    expect(data.patientJoined).toBe(0);
    expect(data.noAnswer).toBe(1);
    expect(data.avgPatientMinutes).toBeNull();
    expect(data.calls[0]!.patientMinutes).toBeNull();
    expect(data.attendanceRate).toBe(0);
  });

  it('excludes future bookings that have not happened', () => {
    const appts = [appt('3', 11, 'booked')]; // no conference, not closed
    const data = aggregateVirtualImpressions(appts, [], patients);
    expect(data.callsHeld).toBe(0);
    expect(data.calls).toHaveLength(0);
  });

  it('computes median, range and over-slot counts across calls', () => {
    const appts = [
      appt('1', 9, 'complete', { conference_started_at: '2026-06-10T09:00:00Z', conference_ended_at: '2026-06-10T09:40:00Z' }),
      appt('2', 10, 'complete', { conference_started_at: '2026-06-10T10:00:00Z', conference_ended_at: '2026-06-10T10:40:00Z' }),
      appt('3', 11, 'complete', { conference_started_at: '2026-06-10T11:00:00Z', conference_ended_at: '2026-06-10T11:40:00Z' }),
    ];
    const attendance = [
      session('1', false, 0, 20, 9), // 20 min (under)
      session('2', false, 0, 30, 10), // 30 min (on slot)
      session('3', false, 0, 40, 11), // 40 min (over)
    ];
    const data = aggregateVirtualImpressions(appts, attendance, patients);
    expect(data.patientJoined).toBe(3);
    expect(data.minPatientMinutes).toBeCloseTo(20, 5);
    expect(data.maxPatientMinutes).toBeCloseTo(40, 5);
    expect(data.medianPatientMinutes).toBeCloseTo(30, 5);
    expect(data.avgPatientMinutes).toBeCloseTo(30, 5);
    expect(data.ranOverSlot).toBe(1);
    expect(data.slotMinutes).toBe(30);
    // Sorted most-recent first.
    expect(data.calls[0]!.id).toBe('3');
  });

  it('falls back to the appointment ref when the patient name is missing', () => {
    const appts = [
      appt('9', 9, 'complete', { patient_id: null, conference_started_at: '2026-06-10T09:00:00Z', conference_ended_at: '2026-06-10T09:20:00Z' }),
    ];
    const attendance = [session('9', false, 0, 18, 9)];
    const data = aggregateVirtualImpressions(appts, attendance, []);
    expect(data.calls[0]!.patientName).toBe('LAP-9');
  });

  it('handles an empty range', () => {
    const data = aggregateVirtualImpressions([], [], []);
    expect(data.callsHeld).toBe(0);
    expect(data.avgPatientMinutes).toBeNull();
    expect(data.attendanceRate).toBeNull();
  });
});

describe('arch and host capture', () => {
  it('records the arch and the hosting clinician', () => {
    const appts = [
      appt('1', 9, 'complete', {
        arch: 'upper',
        conference_started_at: '2026-06-10T09:00:00Z',
        conference_ended_at: '2026-06-10T09:40:00Z',
      }),
    ];
    const attendance = [
      session('1', true, 0, 30, 9, 'Heidi Abdrabu'),
      session('1', false, 2, 25, 9),
    ];
    const data = aggregateVirtualImpressions(appts, attendance, patients);
    expect(data.calls[0]!.arch).toBe('upper');
    expect(data.calls[0]!.hostName).toBe('Heidi Abdrabu');
    expect(data.calls[0]!.hostMinutes).toBeCloseTo(30, 5);
  });
});

describe('per-call sessions', () => {
  it('attaches each stay, host first, with durations', () => {
    const appts = [
      appt('1', 9, 'complete', {
        conference_started_at: '2026-06-10T09:00:00Z',
        conference_ended_at: '2026-06-10T09:40:00Z',
      }),
    ];
    const attendance = [
      session('1', false, 5, 25, 9, 'A Patient'), // patient 20 min
      session('1', true, 0, 30, 9, 'Heidi Abdrabu'), // host 30 min
    ];
    const data = aggregateVirtualImpressions(appts, attendance, patients);
    const sessions = data.calls[0]!.sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.isHost).toBe(true); // host sorted first
    expect(sessions[0]!.durationMinutes).toBeCloseTo(30, 5);
    expect(sessions[1]!.durationMinutes).toBeCloseTo(20, 5);
  });
});

describe('summarizeCalls', () => {
  it('derives the headline figures from a call subset', () => {
    const calls = [
      mkCall('2026-06-10T09:00:00Z', 20),
      mkCall('2026-06-10T10:00:00Z', 30),
      mkCall('2026-06-10T11:00:00Z', 40),
      mkCall('2026-06-10T12:00:00Z', null), // no answer
    ];
    const s = summarizeCalls(calls);
    expect(s.callsHeld).toBe(4);
    expect(s.patientJoined).toBe(3);
    expect(s.noAnswer).toBe(1);
    expect(s.avgPatientMinutes).toBeCloseTo(30, 5);
    expect(s.medianPatientMinutes).toBeCloseTo(30, 5);
    expect(s.ranOverSlot).toBe(1);
    expect(s.attendanceRate).toBeCloseTo(0.75, 5);
  });
});

describe('buildDailyDurationSeries', () => {
  it('emits one point per day with NaN gaps', () => {
    const calls = [
      mkCall('2026-06-10T12:00:00Z', 20),
      mkCall('2026-06-10T13:00:00Z', 40), // same day -> avg 30
      mkCall('2026-06-12T12:00:00Z', 10),
    ];
    const series = buildDailyDurationSeries(calls, '2026-06-10', '2026-06-12');
    expect(series.map((p) => p.date)).toEqual([
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
    ]);
    expect(series[0]!.avgMinutes).toBeCloseTo(30, 5);
    expect(Number.isNaN(series[1]!.avgMinutes)).toBe(true);
    expect(series[2]!.avgMinutes).toBeCloseTo(10, 5);
  });
});

describe('computeDurationTrend', () => {
  it('reads a rising trend as up', () => {
    const calls = [0, 1, 2, 3, 4].map((d) =>
      mkCall(`2026-06-1${d}T12:00:00Z`, 10 + d * 5),
    );
    const trend = computeDurationTrend(calls);
    expect(trend.direction).toBe('up');
    expect(trend.perWeekMinutes).not.toBeNull();
    expect(trend.perWeekMinutes!).toBeGreaterThan(0);
  });

  it('returns flat with too few calls', () => {
    const trend = computeDurationTrend([mkCall('2026-06-10T12:00:00Z', 20)]);
    expect(trend.direction).toBe('flat');
    expect(trend.perWeekMinutes).toBeNull();
  });
});

describe('formatCallMinutes', () => {
  it('formats whole minutes, sub-minute and hours', () => {
    expect(formatCallMinutes(null)).toBe('—');
    expect(formatCallMinutes(0.5)).toBe('<1 min');
    expect(formatCallMinutes(28.4)).toBe('28 min');
    expect(formatCallMinutes(60)).toBe('1 hr');
    expect(formatCallMinutes(75)).toBe('1 hr 15 min');
  });
});

describe('formatVsSlot', () => {
  it('reads as under, over, on the slot, or no answer', () => {
    expect(formatVsSlot(null)).toBe('No answer');
    expect(formatVsSlot(-6)).toBe('6 min under');
    expect(formatVsSlot(4)).toBe('4 min over');
    expect(formatVsSlot(0)).toBe('On the slot');
  });
});
