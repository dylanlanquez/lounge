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
//      generate_appointment_ref() so the LAP counter stays monotonic.
//      The guard trigger refuses to re-stamp.
//   3. The caller then runs markAppointmentArrived() which creates the
//      lng_visits row and the patient_events row.

export interface ArrivalIntakePatientInput {
  first_name?: string | null;
  last_name?: string | null;
  date_of_birth?: string | null; // ISO YYYY-MM-DD
  sex?: string | null;
  email?: string | null;
  phone?: string | null;
  // Structured address — these mirror Meridian's portal_ship_* columns.
  // The legacy single-line `patients.address` field is no longer
  // written by the intake gate; new patients fill the structured set
  // and existing patients keep whatever was synced from Shopify.
  portal_ship_line1?: string | null;
  portal_ship_line2?: string | null;
  portal_ship_city?: string | null;
  portal_ship_postcode?: string | null;
  portal_ship_country_code?: string | null;
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
  portal_ship_line1: string | null;
  portal_ship_line2: string | null;
  portal_ship_city: string | null;
  portal_ship_postcode: string | null;
  portal_ship_country_code: string | null;
  allergies: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
}

const INTAKE_PATIENT_COLUMNS =
  'first_name, last_name, date_of_birth, sex, email, phone, portal_ship_line1, portal_ship_line2, portal_ship_city, portal_ship_postcode, portal_ship_country_code, allergies, emergency_contact_name, emergency_contact_phone';

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
        .select('first_name, last_name, date_of_birth, sex, email, phone, allergies')
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
        portal_ship_line1: null,
        portal_ship_line2: null,
        portal_ship_city: null,
        portal_ship_postcode: null,
        portal_ship_country_code: null,
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
    portal_ship_line1: row.portal_ship_line1 ?? null,
    portal_ship_line2: row.portal_ship_line2 ?? null,
    portal_ship_city: row.portal_ship_city ?? null,
    portal_ship_postcode: row.portal_ship_postcode ?? null,
    portal_ship_country_code: row.portal_ship_country_code ?? null,
    allergies: row.allergies ?? null,
    emergency_contact_name: row.emergency_contact_name ?? null,
    emergency_contact_phone: row.emergency_contact_phone ?? null,
  };
}

export interface ArrivalIntakeInput {
  // Existing booked appointment id, when intake is gating a Schedule
  // arrival. Omitted for walk-ins — the lng_walk_ins row doesn't exist
  // yet at intake time, so the parent (NewWalkIn) creates it AFTER
  // intake submit using the appointment_ref this returns.
  appointmentId?: string;
  patientId: string;
  patient: ArrivalIntakePatientInput;
  jbRef: string | null; // digits-only, '33' not 'JB33'. NULL when not applicable.
  // Patient-row keys the receptionist or patient explicitly edited via
  // the on-file pencil. These bypass the fill-blanks rule and overwrite
  // whatever's currently on the row. Anything not in this set still
  // follows fill-blanks (only writes when the column is null).
  editedKeys?: Set<keyof ArrivalIntakePatientInput>;
}

export interface ArrivalIntakeResult {
  appointment_ref: string;
}

