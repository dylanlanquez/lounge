import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import type { PatientRow } from './patients.ts';

export interface VisitRow {
  id: string;
  patient_id: string;
  location_id: string;
  appointment_id: string | null;
  walk_in_id: string | null;
  status: 'opened' | 'in_progress' | 'complete' | 'cancelled';
  arrival_type: 'walk_in' | 'scheduled';
  receptionist_id: string | null;
  opened_at: string;
  closed_at: string | null;
  notes: string | null;
}

export interface CreateWalkInInput {
  patient_id: string;
  location_id: string;
  service_type?: string;
  notes?: string;
}

// Creates a walk-in + visit pair, stamps lwo_ref on the patient if not set,
// writes a patient_events row. Returns the new visit id.
export async function createWalkInVisit(input: CreateWalkInInput): Promise<{ visit_id: string; walk_in_id: string; lwo_ref: string | null }> {
  const { data: walkIn, error: walkInErr } = await supabase
    .from('lng_walk_ins')
    .insert({
      patient_id: input.patient_id,
      location_id: input.location_id,
      arrival_type: 'walk_in',
      service_type: input.service_type ?? null,
    })
    .select('id')
    .single();
  if (walkInErr || !walkIn) throw new Error(walkInErr?.message ?? 'Could not create walk-in');

  const { data: visit, error: visitErr } = await supabase
    .from('lng_visits')
    .insert({
      patient_id: input.patient_id,
      location_id: input.location_id,
      walk_in_id: walkIn.id,
      arrival_type: 'walk_in',
      status: 'opened',
      notes: input.notes ?? null,
    })
    .select('id')
    .single();
  if (visitErr || !visit) throw new Error(visitErr?.message ?? 'Could not create visit');

  // Stamp lwo_ref on the patient if not already set. UPDATE … WHERE lwo_ref IS NULL
  // makes it idempotent under a race; the patients_guard_lwo_ref trigger refuses
  // to overwrite a non-null lwo_ref.
  const { data: stampRows } = await supabase
    .from('patients')
    .update({ lwo_ref: '__GENERATE__' }) // placeholder — see SQL function below
    .eq('id', input.patient_id)
    .is('lwo_ref', null)
    .select('lwo_ref');

  let lwoRef: string | null = null;
  if (Array.isArray(stampRows) && stampRows.length > 0) {
    // The placeholder will be replaced by an RPC call to generate_lwo_ref().
    // Two-step: read the generated value back.
    const { data: ref } = await supabase.rpc('generate_lwo_ref');
    if (typeof ref === 'string') {
      await supabase.from('patients').update({ lwo_ref: ref }).eq('id', input.patient_id).is('lwo_ref', null);
      lwoRef = ref;
    }
    // Reset placeholder if generation failed (kept under guard trigger anyway).
    if (!ref) {
      await supabase.from('patients').update({ lwo_ref: null }).eq('id', input.patient_id).eq('lwo_ref', '__GENERATE__');
    }
  } else {
    // Patient already had an lwo_ref. Read it.
    const { data: existing } = await supabase
      .from('patients')
      .select('lwo_ref')
      .eq('id', input.patient_id)
      .maybeSingle();
    lwoRef = existing?.lwo_ref ?? null;
  }

  // Write patient_events
  await supabase.from('patient_events').insert({
    patient_id: input.patient_id,
    event_type: 'walk_in_arrived',
    payload: {
      visit_id: visit.id,
      walk_in_id: walkIn.id,
      lwo_ref: lwoRef,
      service_type: input.service_type ?? null,
    },
  });

  return { visit_id: visit.id, walk_in_id: walkIn.id, lwo_ref: lwoRef };
}

// The reasons a receptionist can pick when flipping an appointment to
// no_show. Persisted to lng_appointments.cancel_reason and echoed in the
// patient_events.no_show payload so reports can break no-shows down by
// cause without re-reading the appointments row.
export type NoShowReason = 'did_not_turn_up' | 'patient_cancelled_late' | 'clinic_cancelled' | 'other';

export const NO_SHOW_REASONS: { value: NoShowReason; label: string }[] = [
  { value: 'did_not_turn_up', label: 'Did not turn up' },
  { value: 'patient_cancelled_late', label: 'Patient cancelled late' },
  { value: 'clinic_cancelled', label: 'Clinic cancelled' },
  { value: 'other', label: 'Other' },
];

