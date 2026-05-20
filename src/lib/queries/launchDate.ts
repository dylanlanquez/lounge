// Lounge launch-date settings.
//
// Reads / writes the `lounge.launch_date` row in lng_settings. The
// stored instant is used by the AppointmentDetail "Booked before
// Lounge launched" banner and by the reports range clamp, so that
// pre-launch Calendly history is naturally excluded from the booked
// / arrival funnel without touching any underlying data.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

const SETTING_KEY = 'lounge.launch_date';

interface UseLaunchDate {
  /** ISO timestamptz string the launch_date is set to, or null when unset. */
  data: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useLaunchDate(): UseLaunchDate {
  const [data, setData] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const res = await supabase
        .from('lng_settings')
        .select('value')
        .is('location_id', null)
        .eq('key', SETTING_KEY)
        .maybeSingle();
      if (cancelled) return;
      if (res.error) {
        setError(res.error.message);
        setLoading(false);
        return;
      }
      // JSONB value can be the JSON null literal when unset — strip it.
      const raw = res.data?.value ?? null;
      const iso = typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
      setData(iso);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, refresh };
}

/**
 * Upsert the launch_date value. Pass null to clear it back to the
 * "not set" state (causes the PreLaunchBanner + reports clamp to
 * become no-ops). The settings row is created by the 20260517000001
 * migration, so this function only updates an existing row; if it's
 * missing somehow we insert defensively rather than 404.
 */
export async function setLaunchDate(iso: string | null): Promise<void> {
  // jsonb literal 'null' when clearing; JSON-encoded string otherwise.
  const value: unknown = iso === null ? null : iso;
  const { data: existing, error: readErr } = await supabase
    .from('lng_settings')
    .select('key')
    .is('location_id', null)
    .eq('key', SETTING_KEY)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);

  if (existing) {
    const { error } = await supabase
      .from('lng_settings')
      .update({ value })
      .is('location_id', null)
      .eq('key', SETTING_KEY);
    if (error) throw new Error(error.message);
    return;
  }

  // Settings row missing — recreate so the function can find it next
  // call. Mirrors the migration's description verbatim.
  const { error } = await supabase.from('lng_settings').insert({
    location_id: null,
    key: SETTING_KEY,
    value,
    description:
      'The instant Lounge went live (ISO timestamptz string in JSONB). Drives the AppointmentDetail PreLaunchBanner and the reports range clamp so pre-launch Calendly history is excluded without touching the underlying rows.',
  });
  if (error) throw new Error(error.message);
}

// ─────────────────────────────────────────────────────────────────────
// Test-patient appointment wipe
// ─────────────────────────────────────────────────────────────────────
//
// Hard-coded list of Dylan's pre-launch test inboxes. Centralised so
// the preview + the wipe use the same set and so there's a single
// place to add an inbox if Dylan starts using another address.

export const TEST_PATIENT_EMAILS: readonly string[] = [
  'dylan@venneir.com',
  'dylanjmlane@icloud.com',
  'dylanjmland@icloud.com',
  'dylan@lanquez.com',
  'dylanlane@venneir.com',
  'hello@lanquez.com',
  'alex@venneir.com',
  'venneirlaboratory@gmail.com',
  'dylando@venneir.com',
  'stephen.vazquez@venneir.com',
];

export interface WipeTestPatientAppointmentsResult {
  patients: number;
  appointments: number;
}

/**
 * Preview how many patients + appointments the wipe would affect.
 * Uses two cheap count queries instead of running the RPC, so the
 * confirm sheet can show real numbers before the operator commits.
 */
export async function previewTestPatientAppointmentsWipe(
  emails: readonly string[],
): Promise<WipeTestPatientAppointmentsResult> {
  const lowered = emails.map((e) => e.toLowerCase());
  const patientsRes = await supabase
    .from('patients')
    .select('id')
    .in('email', lowered);
  if (patientsRes.error) throw new Error(patientsRes.error.message);
  const patientIds = (patientsRes.data ?? []).map((r) => (r as { id: string }).id);
  if (patientIds.length === 0) return { patients: 0, appointments: 0 };

  // Count both appointments AND orphan walk-ins keyed on the patient.
  // venneirlaboratory@gmail.com surfaced this gap — its only test row
  // is LAP-00003, a walk-in with no lng_appointments row, so the
  // preview said "0 appointments to wipe" and the operator skipped
  // the bin. The wipe RPC catches walk-ins server-side (see
  // 20260520000003_lng_wipe_orphan_walk_ins.sql); the preview has
  // to match so the count the operator sees matches what the RPC
  // actually deletes.
  const apptRes = await supabase
    .from('lng_appointments')
    .select('id', { head: true, count: 'exact' })
    .in('patient_id', patientIds);
  if (apptRes.error) throw new Error(apptRes.error.message);
  const walkInRes = await supabase
    .from('lng_walk_ins')
    .select('id', { head: true, count: 'exact' })
    .in('patient_id', patientIds);
  if (walkInRes.error) throw new Error(walkInRes.error.message);
  // Walk-ins that ARE referenced by an lng_appointments.walk_in_id
  // would be double-counted (the appointment count + the walk-in
  // count both include them). Subtract that overlap so the figure
  // matches what the RPC reports back ("X appointments" where X is
  // appointment rows + truly-orphan walk-ins).
  const linkedRes = await supabase
    .from('lng_appointments')
    .select('id', { head: true, count: 'exact' })
    .in('patient_id', patientIds)
    .not('walk_in_id', 'is', null);
  if (linkedRes.error) throw new Error(linkedRes.error.message);
  const apptCount = apptRes.count ?? 0;
  const walkInCount = walkInRes.count ?? 0;
  const linkedCount = linkedRes.count ?? 0;
  const orphanWalkIns = Math.max(0, walkInCount - linkedCount);
  return {
    patients: patientIds.length,
    appointments: apptCount + orphanWalkIns,
  };
}

/**
 * Invoke lng_wipe_test_patient_appointments(p_emails). Deletes every
 * appointment + cascaded artefact for patients whose email matches one
 * in the supplied list. Idempotent — a re-run with the same emails
 * after a successful wipe deletes zero extra rows. Returns the count
 * pair the RPC computed.
 */
export async function wipeTestPatientAppointments(
  emails: readonly string[],
): Promise<WipeTestPatientAppointmentsResult> {
  const { data, error } = await supabase.rpc('lng_wipe_test_patient_appointments', {
    p_emails: emails,
  });
  if (error) throw new Error(error.message);
  // Supabase returns set-returning function results as an array of
  // rows; the function emits exactly one row.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') {
    throw new Error('Unexpected response from lng_wipe_test_patient_appointments');
  }
  const r = row as { patients?: number; appointments?: number };
  return {
    patients: Number(r.patients ?? 0),
    appointments: Number(r.appointments ?? 0),
  };
}
