import { supabase } from '../supabase.ts';

// Arrival intake — persisting the data captured by the
// ArrivalIntakeSheet before staff actually flip the appointment to
// 'arrived'. Three writes happen here, in this order, so a partial
// failure leaves the appointment unmarked rather than half-arrived:
//
//   1. patients fill-blanks merge (first/last/dob/sex/email/phone/address/
//      allergies/emergency contact). Only writes columns that were NULL
//      on the row we just read; matches the project's brief-§14
//      fill-blanks rule for patient ingestion. Values that already exist
//      are not touched.
//   2. lng_appointments stamp (jb_ref + appointment_ref). The
//      appointment_ref is generated server-side via
//      generate_appointment_ref() so the LNGE-APT counter stays
//      monotonic per day. The guard trigger refuses to re-stamp.
//   3. The caller then runs markAppointmentArrived() which creates the
//      lng_visits row and the patient_events row.

export interface ArrivalIntakePatientInput {
  first_name?: string | null;
  last_name?: string | null;
  date_of_birth?: string | null; // ISO YYYY-MM-DD
  sex?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  allergies?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
}

export interface ArrivalIntakeSnapshot {
  first_name: string | null;
  last_name: string | null;
  date_of_birth: string | null;
  sex: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  allergies: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
}

const INTAKE_PATIENT_COLUMNS =
  'first_name, last_name, date_of_birth, sex, email, phone, address, allergies, emergency_contact_name, emergency_contact_phone';

// Reads the patient columns the intake sheet needs. Tolerates a missing
// emergency_contact_* column (pre-migration deploys) by retrying with
// the legacy column set and zero-filling the new keys. Once migration
// 28 is applied everywhere this fallback is unreachable.
export async function readIntakeSnapshot(patientId: string): Promise<ArrivalIntakeSnapshot> {
  const { data, error } = await supabase
    .from('patients')
    .select(INTAKE_PATIENT_COLUMNS)
    .eq('id', patientId)
    .maybeSingle();
  if (error) {
    if (error.code === '42703') {
      const { data: legacy, error: legacyErr } = await supabase
        .from('patients')
        .select('first_name, last_name, date_of_birth, sex, email, phone, address, allergies')
        .eq('id', patientId)
        .maybeSingle();
      if (legacyErr) throw new Error(legacyErr.message);
      const row = (legacy ?? {}) as Partial<ArrivalIntakeSnapshot>;
      return {
        first_name: row.first_name ?? null,
        last_name: row.last_name ?? null,
        date_of_birth: row.date_of_birth ?? null,
        sex: row.sex ?? null,
        email: row.email ?? null,
        phone: row.phone ?? null,
        address: row.address ?? null,
        allergies: row.allergies ?? null,
        emergency_contact_name: null,
        emergency_contact_phone: null,
      };
    }
    throw new Error(error.message);
  }
  const row = (data ?? {}) as Partial<ArrivalIntakeSnapshot>;
  return {
    first_name: row.first_name ?? null,
    last_name: row.last_name ?? null,
    date_of_birth: row.date_of_birth ?? null,
    sex: row.sex ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    address: row.address ?? null,
    allergies: row.allergies ?? null,
    emergency_contact_name: row.emergency_contact_name ?? null,
    emergency_contact_phone: row.emergency_contact_phone ?? null,
  };
}

export interface ArrivalIntakeInput {
  appointmentId: string;
  patientId: string;
  patient: ArrivalIntakePatientInput;
  jbRef: string | null; // digits-only, '33' not 'JB33'. NULL when not applicable.
}

export interface ArrivalIntakeResult {
  appointment_ref: string;
}