export async function submitArrivalIntake(
  input: ArrivalIntakeInput
): Promise<ArrivalIntakeResult> {
  // ── 1. patients fill-blanks (and explicit overrides) ─────────────
  // Default behaviour: only write fields that are null on the patients
  // row (the brief's fill-blanks rule). Exception: keys in editedKeys
  // were touched explicitly via the pencil edit gesture, so the
  // patient's intent is to overwrite — those write unconditionally.
  const snapshot = await readIntakeSnapshot(input.patientId);
  const writes: Record<string, string> = {};
  const editedKeys = input.editedKeys ?? new Set<keyof ArrivalIntakePatientInput>();

  const stage = (
    key: keyof ArrivalIntakeSnapshot & keyof ArrivalIntakePatientInput,
    value: string | null | undefined
  ) => {
    const current = snapshot[key];
    const trimmed = typeof value === 'string' ? value.trim() : null;
    if (!trimmed) return;
    if (editedKeys.has(key)) {
      writes[key] = trimmed;
      return;
    }
    if (current === null || current === '') {
      writes[key] = trimmed;
    }
  };

  stage('first_name', input.patient.first_name);
  stage('last_name', input.patient.last_name);
  stage('date_of_birth', input.patient.date_of_birth);
  stage('sex', input.patient.sex);
  stage('email', input.patient.email);
  stage('phone', input.patient.phone);
  stage('portal_ship_line1', input.patient.portal_ship_line1);
  stage('portal_ship_line2', input.patient.portal_ship_line2);
  stage('portal_ship_city', input.patient.portal_ship_city);
  stage('portal_ship_postcode', input.patient.portal_ship_postcode);
  stage('portal_ship_country_code', input.patient.portal_ship_country_code);
  stage('allergies', input.patient.allergies);
  stage('emergency_contact_name', input.patient.emergency_contact_name);
  stage('emergency_contact_phone', input.patient.emergency_contact_phone);

  if (Object.keys(writes).length > 0) {
    const { error: patientErr } = await supabase
      .from('patients')
      .update(writes)
      .eq('id', input.patientId);
    if (patientErr) {
      throw new Error(`Could not save patient details: ${patientErr.message}`);
    }
  }

  // ── 2. appointment_ref ─────────────────────────────────────────────
  // For booked appointments we read any existing ref first so a
  // duplicate submit reuses it rather than burning a new sequence
  // number against the guard trigger. For walk-ins there is no row to
  // read from yet, so we just generate a fresh ref and let the caller
  // (NewWalkIn) write it onto the new lng_walk_ins row.
  let appointmentRef: string | null = null;

  if (input.appointmentId) {
    const { data: existing, error: existingErr } = await supabase
      .from('lng_appointments')
      .select('appointment_ref')
      .eq('id', input.appointmentId)
      .maybeSingle();
    if (existingErr) {
      throw new Error(`Could not read appointment: ${existingErr.message}`);
    }
    appointmentRef =
      (existing as { appointment_ref: string | null } | null)?.appointment_ref ?? null;
  }

  if (!appointmentRef) {
    const { data: ref, error: refErr } = await supabase.rpc('generate_appointment_ref');
    if (refErr || typeof ref !== 'string') {
      throw new Error(refErr?.message ?? 'Could not generate appointment reference');
    }
    appointmentRef = ref;
  }

  // 3. Stamp the booked-appointment row, if any. Walk-ins skip this
  //    step — the parent creates lng_walk_ins with the ref baked in.
  if (input.appointmentId) {
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
    source: 'lab_order' | 'walk_in';
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
    const code = (body.error as string | undefined) ?? `HTTP ${r.status}`;
    const detail = body.detail as string | undefined;
    const source = body.source as string | undefined;
    // Surface the Checkpoint error detail so we can diagnose schema /
    // permission issues from the toast rather than digging through
    // function logs every time.
    const message = detail
      ? `JB check failed: ${code}${source ? ` (${source})` : ''} — ${detail}`
      : `JB check failed: ${code}`;
    throw new Error(message);
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
  return /impression|repair|veneer|aligner|retainer|guard|appliance/i.test(eventTypeLabel);
}

// Map a walk-in service_type to a display label the intake sheet can
// read with its existing event-label heuristic. Keeps NewWalkIn from
// having to duplicate the JB-requirement logic.
export function walkInServiceLabel(serviceType: string | null): string | null {
  switch (serviceType) {
    case 'denture_repair':
      return 'Denture repair';
    case 'same_day_appliance':
      return 'Same-day appliance';
    case 'click_in_veneers':
      return 'Click-in veneers';
    case 'impression_appointment':
      return 'In-person Impression Appointment';
    default:
      return null;
  }
}
