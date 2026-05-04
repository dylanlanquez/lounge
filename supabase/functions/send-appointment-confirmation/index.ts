// send-appointment-confirmation
//
// Emails an appointment confirmation (or update) to the patient with
// an .ics calendar invite attached, sender lounge@venneir.com.
//
// Auth: anon-key Bearer JWT. The caller is the Lounge app, signed in.
//
// Body:
//   {
//     appointmentId: uuid,                  // required — the new / current appointment row
//     oldAppointmentIdToCancel?: uuid,      // optional — when this is a reschedule, the
//                                              old row to send a METHOD:CANCEL .ics for so
//                                              the patient's calendar updates instead of
//                                              getting a duplicate event
//   }
//
// Response: { ok: true } on success. { ok: false, error, reason? } on
// failure. Reason codes the caller may surface to staff:
//
//   delivery_not_configured    RESEND_API_KEY unset (env / dashboard)
//   no_email_on_patient        patient row has no email column value
//   appointment_not_found      bad appointmentId
//
// Loud-failure rule: every catch-that-doesn't-rethrow writes to
// lng_system_failures. Successes write to patient_events
// ('appointment_confirmation_sent') and to lng_event_log
// (source='send-appointment-confirmation', event_type='delivered').
//
// Per brief §5.9 / §1 (loud failures). Wired from
// rescheduleAppointment (best-effort post-step) and the Schedule
// sheet "Resend confirmation" button.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
// Booking emails go from a separate sender than receipts so the
// patient sees a coherent thread per topic. Falls back to the
// lounge@ address per the working agreement; can be overridden via
// the RESEND_FROM_BOOKING env var if we ever want to test on a
// dev sender without redeploying.
const RESEND_FROM = Deno.env.get('RESEND_FROM_BOOKING') ?? 'Venneir Lounge <lounge@venneir.com>';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO_BOOKING') ?? 'lounge@venneir.com';

