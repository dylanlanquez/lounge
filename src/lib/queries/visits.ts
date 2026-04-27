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

interface VisitDetailResult {
  visit: VisitRow | null;
  patient: PatientRow | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useVisitDetail(visitId: string | undefined): VisitDetailResult {
  const [visit, setVisit] = useState<VisitRow | null>(null);
  const [patient, setPatient] = useState<PatientRow | null>(null);
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
        const { data: p } = await supabase
          .from('patients')
          .select(
            'id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, lwo_ref, shopify_customer_id'
          )
          .eq('id', v.patient_id)
          .maybeSingle();
        if (!cancelled) setPatient(p as PatientRow | null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [visitId, tick]);

  return { visit, patient, loading, error, refresh };
}