export async function submitArrivalIntake(
  input: ArrivalIntakeInput
): Promise<ArrivalIntakeResult> {
  // ── 1. patients fill-blanks ────────────────────────────────────────
  const snapshot = await readIntakeSnapshot(input.patientId);
  const fillable: Record<string, string> = {};

  const setIfBlank = (key: keyof ArrivalIntakeSnapshot, value: string | null | undefined) => {
    const current = snapshot[key];
    const trimmed = typeof value === 'string' ? value.trim() : null;
    if ((current === null || current === '') && trimmed) {
      fillable[key] = trimmed;
    }
  };

  setIfBlank('first_name', input.patient.first_name);
  setIfBlank('last_name', input.patient.last_name);
  setIfBlank('date_of_birth', input.patient.date_of_birth);
  setIfBlank('sex', input.patient.sex);
  setIfBlank('email', input.patient.email);
  setIfBlank('phone', input.patient.phone);
  setIfBlank('address', input.patient.address);
  setIfBlank('allergies', input.patient.allergies);
  setIfBlank('emergency_contact_name', input.patient.emergency_contact_name);
  setIfBlank('emergency_contact_phone', input.patient.emergency_contact_phone);

  if (Object.keys(fillable).length > 0) {
    const { error: patientErr } = await supabase
      .from('patients')
      .update(fillable)
      .eq('id', input.patientId);
    if (patientErr) {
      throw new Error(`Could not save patient details: ${patientErr.message}`);
    }
  }

  // ── 2. lng_appointments stamp ───────────────────────────────────────
  // Read current appointment_ref first; if it's already stamped (e.g. a
  // duplicate submit), reuse it rather than burning a new sequence
  // number against the guard trigger.
  const { data: existing, error: existingErr } = await supabase
    .from('lng_appointments')
    .select('appointment_ref')
    .eq('id', input.appointmentId)
    .maybeSingle();
  if (existingErr) {
    throw new Error(`Could not read appointment: ${existingErr.message}`);
  }

  let appointmentRef: string | null =
    (existing as { appointment_ref: string | null } | null)?.appointment_ref ?? null;

  if (!appointmentRef) {
    const { data: ref, error: refErr } = await supabase.rpc('generate_appointment_ref');
    if (refErr || typeof ref !== 'string') {
      throw new Error(refErr?.message ?? 'Could not generate appointment reference');
    }
    appointmentRef = ref;
  }

  const apptUpdate: Record<string, string | null> = {
    appointment_ref: appointmentRef,
    jb_ref: input.jbRef && input.jbRef.trim() ? input.jbRef.trim() : null,
  };

  const { error: apptErr } = await supabase
    .from('lng_appointments')
    .update(apptUpdate)
    .eq('id', input.appointmentId);
  if (apptErr) {
    throw new Error(`Could not save appointment intake: ${apptErr.message}`);
  }

  return { appointment_ref: appointmentRef };
}

// JB conflict check against Checkpoint via the checkpoint-jb-check edge
// function. The function authenticates the receptionist's session and
// fans out to Checkpoint with its service role key, so we never expose
// Checkpoint credentials client-side.
export interface JbAvailabilityResult {
  available: boolean;
  formatted: string; // e.g. "JB33"
  digits: string;    // e.g. "33"
  conflict: {
    order_name: string | null;
    customer_name: string | null;
    status: string | null;
    checked_in_at: string | null;
    source: 'shopify_order' | 'walk_in';
  } | null;
}

export async function checkJbAvailability(jbRef: string): Promise<JbAvailabilityResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Not signed in');

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  if (!supabaseUrl) throw new Error('VITE_SUPABASE_URL not configured');
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0];

  const r = await fetch(`https://${projectRef}.functions.supabase.co/checkpoint-jb-check`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jb_ref: jbRef }),
  });

  let body: Record<string, unknown> = {};
  try {
    body = await r.json();
  } catch {
    body = {};
  }
  if (!r.ok) {
    const detail = (body.error as string | undefined) ?? `HTTP ${r.status}`;
    throw new Error(`JB check failed: ${detail}`);
  }
  return {
    available: body.available === true,
    formatted: (body.formatted as string) ?? '',
    digits: (body.jb_ref as string) ?? '',
    conflict: (body.conflict as JbAvailabilityResult['conflict']) ?? null,
  };
}

// Heuristic: which appointment event labels involve taking an impression
// the lab needs to find later, and therefore require a JB ref at intake.
// Matches denture_repair, click_in_veneers, same_day_appliance and the
// generic "impression / aligner / retainer / guard" cases that sit
// inside same_day_appliance.
export function appointmentRequiresJbRef(eventTypeLabel: string | null): boolean {
  if (!eventTypeLabel) return false;
  return /impression|repair|veneer|aligner|retainer|guard/i.test(eventTypeLabel);
}