Deno.serve(async (req) => {
  // Top-level try/catch so any unhandled exception surfaces as a 200
  // with a specific error message instead of a generic non-2xx that
  // shows in the UI as "Edge Function returned a non-2xx status code".
  // The caller's confirmation toast renders the message verbatim.
  try {
    return await handle(req);
  } catch (e) {
    return jsonResponse(200, {
      ok: false,
      error: `send-appointment-confirmation crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    });
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) {
    return jsonResponse(401, { ok: false, error: 'No bearer token' });
  }

  // Two callers: a signed-in user (the staff Lounge app) or another
  // edge function on this same project (widget-create-appointment).
  // The internal path is recognised by a Bearer token equal to the
  // service-role key — only callers that already hold the service-
  // role secret can construct that, which keeps the bypass safe.
  // For internal calls there's no caller account to attribute
  // failure rows to; the logger downgrades to user_id=null.
  const isInternal = userJwt === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  let callerAccountAuthId: string | null = null;
  if (!isInternal) {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: userJwt } },
    });
    const { data: who } = await userClient.auth.getUser();
    if (!who?.user) return jsonResponse(401, { ok: false, error: 'Not signed in' });
    callerAccountAuthId = who.user.id;
  }

  let body: {
    appointmentId?: string;
    oldAppointmentIdToCancel?: string;
    intent?: 'confirmation' | 'cancellation';
  };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const appointmentId = body.appointmentId;
  const oldAppointmentIdToCancel = body.oldAppointmentIdToCancel ?? null;
  const intent: 'confirmation' | 'cancellation' = body.intent ?? 'confirmation';
  if (!appointmentId) {
    return jsonResponse(400, { ok: false, error: 'appointmentId required' });
  }

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Hydrate new appointment ────────────────────────────────────
  const apt = await readAppointment(admin, appointmentId);
  if (!apt) {
    return jsonResponse(404, {
      ok: false,
      error: 'Appointment not found',
      reason: 'appointment_not_found',
    });
  }

  // ── Hydrate optional cancel target ─────────────────────────────
  const oldApt = oldAppointmentIdToCancel
    ? await readAppointment(admin, oldAppointmentIdToCancel)
    : null;

  // ── Patient + location lookups ─────────────────────────────────
  const { data: patientRow } = await admin
    .from('patients')
    .select('first_name, last_name, email')
    .eq('id', apt.patient_id)
    .maybeSingle();
  const patient = patientRow as PatientRow | null;
  if (!patient?.email) {
    // Not a system failure; the patient just has no email. Caller
    // surfaces "no email on file, can't send" inline.
    return jsonResponse(200, {
      ok: false,
      error: 'No email on file for this patient',
      reason: 'no_email_on_patient',
    });
  }

  // Meridian's locations table stores the street address as a single
  // `address` text column, not the address_line_1 / postcode split
  // we'd assumed in the first revision of this function. The original
  // select 4xx'd because of the unknown columns and surfaced to the
  // app as "Edge Function returned a non-2xx status code".
  const { data: locationRow } = await admin
    .from('locations')
    .select('id, name, city, address, phone')
    .eq('id', apt.location_id)
    .maybeSingle();
  const location = locationRow as LocationRow | null;

  // ── Resolve intent → kind ──────────────────────────────────────
  // Three modes:
  //   cancellation  — build CANCEL .ics for the given appointment,
  //                   send "your appointment has been cancelled"
  //                   email. No paired REQUEST.
  //   reschedule    — confirmation intent + oldApt set. REQUEST for
  //                   the new slot + CANCEL for the old, paired in
  //                   one email so calendars update cleanly.
  //   booking       — confirmation intent, no oldApt. REQUEST only.
  const kind: 'booking' | 'reschedule' | 'cancellation' =
    intent === 'cancellation'
      ? 'cancellation'
      : oldApt
      ? 'reschedule'
      : 'booking';

  // ── Build .ics attachment(s) ───────────────────────────────────
  let primaryIcs: string;
  let secondaryIcs: string | null = null;

  if (kind === 'cancellation') {
    // Bumping the sequence is what tells the patient's calendar to
    // actually remove the event — Apple Mail and Outlook ignore
    // CANCEL with a stale sequence.
    primaryIcs = buildIcs({
      method: 'CANCEL',
      uid: icsUid(apt.id),
      sequence: (await currentSequenceForUid(admin, apt.id)) + 1,
      summary: emailSubjectLine(apt, location),
      description: 'This appointment has been cancelled.',
      location: locationFreeform(location),
      startAt: apt.start_at,
      endAt: apt.end_at,
      organizerEmail: RESEND_REPLY_TO,
      organizerName: 'Venneir Lounge',
      attendeeEmail: patient.email,
      attendeeName: fullName(patient),
      url: apt.join_url ?? null,
      status: 'CANCELLED',
    });
  } else {
    const sequence = await currentSequenceForUid(admin, apt.id);
    primaryIcs = buildIcs({
      method: 'REQUEST',
      uid: icsUid(apt.id),
      sequence,
      summary: emailSubjectLine(apt, location),
      description: icsDescription(apt, location),
      location: locationFreeform(location),
      startAt: apt.start_at,
      endAt: apt.end_at,
      organizerEmail: RESEND_REPLY_TO,
      organizerName: 'Venneir Lounge',
      attendeeEmail: patient.email,
      attendeeName: fullName(patient),
      url: apt.join_url ?? null,
      status: 'CONFIRMED',
    });
    if (oldApt) {
      secondaryIcs = buildIcs({
        method: 'CANCEL',
        uid: icsUid(oldApt.id),
        sequence: (await currentSequenceForUid(admin, oldApt.id)) + 1,
        summary: emailSubjectLine(oldApt, location),
        description: 'This appointment has been moved. See the new invite.',
        location: locationFreeform(location),
        startAt: oldApt.start_at,
        endAt: oldApt.end_at,
        organizerEmail: RESEND_REPLY_TO,
        organizerName: 'Venneir Lounge',
        attendeeEmail: patient.email,
        attendeeName: fullName(patient),
        url: oldApt.join_url ?? null,
        status: 'CANCELLED',
      });
    }
  }

  // ── Render email via the editable template ────────────────────
  // Three sibling templates, one per kind. Each is loaded from
  // lng_email_templates so admin edits in the UI go live on the
  // next send. If the row is missing or paused we fail fast with a
  // structured reason — surfacing as a toast in the caller is the
  // right behaviour because the operator likely paused the template
  // deliberately and the receptionist needs to know "no email left
  // the building" rather than guess.
  const templateKey =
    kind === 'cancellation'
      ? 'booking_cancellation'
      : kind === 'reschedule'
      ? 'booking_reschedule'
      : 'booking_confirmation';

  const { data: tplRaw, error: tplErr } = await admin
    .from('lng_email_templates')
    .select('subject, body_syntax, enabled')
    .eq('key', templateKey)
    .maybeSingle();
  if (tplErr) {
    await logFailure(admin, {
      severity: 'error',
      message: `Template read failed for ${templateKey}: ${tplErr.message}`,
      context: { appointmentId, templateKey },
      callerAccountAuthId,
    });
    return jsonResponse(200, { ok: false, error: tplErr.message });
  }
  const template = tplRaw as
    | { subject: string; body_syntax: string; enabled: boolean }
    | null;
  if (!template) {
    await logFailure(admin, {
      severity: 'error',
      message: `Template ${templateKey} not configured`,
      context: { appointmentId, templateKey },
      callerAccountAuthId,
    });
    return jsonResponse(200, {
      ok: false,
      error: `Email template "${templateKey}" not configured. Seed it from the admin panel.`,
      reason: 'template_not_found',
    });
  }
  if (!template.enabled) {
    return jsonResponse(200, {
      ok: false,
      error: 'Email template paused. Re-enable it in Admin → Email templates to send.',
      reason: 'template_disabled',
    });
  }

  // Resolve the booking type so the email can surface the
  // patient-facing duration (or range). Best-effort: if the resolve
  // fails or returns no row, both fields are null and the variable
  // degrades to empty in the template.
  const patientFacingRange = await resolvePatientFacingRange(admin, apt.service_type);

  // Phase data feeds the segmented schedule. Best-effort — empty
  // array degrades to the duration label.
  const [phases, segmentedThresholdMinutes, brandingAndContact] = await Promise.all([
    fetchAppointmentPhases(admin, apt.id),
    resolveSegmentedThresholdMinutes(admin),
    loadBrandingAndContact(admin),
  ]);

  const variables = buildVariables({
    apt,
    oldApt,
    patient,
    location,
    patientFacingMinMinutes: patientFacingRange.min,
    patientFacingMaxMinutes: patientFacingRange.max,
    phases,
    segmentedThresholdMinutes,
    contact: brandingAndContact.contact,
  });
  const subject = substituteVariables(template.subject, variables);
  const bodyAfterVars = substituteVariables(template.body_syntax, variables);
  const html = wrapInLoungeShell(parseFormatting(bodyAfterVars), brandingAndContact.brand);
  const text = bodyToText(bodyAfterVars);

  // ── Deliver via Resend ─────────────────────────────────────────
  if (!RESEND_API_KEY) {
    await logFailure(admin, {
      severity: 'warning',
      message: 'RESEND_API_KEY unset; appointment confirmation not sent',
      context: { appointmentId, patientEmail: patient.email },
      callerAccountAuthId,
    });
    return jsonResponse(200, {
      ok: false,
      error: 'Email delivery not configured',
      reason: 'delivery_not_configured',
    });
  }

  const attachments = [
    {
      filename: kind === 'cancellation' ? 'cancel.ics' : 'invite.ics',
      content: btoa(unicodeEscape(primaryIcs)),
    },
  ];
  if (secondaryIcs) {
    attachments.push({
      filename: 'cancel.ics',
      content: btoa(unicodeEscape(secondaryIcs)),
    });
  }

  const sendResult = await sendEmail({
    to: patient.email,
    subject,
    html,
    text,
    attachments,
  });

  if (!sendResult.ok) {
    await logFailure(admin, {
      severity: 'error',
      message: `Resend delivery failed: ${sendResult.error}`,
      context: {
        appointmentId,
        oldAppointmentIdToCancel,
        patientEmail: patient.email,
      },
      callerAccountAuthId,
    });
    return jsonResponse(200, { ok: false, error: sendResult.error });
  }

  // ── Persist success ────────────────────────────────────────────
  await admin.from('patient_events').insert({
    patient_id: apt.patient_id,
    event_type:
      kind === 'cancellation'
        ? 'appointment_cancellation_sent'
        : 'appointment_confirmation_sent',
    payload: {
      appointment_id: apt.id,
      old_appointment_id_cancelled: oldAppointmentIdToCancel,
      kind,
      recipient: patient.email,
      provider: 'resend',
      message_id: sendResult.messageId ?? null,
    },
  });

  await admin.from('lng_event_log').insert({
    source: 'send-appointment-confirmation',
    event_type: 'delivered',
    location_id: apt.location_id,
    payload: {
      appointment_id: apt.id,
      old_appointment_id_cancelled: oldAppointmentIdToCancel,
      kind,
      message_id: sendResult.messageId ?? null,
    },
  });

  return jsonResponse(200, {
    ok: true,
    kind,
    recipient: patient.email,
    provider: 'resend',
    messageId: sendResult.messageId ?? null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Hydration helpers
// ─────────────────────────────────────────────────────────────────────────────

interface AppointmentRow {
  id: string;
  patient_id: string;
  location_id: string;
  start_at: string;
  end_at: string;
  service_type: string | null;
  event_type_label: string | null;
  appointment_ref: string | null;
  join_url: string | null;
}

interface PatientRow {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

interface LocationRow {
  id: string;
  name: string | null;
  city: string | null;
  address: string | null;
  phone: string | null;
}

// Best-effort resolve of the patient-facing duration range for a
// service. Returns {min, max}. min is the lower bound (or fixed
// value when max is null); max is null unless the admin opted into
// a range. On any error or missing data both are null and the
// rendered variable degrades to empty.
async function resolvePatientFacingRange(
  admin: SupabaseClient,
  serviceType: string | null,
): Promise<{ min: number | null; max: number | null }> {
  if (!serviceType) return { min: null, max: null };
  const { data, error } = await admin.rpc('lng_booking_type_resolve', {
    p_service_type: serviceType,
  });
  if (error) return { min: null, max: null };
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return { min: null, max: null };
  const r = row as {
    patient_facing_min_minutes: number | null;
    patient_facing_max_minutes: number | null;
  };
  const min = typeof r.patient_facing_min_minutes === 'number' && r.patient_facing_min_minutes > 0
    ? r.patient_facing_min_minutes
    : null;
  const max = typeof r.patient_facing_max_minutes === 'number' && r.patient_facing_max_minutes > 0
    ? r.patient_facing_max_minutes
    : null;
  return { min, max };
}

// Materialised phases for an appointment, ordered by phase_index.
// Read straight from lng_appointment_phases — these are snapshots
// taken at booking time so renames / re-configs of the booking type
// later don't drift the email copy from what the patient was told.
interface AppointmentPhase {
  phase_index: number;
  label: string;
  patient_required: boolean;
  start_at: string;
  end_at: string;
}
async function fetchAppointmentPhases(
  admin: SupabaseClient,
  appointmentId: string,
): Promise<AppointmentPhase[]> {
  const { data, error } = await admin
    .from('lng_appointment_phases')
    .select('phase_index, label, patient_required, start_at, end_at')
    .eq('appointment_id', appointmentId)
    .order('phase_index', { ascending: true });
  if (error || !Array.isArray(data)) return [];
  return data as AppointmentPhase[];
}

// Threshold in minutes — if any passive phase runs at least this
// long, the segmented variable renders as a multi-segment schedule
// rather than a single duration line. Sourced from lng_settings so
// admin can tune without redeploy. Default 60 mirrors M3.
async function resolveSegmentedThresholdMinutes(
  admin: SupabaseClient,
): Promise<number> {
  const { data, error } = await admin
    .from('lng_settings')
    .select('value')
    .is('location_id', null)
    .eq('key', 'booking.patient_segmented_threshold_minutes')
    .maybeSingle();
  if (error || !data) return 60;
  const v = (data as { value: unknown }).value;
  if (typeof v === 'number' && v > 0) return v;
  return 60;
}

async function readAppointment(
  admin: SupabaseClient,
  id: string,
): Promise<AppointmentRow | null> {
  const { data } = await admin
    .from('lng_appointments')
    .select(
      'id, patient_id, location_id, start_at, end_at, service_type, event_type_label, appointment_ref, join_url',
    )
    .eq('id', id)
    .maybeSingle();
  return (data as AppointmentRow | null) ?? null;
}

// Counts prior delivery events for a given appointment UID. Returned
// value becomes the SEQUENCE on the next REQUEST (or `+1` for a
// CANCEL of the old UID).
async function currentSequenceForUid(admin: SupabaseClient, appointmentId: string): Promise<number> {
  const { count } = await admin
    .from('lng_event_log')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'send-appointment-confirmation')
    .eq('event_type', 'delivered')
    .filter('payload->>appointment_id', 'eq', appointmentId);
  return count ?? 0;
}

async function logFailure(
  admin: SupabaseClient,
  args: {
    severity: 'warning' | 'error';
    message: string;
    context: Record<string, unknown>;
    callerAccountAuthId: string | null;
  },
): Promise<void> {
  // Best-effort. We don't want failure-logging itself to throw.
  try {
    // Translate the auth user id to the accounts.id (FK target). If
    // it can't be resolved, or if there's no caller (internal call
    // from another edge function), the failure row carries user_id
    // null — still useful as a record.
    let userId: string | null = null;
    if (args.callerAccountAuthId) {
      const { data: acc } = await admin
        .from('accounts')
        .select('id')
        .eq('auth_user_id', args.callerAccountAuthId)
        .maybeSingle();
      userId = (acc as { id: string } | null)?.id ?? null;
    }
    await admin.from('lng_system_failures').insert({
      source: 'send-appointment-confirmation',
      severity: args.severity,
      message: args.message,
      context: args.context,
      user_id: userId,
    });
  } catch {
    // intentionally swallowed — failure of failure-logging shouldn't break the response
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// .ics builder
// ─────────────────────────────────────────────────────────────────────────────

function buildIcs(args: {
  method: 'REQUEST' | 'CANCEL';
  uid: string;
  sequence: number;
  summary: string;
  description: string;
  location: string;
  startAt: string; // ISO
  endAt: string; // ISO
  organizerEmail: string;
  organizerName: string;
  attendeeEmail: string;
  attendeeName: string;
  url: string | null;
  status: 'CONFIRMED' | 'CANCELLED';
}): string {
  const dtstamp = formatIcsDate(new Date().toISOString());
  const dtstart = formatIcsDate(args.startAt);
  const dtend = formatIcsDate(args.endAt);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Venneir//Lounge//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${args.method}`,
    'BEGIN:VEVENT',
    `UID:${args.uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SEQUENCE:${args.sequence}`,
    `SUMMARY:${escapeIcsText(args.summary)}`,
    `DESCRIPTION:${escapeIcsText(args.description)}`,
    `LOCATION:${escapeIcsText(args.location)}`,
    `STATUS:${args.status}`,
    'TRANSP:OPAQUE',
    `ORGANIZER;CN=${escapeIcsText(args.organizerName)}:mailto:${args.organizerEmail}`,
    `ATTENDEE;CN=${escapeIcsText(args.attendeeName)};RSVP=FALSE;PARTSTAT=ACCEPTED:mailto:${args.attendeeEmail}`,
  ];
  if (args.url) lines.push(`URL:${args.url}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  // RFC 5545 line-folding: max 75 octets per line, continuation
  // lines start with a single space. Most clients are forgiving but
  // long DESCRIPTION values trip up Outlook if unfolded.
  return lines.map(foldIcsLine).join('\r\n');
}

function formatIcsDate(iso: string): string {
  // YYYYMMDDTHHmmssZ in UTC.
  const d = new Date(iso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let i = 0;
  // First line: 75 chars; continuation lines: 74 chars (leading space).
  chunks.push(line.slice(i, i + 75));
  i += 75;
  while (i < line.length) {
    chunks.push(' ' + line.slice(i, i + 74));
    i += 74;
  }
  return chunks.join('\r\n');
}

function icsUid(appointmentId: string): string {
  return `${appointmentId}@lounge.venneir.com`;
}

// Patient-facing duration label for the email. Renders "30 min",
// "1 hour", "1 hour 30 min" for fixed values, "30 to 45 min" or
// "1 to 2 hours" for ranges. Returns empty string when min is null
// so the {{patientFacingDuration}} variable degrades to blank
// rather than printing "0 min" or NaN. Mirrors
// patientFacingDurationLabel() in src/lib/queries/bookingTypes.ts.
function formatPatientFacingDurationForEmail(
  min: number | null,
  max: number | null,
): string {
  if (!min || min <= 0) return '';
  if (!max || max <= min) return formatMinutesLong(min);
  return `${formatMinutesLong(min)} to ${formatMinutesLong(max)}`;
}

function formatMinutesLong(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hourWord = h === 1 ? 'hour' : 'hours';
  if (m === 0) return `${h} ${hourWord}`;
  return `${h} ${hourWord} ${m} min`;
}

// Builds the {{patientFacingSchedule}} variable. When the booking
// has a long passive phase (≥ thresholdMinutes), patients shouldn't
// be told a single 5-hour duration — they should be told to come in,
// leave, and come back. Renders one sentence per active phase with
// the start time and a "please return at..." prefix on follow-ups.
//
// When there are no qualifying passive phases (single-phase booking,
// or all passives are short), this falls back to the duration label
// so a template that uses only {{patientFacingSchedule}} still
// renders something useful for short bookings.
function buildPatientFacingSchedule(
  phases: AppointmentPhase[],
  thresholdMinutes: number,
  fallbackDuration: string,
  formatTime: (iso: string) => string,
): string {
  if (phases.length < 2) return fallbackDuration;

  // Detect any passive phase that's long enough to warrant a
  // segmented schedule (the patient genuinely leaves and comes back).
  const hasLongPassive = phases.some((p) => {
    if (p.patient_required) return false;
    const ms = new Date(p.end_at).getTime() - new Date(p.start_at).getTime();
    return ms >= thresholdMinutes * 60_000;
  });
  if (!hasLongPassive) return fallbackDuration;

  // One sentence per active phase. The first reads as the booking
  // start; subsequent active phases read as a "please return"
  // instruction with the time the patient should be back.
  const activePhases = phases.filter((p) => p.patient_required);
  if (activePhases.length === 0) return fallbackDuration;

  const sentences = activePhases.map((p, i) => {
    const durMinutes = Math.max(
      Math.round((new Date(p.end_at).getTime() - new Date(p.start_at).getTime()) / 60_000),
      1,
    );
    const durLabel = formatMinutesLong(durMinutes);
    if (i === 0) {
      return `${p.label} at ${formatTime(p.start_at)} (${durLabel})`;
    }
    return `Please return at approximately ${formatTime(p.start_at)} for ${p.label} (${durLabel})`;
  });

  return `${sentences.join('. ')}.`;
}

// JS strings are UTF-16 but btoa wants Latin-1. Encode UTF-8 bytes as
// Latin-1 first so accented names + pound signs survive the round-trip.
function unicodeEscape(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => String.fromCharCode(b))
    .join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Variable hydration
// ─────────────────────────────────────────────────────────────────────────────
//
// Builds the {{var}} → value map the template renderer interpolates
// against. Every variable surfaced in EMAIL_TEMPLATE_DEFINITIONS is
// hydrated here — both the shared appointment set and the
// reschedule-only "old" trio. Anything missing renders literally as
// {{var}} in the email so QA spots a bad mapping in a test send,
// rather than a silently-empty paragraph reaching a real patient.

interface VariableContext {
  apt: AppointmentRow;
  oldApt: AppointmentRow | null;
  patient: PatientRow;
  location: LocationRow | null;
  // Resolved patient-facing duration as a min/max range. min is
  // the lower bound (or fixed value when max is null); max is null
  // unless the admin opted into a range. Empty string in the
  // rendered template when min is null.
  patientFacingMinMinutes: number | null;
  patientFacingMaxMinutes: number | null;
  // Materialised phases for this appointment + the segmented
  // threshold setting — both feed the {{patientFacingSchedule}}
  // variable. Empty array on legacy appointments or pre-materialised
  // ones falls back to the duration label.
  phases: AppointmentPhase[];
  segmentedThresholdMinutes: number;
  // Clinic-wide contact info pulled from lng_settings. Empty strings
  // when not configured. Powers {{publicEmail}}, {{websiteUrl}},
  // {{bookingLink}}, {{mapUrl}}, {{openingHoursToday}}, and
  // {{openingHoursWeek}} placeholders.
  contact: ContactSettings;
}

function buildVariables(ctx: VariableContext): Record<string, string> {
  const apt = ctx.apt;
  const oldApt = ctx.oldApt;
  const patient = ctx.patient;
  const location = ctx.location;
  const contact = ctx.contact;

  const fmtRange = (iso: string, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', ...opts }).format(
      new Date(iso),
    );
  const dayShort = (iso: string) =>
    fmtRange(iso, { weekday: 'short', day: 'numeric', month: 'short' });
  const time24 = (iso: string) =>
    fmtRange(iso, { hour: '2-digit', minute: '2-digit', hour12: false });
  const dayLong = (iso: string) =>
    fmtRange(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const dateTime = (iso: string) => `${dayShort(iso)} at ${time24(iso)}`;

  const vars: Record<string, string> = {
    patientFirstName: patient.first_name?.trim() || 'there',
    patientLastName: patient.last_name?.trim() || '',
    serviceLabel: labelForService(apt),
    appointmentDateTime: dateTime(apt.start_at),
    appointmentDate: dayShort(apt.start_at),
    appointmentDateLong: dayLong(apt.start_at),
    appointmentTime: time24(apt.start_at),
    locationName: location?.name?.trim() || 'Venneir Lounge',
    locationCity: location?.city?.trim() || '',
    locationAddress: locationFreeform(location),
    locationPhone: location?.phone?.trim() || '',
    publicEmail: contact.publicEmail,
    websiteUrl: contact.websiteUrl,
    bookingLink: contact.bookingUrl,
    mapUrl: contact.mapUrl,
    openingHoursToday: contact.openingHoursToday,
    openingHoursWeek: contact.openingHoursWeek,
    appointmentRef: apt.appointment_ref ?? '',
    googleCalendarUrl: googleCalendarUrl(apt, location),
    patientFacingDuration: formatPatientFacingDurationForEmail(
      ctx.patientFacingMinMinutes,
      ctx.patientFacingMaxMinutes,
    ),
    patientFacingSchedule: buildPatientFacingSchedule(
      ctx.phases,
      ctx.segmentedThresholdMinutes,
      formatPatientFacingDurationForEmail(
        ctx.patientFacingMinMinutes,
        ctx.patientFacingMaxMinutes,
      ),
      time24,
    ),
  };

  if (oldApt) {
    vars.oldAppointmentDateTime = dateTime(oldApt.start_at);
    vars.oldAppointmentDate = dayShort(oldApt.start_at);
    vars.oldAppointmentTime = time24(oldApt.start_at);
  }

  return vars;
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderer pipeline — Deno copy of src/lib/emailRenderer.ts. Kept in
// sync by hand because Deno can't import from src/ directly. The
// reminder edge function carries the same copy; if you change one,
// change all three AND extend src/lib/emailRenderer.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

function substituteVariables(template: string, variables: Record<string, string>): string {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (full, key: string) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      return variables[key] ?? '';
    }
    return full;
  });
}

// Paragraph-based renderer — mirror of src/lib/emailRenderer.ts.
// Every block (paragraph, heading, hr, list, image) wraps with the
// same margin so each gap reads as one consistent paragraph break.
// Keep these functions byte-for-byte aligned with the browser copy
// or sent emails will drift from the in-app preview.

const _BLOCK_MB = '0 0 8px 0';
const _STYLE_PARA = `margin:${_BLOCK_MB}`;
const _STYLE_H2 = `font-size:20px;font-weight:600;margin:${_BLOCK_MB};color:#0E1414;letter-spacing:-0.01em`;
const _STYLE_H3 = `font-size:16px;font-weight:600;margin:${_BLOCK_MB};color:#0E1414;letter-spacing:-0.01em`;
const _STYLE_HR = `border:none;border-top:1px solid #E5E2DC;margin:${_BLOCK_MB}`;
const _STYLE_IMG = `max-width:100%;border-radius:8px;margin:${_BLOCK_MB};display:block`;
const _STYLE_LIST = `margin:${_BLOCK_MB}`;
const _STYLE_LI = 'display:block;padding-left:16px;position:relative;margin:0';
const _STYLE_BUL = 'position:absolute;left:0;top:0;color:#0E1414';

function _applyInlines(text: string): string {
  let out = text;
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/\{color:([^}]+)\}(.+?)\{\/color\}/g, '<span style="color:$1">$2</span>');
  out = out.replace(
    /\[button:(.+?)(?:\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^\]]*))?\]\((.+?)\)/g,
    (
      _: string,
      label: string,
      bg: string | undefined,
      tc: string | undefined,
      rad: string | undefined,
      mt: string | undefined,
      mb: string | undefined,
      url: string,
    ) => {
      const bgC = bg || '#0E1414';
      const tcC = tc || '#FFFFFF';
      const radC = rad || '999';
      const mtC = mt || '12';
      const mbC = mb || '12';
      return `<a href="${url}" style="display:inline-block;padding:12px 28px;background:${bgC};color:${tcC};text-decoration:none;border-radius:${radC}px;font-weight:600;font-size:14px;margin:${mtC}px 0 ${mbC}px 0;letter-spacing:-0.005em">${label}</a>`;
    },
  );
  out = out.replace(
    /\[button:(.+?)(?:\|([^|]*)\|([^|]*)\|([^\]]*))?\]\((.+?)\)/g,
    (
      _: string,
      label: string,
      bg: string | undefined,
      tc: string | undefined,
      rad: string | undefined,
      url: string,
    ) => {
      const bgC = bg || '#0E1414';
      const tcC = tc || '#FFFFFF';
      const radC = rad || '999';
      return `<a href="${url}" style="display:inline-block;padding:12px 28px;background:${bgC};color:${tcC};text-decoration:none;border-radius:${radC}px;font-weight:600;font-size:14px;margin:12px 0;letter-spacing:-0.005em">${label}</a>`;
    },
  );
  out = out.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" style="color:#0E1414;text-decoration:underline">$1</a>');
  return out;
}