export interface MarkNoShowContext {
  patientId: string | null;
  wasVirtual: boolean;
  joinedBeforeNoShow: boolean;
}

// Flips an appointment to no_show, stamping the reason on
// lng_appointments.cancel_reason and emitting a patient_events row so the
// timeline + reports both have the cause.
export async function markNoShow(
  appointmentId: string,
  reason: NoShowReason,
  context: MarkNoShowContext
): Promise<void> {
  const { error } = await supabase
    .from('lng_appointments')
    .update({ status: 'no_show', cancel_reason: reason })
    .eq('id', appointmentId);
  if (error) throw new Error(error.message);

  if (!context.patientId) return;
  await supabase.from('patient_events').insert({
    patient_id: context.patientId,
    event_type: 'no_show',
    payload: {
      appointment_id: appointmentId,
      reason,
      was_virtual: context.wasVirtual,
      joined_before_no_show: context.joinedBeforeNoShow,
    },
  });
}

// Reverses a no-show flag. Patient turned up late after staff already
// flipped them — flip status back to 'arrived' and record a
// no_show_reversed event so the timeline preserves the full
// booked → no_show → reversed audit trail.
//
// For in-person no_shows we also create the lng_visit that the patient
// would have got from Mark as arrived, so the receptionist can drop
// straight into the EPOS / cart flow. Returns visit_id when one was
// created or already existed.
export async function reverseNoShow(appointmentId: string): Promise<{ visit_id?: string }> {
  const { data: appt, error } = await supabase
    .from('lng_appointments')
    .update({ status: 'arrived' })
    .eq('id', appointmentId)
    .select('id, patient_id, location_id, join_url')
    .single();
  if (error || !appt) throw new Error(error?.message ?? 'Could not undo no-show');
  const apptRow = appt as { id: string; patient_id: string; location_id: string; join_url: string | null };

  const { data: accountId } = await supabase.rpc('auth_account_id');

  // If a visit already exists (e.g. Patient previously arrived then was
  // re-flagged), reuse it. Otherwise, in-person bookings need one created
  // so they can flow through to /visit.
  const { data: existingVisit } = await supabase
    .from('lng_visits')
    .select('id')
    .eq('appointment_id', appointmentId)
    .maybeSingle();

  let visitId: string | undefined = (existingVisit as { id: string } | null)?.id;

  const isVirtual = !!apptRow.join_url;
  if (!visitId && !isVirtual) {
    const { data: visit, error: visitErr } = await supabase
      .from('lng_visits')
      .insert({
        patient_id: apptRow.patient_id,
        location_id: apptRow.location_id,
        appointment_id: apptRow.id,
        arrival_type: 'scheduled',
        status: 'opened',
      })
      .select('id')
      .single();
    if (!visitErr && visit) {
      visitId = (visit as { id: string }).id;
      const { data: ref } = await supabase.rpc('generate_lwo_ref');
      if (typeof ref === 'string') {
        await supabase
          .from('patients')
          .update({ lwo_ref: ref })
          .eq('id', apptRow.patient_id)
          .is('lwo_ref', null);
      }
    }
  }

  await supabase.from('patient_events').insert({
    patient_id: apptRow.patient_id,
    event_type: 'no_show_reversed',
    payload: {
      appointment_id: apptRow.id,
      staff_account_id: accountId ?? null,
      reversed_at: new Date().toISOString(),
      visit_id: visitId ?? null,
      was_virtual: isVirtual,
    },
  });

  return { visit_id: visitId };
}

// Records that staff joined a virtual meeting. Flips the appointment to
// 'arrived' (re-uses the existing status — virtual attendance is still
// "the patient turned up") and writes a patient_events row so the
// timeline shows when the meeting was actually attended. Does NOT create
// an lng_visit — virtual impressions don't need an EPOS visit lifecycle.
export async function markVirtualMeetingJoined(appointmentId: string): Promise<void> {
  const { data: appt, error: apptErr } = await supabase
    .from('lng_appointments')
    .update({ status: 'arrived' })
    .eq('id', appointmentId)
    .select('id, patient_id, location_id')
    .single();
  if (apptErr || !appt) throw new Error(apptErr?.message ?? 'Could not record join');

  const { data: accountId } = await supabase.rpc('auth_account_id');

  await supabase.from('patient_events').insert({
    patient_id: appt.patient_id,
    event_type: 'virtual_meeting_joined',
    payload: {
      appointment_id: appt.id,
      staff_account_id: accountId ?? null,
      joined_at: new Date().toISOString(),
    },
  });
}

