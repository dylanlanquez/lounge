import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { logFailure } from '../failureLog.ts';

// The call record. See migration 20260916000001_lng_voice_call_log.sql
// for the model: one row per logged attempt, append-only. This module
// is the single place that writes the record, flips the appointment's
// status to match, and reads it back — for the per-appointment "Call
// record" card and the per-patient "Previous calls" history.

export type VoiceCallOutcome =
  | 'answered'
  | 'no_answer'
  | 'voicemail'
  | 'wrong_number'
  | 'busy'
  | 'call_back_requested';

export interface VoiceCallOutcomeOption {
  value: VoiceCallOutcome;
  label: string;
  // Drives the badge colour everywhere an outcome is shown: good =
  // the call did its job, bad = the patient was not reached and
  // nothing is scheduled to follow up, warn = reached a dead end that
  // is still moving (voicemail, busy, asked to call back).
  tone: 'good' | 'bad' | 'warn';
}

export const VOICE_CALL_OUTCOMES: readonly VoiceCallOutcomeOption[] = [
  { value: 'answered', label: 'Answered', tone: 'good' },
  { value: 'no_answer', label: 'No answer', tone: 'bad' },
  { value: 'voicemail', label: 'Left voicemail', tone: 'warn' },
  { value: 'call_back_requested', label: 'Call back requested', tone: 'warn' },
  { value: 'busy', label: 'Line busy', tone: 'warn' },
  { value: 'wrong_number', label: 'Wrong number', tone: 'bad' },
];

export function voiceCallOutcomeLabel(outcome: string): string {
  return VOICE_CALL_OUTCOMES.find((o) => o.value === outcome)?.label ?? outcome;
}

export function voiceCallOutcomeTone(outcome: string): 'good' | 'bad' | 'warn' {
  return VOICE_CALL_OUTCOMES.find((o) => o.value === outcome)?.tone ?? 'warn';
}

export interface VoiceCallLogRow {
  id: string;
  appointment_id: string;
  patient_id: string;
  outcome: VoiceCallOutcome;
  note: string | null;
  created_at: string;
  created_by: string | null;
  author_name: string | null;
}

interface RawLogRow {
  id: string;
  appointment_id: string;
  patient_id: string;
  outcome: string;
  note: string | null;
  created_at: string;
  created_by: string | null;
}

// Two-step author resolution (log rows, then the distinct accounts
// behind them) rather than an embedded select — keeps this query
// independent of any named FK relationship existing in PostgREST's
// schema cache, the same defensive shape patientFiles.ts and
// notifications.ts use elsewhere in this codebase.
async function withAuthorNames(rows: RawLogRow[]): Promise<VoiceCallLogRow[]> {
  const ids = Array.from(new Set(rows.map((r) => r.created_by).filter((id): id is string => !!id)));
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data } = await supabase
      .from('accounts')
      .select('id, first_name, last_name, name')
      .in('id', ids);
    for (const a of (data ?? []) as { id: string; first_name: string | null; last_name: string | null; name: string | null }[]) {
      const combined = [a.first_name, a.last_name].filter(Boolean).join(' ').trim();
      names.set(a.id, combined || a.name || 'A team member');
    }
  }
  return rows.map((r) => ({
    id: r.id,
    appointment_id: r.appointment_id,
    patient_id: r.patient_id,
    outcome: r.outcome as VoiceCallOutcome,
    note: r.note,
    created_at: r.created_at,
    created_by: r.created_by,
    author_name: r.created_by ? (names.get(r.created_by) ?? 'A team member') : null,
  }));
}

// Every attempt logged against one booking, newest first. Usually
// zero or one row; a booking can carry more than one if an agent
// tried, missed, and the call was reset and tried again without a
// reschedule.
export function useVoiceCallLog(
  appointmentId: string | null,
  // Bumped by the caller (e.g. after logVoiceCallOutcome resolves) to
  // force a refetch without waiting for appointmentId to change. The
  // internal refresh() below only helps a component that calls it
  // itself; a parent that just wrote the row needs this instead.
  externalRefreshKey?: number,
): {
  data: VoiceCallLogRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [data, setData] = useState<VoiceCallLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!appointmentId) {
      setData([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('lng_voice_call_log')
        .select('id, appointment_id, patient_id, outcome, note, created_at, created_by')
        .eq('appointment_id', appointmentId)
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setData([]);
        setLoading(false);
        return;
      }
      const withNames = await withAuthorNames((rows ?? []) as RawLogRow[]);
      if (cancelled) return;
      setData(withNames);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [appointmentId, tick, externalRefreshKey]);

  return { data, loading, error, refresh };
}

export interface PreviousVoiceCall {
  appointmentId: string;
  startAt: string;
  status: string;
  // The most recent logged attempt for this appointment, if any —
  // null for a call that is still booked (nothing logged yet) or was
  // cancelled/rescheduled before anyone tried it.
  latestOutcome: VoiceCallOutcome | null;
  latestNote: string | null;
}