function parseFormatting(syntax: string): string {
  if (!syntax) return '';
  const trimmed = syntax.replace(/^\n+|\n+$/g, '');
  if (!trimmed) return '';
  const lines = trimmed.split('\n');
  const blocks: string[] = [];
  let buffer: string[] = [];
  let listItems: string[] = [];
  let emptyStreak = 0;
  const flushBuffer = () => {
    if (buffer.length === 0) return;
    blocks.push(`<p style="${_STYLE_PARA}">${_applyInlines(buffer.join('<br>'))}</p>`);
    buffer = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems
      .map((item) => `<span style="${_STYLE_LI}"><span style="${_STYLE_BUL}">•</span>${_applyInlines(item)}</span>`)
      .join('');
    blocks.push(`<div style="${_STYLE_LIST}">${items}</div>`);
    listItems = [];
  };
  for (const line of lines) {
    if (line === '') {
      flushBuffer();
      flushList();
      emptyStreak++;
      continue;
    }
    if (emptyStreak > 1) {
      for (let i = 0; i < emptyStreak - 1; i++) blocks.push(`<p style="${_STYLE_PARA}">&nbsp;</p>`);
    }
    emptyStreak = 0;
    if (/^---+$/.test(line.trim())) {
      flushBuffer();
      flushList();
      blocks.push(`<hr style="${_STYLE_HR}">`);
      continue;
    }
    const h2 = line.match(/^## (.+)$/);
    if (h2 && h2[1]) {
      flushBuffer();
      flushList();
      blocks.push(`<h2 style="${_STYLE_H2}">${_applyInlines(h2[1])}</h2>`);
      continue;
    }
    const h3 = line.match(/^### (.+)$/);
    if (h3 && h3[1]) {
      flushBuffer();
      flushList();
      blocks.push(`<h3 style="${_STYLE_H3}">${_applyInlines(h3[1])}</h3>`);
      continue;
    }
    const img = line.trim().match(/^!\[([^\]]*)\]\((.+?)\)$/);
    if (img && img[2] !== undefined) {
      flushBuffer();
      flushList();
      blocks.push(`<img src="${img[2]}" alt="${img[1] ?? ''}" style="${_STYLE_IMG}">`);
      continue;
    }
    const li = line.match(/^- (.+)$/);
    if (li && li[1]) {
      flushBuffer();
      listItems.push(li[1]);
      continue;
    }
    flushList();
    buffer.push(line);
  }
  flushBuffer();
  flushList();
  return blocks.join('');
}

function bodyToText(syntax: string): string {
  if (!syntax) return '';
  return syntax
    .replace(/### (.+)/g, '$1')
    .replace(/## (.+)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '$1')
    .replace(/\{color:[^}]+\}([^{]+)\{\/color\}/g, '$1')
    .replace(/!\[([^\]]*)\]\((.+?)\)/g, '[image: $1 — $2]')
    .replace(/\[button:([^|\]]+)(?:\|[^\]]*)?\]\((.+?)\)/g, '$1: $2')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .replace(/^---$/gm, '────────────')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Branding & contact loader — pulls lng_settings and shapes the
// values the renderer + variable map need. Best-effort: if the
// settings query fails we render with empty defaults rather than
// 500 the email send.
// ─────────────────────────────────────────────────────────────────────────────

interface BrandSettings {
  logoUrl: string;
  logoShow: boolean;
  logoMaxWidth: number;
  accentColor: string;
  companyNumber: string;
  vatNumber: string;
  registeredAddress: string;
}

interface ContactSettings {
  publicEmail: string;
  websiteUrl: string;
  bookingUrl: string;
  mapUrl: string;
  openingHoursToday: string;
  openingHoursWeek: string;
}

type OpeningDay = { closed: true } | { open: string; close: string };
const DAY_NAMES_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

async function loadBrandingAndContact(
  admin: SupabaseClient,
): Promise<{ brand: BrandSettings; contact: ContactSettings }> {
  const empty = {
    brand: {
      logoUrl: '',
      logoShow: false,
      logoMaxWidth: 120,
      accentColor: '#0E1414',
      companyNumber: '',
      vatNumber: '',
      registeredAddress: '',
    },
    contact: {
      publicEmail: '',
      websiteUrl: '',
      bookingUrl: '',
      mapUrl: '',
      openingHoursToday: '',
      openingHoursWeek: '',
    },
  };
  const { data: rows, error } = await admin
    .from('lng_settings')
    .select('key, value')
    .or('key.like.email.%,key.like.clinic.%,key.like.legal.%')
    .is('location_id', null);
  if (error || !rows) return empty;
  const map = new Map<string, unknown>();
  for (const r of rows as Array<{ key: string; value: unknown }>) map.set(r.key, r.value);

  const get = <T>(k: string, fallback: T): T => {
    const v = map.get(k);
    return v === undefined || v === null ? fallback : (v as T);
  };

  const brand: BrandSettings = {
    logoUrl: get<string>('email.brand_logo_url', ''),
    logoShow: get<boolean>('email.brand_logo_show', true),
    logoMaxWidth: get<number>('email.brand_logo_max_width', 120),
    accentColor: get<string>('email.brand_accent_color', '#0E1414'),
    companyNumber: get<string>('legal.company_number', ''),
    vatNumber: get<string>('legal.vat_number', ''),
    registeredAddress: get<string>('legal.registered_address', ''),
  };

  const opening = get<OpeningDay[]>('clinic.opening_hours', []);
  const formatDay = (d: OpeningDay | undefined) =>
    !d ? '' : 'closed' in d && d.closed ? 'closed' : `${('open' in d && d.open) || ''}–${('close' in d && d.close) || ''}`;
  const todayIdx = ((new Date().getDay() + 6) % 7); // Mon=0
  const openingHoursToday = formatDay(opening[todayIdx]);
  const openingHoursWeek = opening
    .map((d, i) => `${DAY_NAMES_LONG[i]}: ${formatDay(d)}`)
    .join('\n');

  const contact: ContactSettings = {
    publicEmail: get<string>('clinic.public_email', ''),
    websiteUrl: get<string>('clinic.website_url', ''),
    bookingUrl: get<string>('clinic.booking_url', ''),
    mapUrl: get<string>('clinic.map_url', ''),
    openingHoursToday,
    openingHoursWeek,
  };

  return { brand, contact };
}

function renderLogoHeader(brand: BrandSettings): string {
  if (!brand.logoShow || !brand.logoUrl) return '';
  const maxWidth = Math.max(40, Math.min(320, brand.logoMaxWidth));
  return `<p style="margin:0 0 8px 0;text-align:center"><img src="${brand.logoUrl}" alt="" style="max-width:${maxWidth}px;height:auto;display:inline-block;border:0"></p>`;
}

function renderLegalFooter(brand: BrandSettings): string {
  const lines: string[] = ['Venneir Limited'];
  if (brand.companyNumber) lines.push(`Company no. ${brand.companyNumber}`);
  if (brand.vatNumber) lines.push(`VAT no. ${brand.vatNumber}`);
  if (brand.registeredAddress) lines.push(brand.registeredAddress);
  return `<p style="margin:24px 0 0;color:#7B8285;font-size:12px;text-align:center;line-height:1.55">${lines.join(' · ')}</p>`;
}

function wrapInLoungeShell(bodyHtml: string, brand: BrandSettings): string {
  const logo = renderLogoHeader(brand);
  const footer = renderLegalFooter(brand);
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F7F6F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0E1414;line-height:1.6;-webkit-font-smoothing:antialiased">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px">
    <div style="background:#FFFFFF;border:1px solid #E5E2DC;border-radius:14px;padding:32px 28px;font-size:15px;color:#0E1414">
      ${logo}${bodyHtml}
    </div>
    ${footer}
  </div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// .ics helpers
// ─────────────────────────────────────────────────────────────────────────────

function emailSubjectLine(apt: AppointmentRow, location: LocationRow | null): string {
  const service = labelForService(apt);
  return location?.city ? `${service} at Venneir Lounge ${location.city}` : `${service} at Venneir Lounge`;
}

function icsDescription(apt: AppointmentRow, location: LocationRow | null): string {
  const parts: string[] = [];
  parts.push(labelForService(apt));
  if (location?.name) parts.push(`Location: ${location.name}`);
  if (apt.appointment_ref) parts.push(`Reference: ${apt.appointment_ref}`);
  if (apt.join_url) parts.push(`Join link: ${apt.join_url}`);
  parts.push('Reply to lounge@venneir.com to make changes.');
  return parts.join('\n');
}

function locationFreeform(location: LocationRow | null): string {
  if (!location) return 'Venneir Lounge';
  const pieces = [location.name, location.address, location.city].filter(
    (p): p is string => !!p && p.trim().length > 0,
  );
  return pieces.length ? pieces.join(', ') : 'Venneir Lounge';
}

function googleCalendarUrl(apt: AppointmentRow, location: LocationRow | null): string {
  const start = formatIcsDate(apt.start_at);
  const end = formatIcsDate(apt.end_at);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: emailSubjectLine(apt, location),
    dates: `${start}/${end}`,
    details: icsDescription(apt, location),
    location: locationFreeform(location),
  });
  return `https://www.google.com/calendar/render?${params.toString()}`;
}

function labelForService(apt: AppointmentRow): string {
  if (apt.event_type_label && apt.event_type_label.trim()) return apt.event_type_label.trim();
  switch (apt.service_type) {
    case 'denture_repair':
      return 'Denture repair';
    case 'click_in_veneers':
      return 'Click-in veneers';
    case 'same_day_appliance':
      return 'Same-day appliance';
    case 'impression_appointment':
      return 'Impression appointment';
    default:
      return 'Appointment';
  }
}

function fullName(p: PatientRow): string {
  const n = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
  return n || 'Patient';
}

// ─────────────────────────────────────────────────────────────────────────────
// Resend
// ─────────────────────────────────────────────────────────────────────────────

async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments: Array<{ filename: string; content: string }>;
}): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
  let r: Response;
  try {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [args.to],
        reply_to: RESEND_REPLY_TO,
        subject: args.subject,
        html: args.html,
        text: args.text,
        attachments: args.attachments,
      }),
    });
  } catch (e) {
    return {
      ok: false,
      error: `Resend network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: `Resend ${r.status}: ${JSON.stringify(body)}` };
  return { ok: true, messageId: (body as { id?: string }).id };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}