export async function markAppointmentArrived(appointmentId: string): Promise<{ visit_id: string }> {
  const { data: appt, error: apptErr } = await supabase
    .from('lng_appointments')
    .update({ status: 'arrived' })
    .eq('id', appointmentId)
    .select('id, patient_id, location_id')
    .single();
  if (apptErr || !appt) throw new Error(apptErr?.message ?? 'Could not mark arrived');

  const { data: visit, error: visitErr } = await supabase
    .from('lng_visits')
    .insert({
      patient_id: appt.patient_id,
      location_id: appt.location_id,
      appointment_id: appt.id,
      arrival_type: 'scheduled',
      status: 'opened',
    })
    .select('id')
    .single();
  if (visitErr || !visit) throw new Error(visitErr?.message ?? 'Could not create visit');

  // Stamp lwo_ref if not set
  const { data: ref } = await supabase.rpc('generate_lwo_ref');
  if (typeof ref === 'string') {
    await supabase.from('patients').update({ lwo_ref: ref }).eq('id', appt.patient_id).is('lwo_ref', null);
  }

  await supabase.from('patient_events').insert({
    patient_id: appt.patient_id,
    event_type: 'visit_arrived',
    payload: { visit_id: visit.id, appointment_id: appt.id, source: 'calendly' },
  });

  return { visit_id: visit.id };
}

// Calendly deposit captured at booking time, surfaced through the visit
// so the Pay screen can deduct it from the bill. Null on walk-ins (no
// underlying appointment) and on Calendly bookings whose event type
// doesn't take a deposit.
//
// status = 'paid'   ready to credit at checkout
// status = 'failed' attempt recorded but not collected — the till must NOT
//                   credit it; receptionist should chase.
export interface AppointmentDeposit {
  pence: number;
  currency: string;
  provider: 'paypal' | 'stripe';
  status: 'paid' | 'failed';
}

interface VisitDetailResult {
  visit: VisitRow | null;
  patient: PatientRow | null;
  deposit: AppointmentDeposit | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useVisitDetail(visitId: string | undefined): VisitDetailResult {
  const [visit, setVisit] = useState<VisitRow | null>(null);
  const [patient, setPatient] = useState<PatientRow | null>(null);
  const [deposit, setDeposit] = useState<AppointmentDeposit | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!visitId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: v, error: ve } = await supabase
        .from('lng_visits')
        .select('*')
        .eq('id', visitId)
        .maybeSingle();
      if (cancelled) return;
      if (ve) {
        setError(ve.message);
        setLoading(false);
        return;
      }
      setVisit(v as VisitRow);
      if (v) {
        const visitRow = v as VisitRow;
        const { data: p } = await supabase
          .from('patients')
          .select(
            'id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, lwo_ref, shopify_customer_id'
          )
          .eq('id', visitRow.patient_id)
          .maybeSingle();
        if (!cancelled) setPatient(p as PatientRow | null);

        // Pull the deposit off the linked appointment (if any). Walk-ins
        // don't have one. The 42703 fallback survives a frontend deploy
        // that lands before the deposit migration.
        if (visitRow.appointment_id) {
          const { data: appt, error: apptErr } = await supabase
            .from('lng_appointments')
            .select('deposit_pence, deposit_currency, deposit_provider, deposit_status')
            .eq('id', visitRow.appointment_id)
            .maybeSingle();
          if (!cancelled && !apptErr && appt) {
            const a = appt as {
              deposit_pence: number | null;
              deposit_currency: string | null;
              deposit_provider: 'paypal' | 'stripe' | null;
              deposit_status: 'paid' | 'failed' | null;
            };
            if (
              a.deposit_pence != null &&
              a.deposit_pence > 0 &&
              a.deposit_provider &&
              a.deposit_status
            ) {
              setDeposit({
                pence: a.deposit_pence,
                currency: a.deposit_currency ?? 'GBP',
                provider: a.deposit_provider,
                status: a.deposit_status,
              });
            } else {
              setDeposit(null);
            }
          }
        } else {
          setDeposit(null);
        }
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [visitId, tick]);

  return { visit, patient, deposit, loading, error, refresh };
}
