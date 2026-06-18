import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { type DateRange, dateRangeToUtcBounds } from '../dateRange.ts';
import { logFailure } from '../failureLog.ts';
import { properCase } from './appointments.ts';

// Virtual impressions report — how long video impression appointments
// actually take.
//
// The honest measure is NOT the Google Meet room window
// (conference_started_at → conference_ended_at). That span is polluted:
// Google merges conference records and keeps counting while a host
// leaves the room open, so "completed" calls average ~112 minutes and
// no-shows show multi-hour rooms. Instead we measure the time the
// PATIENT was actually in the call — the span from their first join to
// their last leave in lng_meet_attendance. Validated against
// production: that lands at ~28 min for a 30 min slot, which is the
// real story this report tells.
//
// Failures are loud: anything unexpected throws into the hook's error
// state and lands a row in lng_system_failures via logFailure.

// ── Raw shapes (exported so aggregateVirtualImpressions can be unit
// tested without a live Supabase response) ──────────────────────────

export interface ViAppointmentRow {
  id: string;
  appointment_ref: string | null;
  patient_id: string | null;
  start_at: string;
  end_at: string;
  status: string;
  arch: string | null;
  conference_started_at: string | null;
  conference_ended_at: string | null;
}

// A single-arch impression (upper or lower) takes less time than both
// arches together, so the report only splits on that distinction.
export type ArchFilter = 'all' | 'both' | 'single';

// One participant's stay in the call — the rows the expandable row
// detail renders, mirroring the appointment page's attendance card.
export interface CallSession {
  participantName: string | null;
  isHost: boolean;
  joinedAt: string | null;
  leftAt: string | null;
  durationMinutes: number | null;
}

export interface ViAttendanceRow {
  appointment_id: string;
  is_host: boolean;
  participant_name: string | null;
  joined_at: string | null;
  left_at: string | null;
}

export interface ViPatientRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

// ── Output shapes ───────────────────────────────────────────────────

export interface VirtualImpressionCall {
  id: string;
  ref: string;
  patientName: string;
  startAt: string;
  status: string;
  arch: string | null;
  // Clinician who hosted the call (the host participant's name). null
  // when no host attendance was recorded.
  hostName: string | null;
  slotMinutes: number;
  // Minutes the patient was in the call. null when the patient never
  // joined (a no-answer / no-show) — those calls carry no duration.
  patientMinutes: number | null;
  hostMinutes: number | null;
  // patientMinutes - slotMinutes. Negative = finished inside the slot.
  vsSlotMinutes: number | null;
  // Every participant stay, for the expandable per-call detail.
  sessions: CallSession[];
}

// Headline figures over a set of calls. Pulled out of the data object
// so the page can recompute them on an arch-filtered subset without a
// re-fetch — same numbers, fewer calls.
export interface VirtualImpressionsSummary {
  callsHeld: number;
  patientJoined: number;
  noAnswer: number;
  avgPatientMinutes: number | null;
  medianPatientMinutes: number | null;
  minPatientMinutes: number | null;
  maxPatientMinutes: number | null;
  ranOverSlot: number;
  attendanceRate: number | null;
}

export interface VirtualImpressionsData extends VirtualImpressionsSummary {
  // The booked slot every call is measured against (the most common
  // scheduled length, e.g. 30). Drives the track scale on the page.
  slotMinutes: number;
  calls: VirtualImpressionCall[];
}

const DEFAULT_SLOT_MINUTES = 30;

// A call where the patient was on for this long or less is almost always
// a recycled / aborted Meet link, not a real impression. We drop those
// from the whole report so they don't pollute any figure. No-answer calls
// (the patient never joined) are a separate, real category and are kept.
const MIN_REAL_CALL_MINUTES = 4;

function minutesBetween(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms / 60000;
}

// Earliest join to latest leave for the given side of the call. Patient
// rejoins collapse into one span — we want time present, not session
// count.
function presenceSpan(rows: ViAttendanceRow[], host: boolean): number | null {
  const joins: number[] = [];
  const leaves: number[] = [];
  for (const r of rows) {
    if (r.is_host !== host) continue;
    if (r.joined_at) joins.push(new Date(r.joined_at).getTime());
    if (r.left_at) leaves.push(new Date(r.left_at).getTime());
  }
  if (joins.length === 0 || leaves.length === 0) return null;
  const span = Math.max(...leaves) - Math.min(...joins);
  if (!Number.isFinite(span) || span <= 0) return null;
  return span / 60000;
}