// Every other voice call this patient has ever had, most recent
// first, each with its latest logged outcome. Source of the "Previous
// calls" count on the appointment page and the full history page.
export function usePatientVoiceCallHistory(
  patientId: string | null,
  excludeAppointmentId: string | null,
): {
  data: PreviousVoiceCall[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [data, setData] = useState<PreviousVoiceCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!patientId) {
      setData([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      let apptQuery = supabase
        .from('lng_appointments')
        .select('id, start_at, status')
        .eq('patient_id', patientId)
        .eq('service_type', 'voice_call')
        .order('start_at', { ascending: false });
      if (excludeAppointmentId) apptQuery = apptQuery.neq('id', excludeAppointmentId);
      const { data: appts, error: apptErr } = await apptQuery;
      if (cancelled) return;
      if (apptErr) {
        setError(apptErr.message);
        setData([]);
        setLoading(false);
        return;
      }
      const apptRows = (appts ?? []) as { id: string; start_at: string; status: string }[];
      if (apptRows.length === 0) {
        setData([]);
        setLoading(false);
        return;
      }
      const { data: logs, error: logErr } = await supabase
        .from('lng_voice_call_log')
        .select('appointment_id, outcome, note, created_at')
        .in('appointment_id', apptRows.map((a) => a.id))
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (logErr) {
        setError(logErr.message);
        setData([]);
        setLoading(false);
        return;
      }
      // Newest-first order means the first log row seen per
      // appointment is already its latest attempt.
      const latestByAppt = new Map<string, { outcome: VoiceCallOutcome; note: string | null }>();
      for (const l of (logs ?? []) as { appointment_id: string; outcome: string; note: string | null }[]) {
        if (!latestByAppt.has(l.appointment_id)) {
          latestByAppt.set(l.appointment_id, { outcome: l.outcome as VoiceCallOutcome, note: l.note });
        }
      }
      setData(
        apptRows.map((a) => ({
          appointmentId: a.id,
          startAt: a.start_at,
          status: a.status,
          latestOutcome: latestByAppt.get(a.id)?.outcome ?? null,
          latestNote: latestByAppt.get(a.id)?.note ?? null,
        })),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, excludeAppointmentId, tick]);

  return { data, loading, error, refresh };
}

// Logs one attempt: writes the record row, flips the appointment to
// the matching status (complete when answered, no_show otherwise —
// the same states every other booking type already uses for these
// outcomes, so Ledger/Reports/the schedule need no new branch), and
// writes a patient_events row.
//
// "no_show" is deliberately reused as the event_type for every
// not-reached outcome rather than minting a new vocabulary word: a
// missed voice call IS a no-show, and reusing it means the existing
// no-show sentence on the notifications bell and the no-show reports
// already understand it, with the outcome carried in payload.reason.
//
// The record row is the point of this function, so unlike markNoShow
// (which tolerates a failed audit write) a failure here is surfaced
// to the caller — logLogFailed on the result — even though the status
// change itself has already committed and is not rolled back.
export async function logVoiceCallOutcome(args: {
  appointmentId: string;
  patientId: string;
  outcome: VoiceCallOutcome;
  note: string | null;
}): Promise<{ status: 'complete' | 'no_show'; logWriteFailed: boolean }> {
  const status: 'complete' | 'no_show' = args.outcome === 'answered' ? 'complete' : 'no_show';
  const trimmedNote = args.note?.trim() || null;

  const { error: apptErr } = await supabase
    .from('lng_appointments')
    .update({ status, cancel_reason: status === 'no_show' ? voiceCallOutcomeLabel(args.outcome) : null })
    .eq('id', args.appointmentId);
  if (apptErr) throw new Error(apptErr.message);

  const { data: accountId } = await supabase.rpc('auth_account_id');
  const actorId = (accountId as string | null) ?? null;

  const { error: logErr } = await supabase.from('lng_voice_call_log').insert({
    appointment_id: args.appointmentId,
    patient_id: args.patientId,
    outcome: args.outcome,
    note: trimmedNote,
    created_by: actorId,
  });
  let logWriteFailed = false;
  if (logErr) {
    logWriteFailed = true;
    await logFailure({
      source: 'voiceCallLog.logVoiceCallOutcome',
      severity: 'error',
      message: `lng_voice_call_log insert failed: ${logErr.message}`,
      context: { appointmentId: args.appointmentId, outcome: args.outcome },
    });
  }

  await supabase.from('patient_events').insert({
    patient_id: args.patientId,
    event_type: status === 'complete' ? 'voice_call_answered' : 'no_show',
    actor_account_id: actorId,
    payload:
      status === 'complete'
        ? { appointment_id: args.appointmentId, staff_account_id: actorId, note: trimmedNote }
        : {
            appointment_id: args.appointmentId,
            reason: args.outcome,
            note: trimmedNote ?? undefined,
            was_virtual: false,
            joined_before_no_show: false,
          },
  });

  return { status, logWriteFailed };
}

// Undoes a logged outcome: the appointment always returns to
// 'booked' — a voice call never creates a visit, so there is no
// 'arrived' branch to consider the way reverseNoShow has for
// in-person bookings. The log row from the original attempt is kept;
// it is a historical fact, not a mistake to erase.
export async function reverseVoiceCallOutcome(appointmentId: string, patientId: string): Promise<void> {
  const { error } = await supabase
    .from('lng_appointments')
    .update({ status: 'booked', cancel_reason: null })
    .eq('id', appointmentId);
  if (error) throw new Error(error.message);

  const { data: accountId } = await supabase.rpc('auth_account_id');
  await supabase.from('patient_events').insert({
    patient_id: patientId,
    event_type: 'no_show_reversed',
    actor_account_id: (accountId as string | null) ?? null,
    payload: {
      appointment_id: appointmentId,
      staff_account_id: (accountId as string | null) ?? null,
      reversed_at: new Date().toISOString(),
      restored_status: 'booked',
      was_virtual: false,
    },
  });
}