function hostNameFrom(rows: ViAttendanceRow[]): string | null {
  for (const r of rows) {
    if (r.is_host && r.participant_name && r.participant_name.trim()) {
      return r.participant_name.trim();
    }
  }
  return null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid]!;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + hi) / 2 : hi;
}

function mode(values: number[]): number | null {
  if (values.length === 0) return null;
  const counts = new Map<number, number>();
  let best = values[0]!;
  let bestCount = 0;
  for (const v of values) {
    const next = (counts.get(v) ?? 0) + 1;
    counts.set(v, next);
    if (next > bestCount) {
      best = v;
      bestCount = next;
    }
  }
  return best;
}

function patientLabel(patient: ViPatientRow | undefined, ref: string): string {
  if (!patient) return ref;
  const name = [patient.first_name, patient.last_name]
    .filter((p): p is string => !!p && p.trim().length > 0)
    .join(' ')
    .trim();
  return name ? properCase(name) : ref;
}

// A call "was held" once it reached a concluded clinical status:
// complete (it happened) or no_show (the patient never joined). We
// deliberately exclude in-progress ('joined') and abandoned
// ('rescheduled'/'cancelled') rows — their Meet rooms can sit open for
// hours, and counting those spans would inflate the average. Future
// 'booked' rows haven't happened yet.
function wasHeld(appt: ViAppointmentRow): boolean {
  return appt.status === 'complete' || appt.status === 'no_show';
}

export function summarizeCalls(
  calls: VirtualImpressionCall[],
): VirtualImpressionsSummary {
  const measured = calls
    .map((c) => c.patientMinutes)
    .filter((m): m is number => m !== null);
  const callsHeld = calls.length;
  const patientJoined = measured.length;
  const avg =
    measured.length > 0
      ? measured.reduce((sum, m) => sum + m, 0) / measured.length
      : null;
  const ranOverSlot = calls.filter(
    (c) => c.patientMinutes !== null && c.patientMinutes > c.slotMinutes,
  ).length;
  return {
    callsHeld,
    patientJoined,
    noAnswer: callsHeld - patientJoined,
    avgPatientMinutes: avg,
    medianPatientMinutes: median(measured),
    minPatientMinutes: measured.length ? Math.min(...measured) : null,
    maxPatientMinutes: measured.length ? Math.max(...measured) : null,
    ranOverSlot,
    attendanceRate: callsHeld > 0 ? patientJoined / callsHeld : null,
  };
}

export function aggregateVirtualImpressions(
  appointments: ViAppointmentRow[],
  attendance: ViAttendanceRow[],
  patients: ViPatientRow[],
): VirtualImpressionsData {
  const patientById = new Map(patients.map((p) => [p.id, p]));
  const attendanceByAppt = new Map<string, ViAttendanceRow[]>();
  for (const row of attendance) {
    const list = attendanceByAppt.get(row.appointment_id);
    if (list) list.push(row);
    else attendanceByAppt.set(row.appointment_id, [row]);
  }

  const slotMinutes =
    mode(
      appointments
        .map((a) => minutesBetween(a.start_at, a.end_at))
        .filter((m): m is number => m !== null)
        .map((m) => Math.round(m)),
    ) ?? DEFAULT_SLOT_MINUTES;

  const calls: VirtualImpressionCall[] = [];
  for (const appt of appointments) {
    if (!wasHeld(appt)) continue;
    const rows = attendanceByAppt.get(appt.id) ?? [];
    const patientMinutes = presenceSpan(rows, false);
    const hostMinutes = presenceSpan(rows, true);
    const sessions: CallSession[] = rows
      .map((r) => ({
        participantName: r.participant_name,
        isHost: r.is_host,
        joinedAt: r.joined_at,
        leftAt: r.left_at,
        durationMinutes: minutesBetween(r.joined_at, r.left_at),
      }))
      .sort(
        (a, b) =>
          Number(b.isHost) - Number(a.isHost) ||
          (a.joinedAt ? new Date(a.joinedAt).getTime() : 0) -
            (b.joinedAt ? new Date(b.joinedAt).getTime() : 0),
      );
    const slot = Math.round(minutesBetween(appt.start_at, appt.end_at) ?? slotMinutes);
    const ref = appt.appointment_ref ?? `LAP-${appt.id.slice(0, 6)}`;
    calls.push({
      id: appt.id,
      ref,
      patientName: patientLabel(
        appt.patient_id ? patientById.get(appt.patient_id) : undefined,
        ref,
      ),
      startAt: appt.start_at,
      status: appt.status,
      arch: appt.arch,
      hostName: hostNameFrom(rows),
      slotMinutes: slot,
      patientMinutes,
      hostMinutes,
      vsSlotMinutes: patientMinutes === null ? null : patientMinutes - slot,
      sessions,
    });
  }

  // Drop the recycled-link calls report-wide. Keep no-answer calls (null
  // duration) — those are genuine no-shows the report still cares about.
  const realCalls = calls.filter(
    (c) => c.patientMinutes === null || c.patientMinutes > MIN_REAL_CALL_MINUTES,
  );
  realCalls.sort(
    (a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime(),
  );

  return {
    slotMinutes,
    calls: realCalls,
    ...summarizeCalls(realCalls),
  };
}

// ── Hook ────────────────────────────────────────────────────────────

interface VirtualImpressionsResult {
  data: VirtualImpressionsData | null;
  loading: boolean;
  error: string | null;
}

export function useReportsVirtualImpressions(range: DateRange): VirtualImpressionsResult {
  const [data, setData] = useState<VirtualImpressionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { fromIso, toIso } = dateRangeToUtcBounds(range);
    (async () => {
      try {
        const apptRes = await supabase
          .from('lng_appointments')
          .select(
            'id, appointment_ref, patient_id, start_at, end_at, status, arch, conference_started_at, conference_ended_at',
          )
          .eq('service_type', 'virtual_impression_appointment')
          .gte('start_at', fromIso)
          .lte('start_at', toIso);
        if (apptRes.error) throw new Error(`appointments: ${apptRes.error.message}`);
        const appointments = (apptRes.data ?? []) as ViAppointmentRow[];

        if (appointments.length === 0) {
          if (cancelled) return;
          setData(aggregateVirtualImpressions([], [], []));
          setLoading(false);
          return;
        }

        const apptIds = appointments.map((a) => a.id);
        const patientIds = Array.from(
          new Set(
            appointments
              .map((a) => a.patient_id)
              .filter((id): id is string => !!id),
          ),
        );

        const [attRes, patRes] = await Promise.all([
          supabase
            .from('lng_meet_attendance')
            .select('appointment_id, is_host, participant_name, joined_at, left_at')
            .in('appointment_id', apptIds),
          patientIds.length
            ? supabase
                .from('patients')
                .select('id, first_name, last_name')
                .in('id', patientIds)
            : Promise.resolve({ data: [], error: null }),
        ]);
        if (cancelled) return;
        if (attRes.error) throw new Error(`attendance: ${attRes.error.message}`);
        if (patRes.error) throw new Error(`patients: ${patRes.error.message}`);

        const out = aggregateVirtualImpressions(
          appointments,
          (attRes.data ?? []) as ViAttendanceRow[],
          (patRes.data ?? []) as ViPatientRow[],
        );
        if (cancelled) return;
        setData(out);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message =
          e instanceof Error ? e.message : 'Could not load virtual impressions';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'reports.virtual_impressions',
          severity: 'error',
          message,
          context: { range },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range]);

  return { data, loading, error };
}

// ── Display helpers ─────────────────────────────────────────────────

// Whole-minute call durations read cleanly on a dashboard. Sub-minute
// calls collapse to "<1 min" rather than "0 min" so a 40-second call
// doesn't look like a no-show.
export function formatCallMinutes(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 1) return '<1 min';
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  const hrs = Math.floor(rounded / 60);
  const rem = rounded % 60;
  return rem === 0 ? `${hrs} hr` : `${hrs} hr ${rem} min`;
}

// "6 min under", "4 min over", "on the slot". Drives the per-call
// supporting line so a reader instantly sees over/under the booking.
export function formatVsSlot(vsSlotMinutes: number | null): string {
  if (vsSlotMinutes === null) return 'No answer';
  const rounded = Math.round(vsSlotMinutes);
  if (rounded === 0) return 'On the slot';
  return rounded < 0 ? `${-rounded} min under` : `${rounded} min over`;
}
