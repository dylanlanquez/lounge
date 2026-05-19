// send-visit-ready-sms
//
// Manually-fired SMS for a visit. Originally only sent the
// `visit_ready` template; now accepts any of the keys defined under
// lng_sms_templates so the receptionist can fire any of the
// admin-editable SMS templates from the Visit page (please pop back
// to clinic, please call us, clinician running late, reminder to
// attend, etc).
//
// Two-step contract with the UI:
//
//   • Preview pass: ?preview=1 (or { preview: true }) — renders the
//     template body with the visit's variables and returns the text
//     without sending. Lets the receptionist read the SMS before
//     committing.
//   • Send pass: default — same render + Twilio send + audit row in
//     lng_sms_messages so the timeline can show "SMS sent · last4
//     07…".
//
// Auth: signed-in staff JWT. No service-role bypass — this is always
// invoked from a browser session (the Visit page button).
//
// Body shape:
//   { visit_id: string, template_key?: string, preview?: boolean }
//
//   template_key defaults to 'visit_ready' for back-compat with
//   existing callers (the PatientCommsCard "Notify ready" button)
//   that don't pass one.
//
// Returns
//   preview: { ok: true, body: string, to: string }
//   send:    { ok: true, body: string, to: string, twilioSid: string }
//   error:   { ok: false, error: string, reason?: string }

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { normalisePhone, sendSms } from '../_shared/twilioSms.ts';
import { properCase } from '../_shared/properCase.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

const DEFAULT_TEMPLATE_KEY = 'visit_ready';
const ALLOWED_TEMPLATE_KEYS = new Set([
  'visit_ready',
  'please_return',
  'please_call',
  'running_late',
  'reminder_to_attend',
]);

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return jsonResponse(200, {
      ok: false,
      error: `send-visit-ready-sms crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    });
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // ── Auth ────────────────────────────────────────────────────────
  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) return jsonResponse(200, { ok: false, error: 'Not signed in.' });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) return jsonResponse(200, { ok: false, error: 'Not signed in.' });

  // ── Parse body ──────────────────────────────────────────────────
  let body: { visit_id?: string; template_key?: string; preview?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (!body.visit_id) return jsonResponse(200, { ok: false, error: 'visit_id required' });
  const preview = body.preview === true;
  const templateKey = (body.template_key ?? DEFAULT_TEMPLATE_KEY).trim();
  if (!ALLOWED_TEMPLATE_KEYS.has(templateKey)) {
    return jsonResponse(200, {
      ok: false,
      error: `Unknown template "${templateKey}".`,
      reason: 'template_not_allowed',
    });
  }

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Load the visit + everything we need for variable substitution
  const { data: visitRow, error: visitErr } = await admin
    .from('lng_visits')
    .select('id, patient_id, location_id, appointment_id, status, opened_at')
    .eq('id', body.visit_id)
    .maybeSingle();
  if (visitErr || !visitRow) {
    return jsonResponse(200, { ok: false, error: 'Visit not found.', reason: 'visit_not_found' });
  }
  const visit = visitRow as {
    id: string;
    patient_id: string;
    location_id: string | null;
    appointment_id: string | null;
    status: string;
    opened_at: string;
  };

  // Resolver order:
  //   1. patients — first_name, lwo_ref, phone (the SMS destination)
  //   2. locations — name, phone, address, postcode, city (clinic contact strings)
  //   3. lng_appointments — service_type + product_key for itemLabel,
  //      start_at for date/time, clinician_id for staff first name
  //   4. lng_settings — websiteUrl, bookingUrl, publicEmail (used when
  //      a location row's own field is empty)
  const [patientRes, locationRes, apptRes, settingsRes] = await Promise.all([
    admin
      .from('patients')
      .select('first_name, lwo_ref, phone')
      .eq('id', visit.patient_id)
      .maybeSingle(),
    visit.location_id
      ? admin
          .from('locations')
          .select('name, phone, address, postcode, city')
          .eq('id', visit.location_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    visit.appointment_id
      ? admin
          .from('lng_appointments')
          .select('service_type, product_key, arch, appointment_ref, walk_in_id, start_at, staff_account_id')
          .eq('id', visit.appointment_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    admin
      .from('lng_settings')
      .select('key, value')
      .in('key', ['clinic.website_url', 'clinic.booking_url', 'clinic.public_email']),
  ]);
  const patient = patientRes.data as
    | { first_name: string | null; lwo_ref: string | null; phone: string | null }
    | null;
  const location = locationRes.data as
    | {
        name: string | null;
        phone: string | null;
        address: string | null;
        postcode: string | null;
        city: string | null;
      }
    | null;
  const appt = apptRes.data as
    | {
        service_type: string | null;
        product_key: string | null;
        arch: string | null;
        appointment_ref: string | null;
        walk_in_id: string | null;
        start_at: string | null;
        staff_account_id: string | null;
      }
    | null;
  // lng_settings.value is jsonb — for clinic.* string fields the stored
  // value is the JSON string, so we cast through unknown and coerce.
  const settingsRows = (settingsRes.data ?? []) as Array<{ key: string; value: unknown }>;
  const settings = Object.fromEntries(
    settingsRows.map((r) => [r.key, typeof r.value === 'string' ? r.value : String(r.value ?? '')]),
  );

  // Walk-in fallback: by design lng_appointments.appointment_ref is
  // NULL on walk-in marker rows. The LAP for walk-ins lives on
  // lng_walk_ins.appointment_ref. Without this fallback every walk-in
  // visit would render "Reference -." in the SMS.
  let appointmentRef = (appt?.appointment_ref ?? '').trim();
  if (!appointmentRef && appt?.walk_in_id) {
    const { data: walkInRow } = await admin
      .from('lng_walk_ins')
      .select('appointment_ref')
      .eq('id', appt.walk_in_id)
      .maybeSingle();
    appointmentRef =
      ((walkInRow as { appointment_ref: string | null } | null)?.appointment_ref ?? '').trim();
  }

  // Clinician first name (optional — appointment may have no clinician set).
  let staffFirstName = '';
  if (appt?.staff_account_id) {
    const { data: staffRow } = await admin
      .from('accounts')
      .select('first_name')
      .eq('id', appt.staff_account_id)
      .maybeSingle();
    const staff = staffRow as { first_name: string | null } | null;
    const first = (staff?.first_name ?? '').trim();
    if (first) staffFirstName = properCase(first);
  }

  if (!patient) {
    return jsonResponse(200, { ok: false, error: 'Patient not found.', reason: 'patient_not_found' });
  }
  const rawPhone = (patient.phone ?? '').trim();
  if (!rawPhone) {
    return jsonResponse(200, {
      ok: false,
      error: "Patient has no phone number on file.",
      reason: 'no_phone',
    });
  }
  const toPhone = normalisePhone(rawPhone);

  // ── Load the template via the per-service resolver ──────────────
  // RPC returns the service-typed override if one exists for this
  // booking's service_type, else the General default. Both shapes
  // get the same downstream rendering.
  const { data: tplRpc, error: tplErr } = await admin.rpc('lng_resolve_sms_template', {
    p_key: templateKey,
    p_service_type: appt?.service_type ?? null,
  });
  if (tplErr || !tplRpc || (Array.isArray(tplRpc) && tplRpc.length === 0)) {
    return jsonResponse(200, {
      ok: false,
      error: `SMS template "${templateKey}" not configured. Seed it from Admin → Emails & SMS.`,
      reason: 'template_not_found',
    });
  }
  const tpl = (Array.isArray(tplRpc) ? tplRpc[0] : tplRpc) as { body: string; enabled: boolean };
  if (!tpl.enabled) {
    return jsonResponse(200, {
      ok: false,
      error: 'SMS template is paused. Re-enable it in Admin → Emails & SMS to send.',
      reason: 'template_disabled',
    });
  }

  // ── Resolve placeholders ─────────────────────────────────────────
  const clinicName = (location?.name ?? '').trim() || 'the clinic';
  const clinicPhone = (location?.phone ?? '').trim();
  const clinicAddress = formatClinicAddress(location);
  const apptDate = formatApptDate(appt?.start_at);
  const apptTime = formatApptTime(appt?.start_at);
  const websiteUrl = stripScheme(String(settings['clinic.website_url'] ?? ''));
  const bookingLink = stripScheme(String(settings['clinic.booking_url'] ?? ''));

  const variables: Record<string, string> = {
    patientFirstName: properCase((patient.first_name ?? '').trim()) || 'there',
    clinicName,
    locationName: clinicName, // legacy alias
    clinicPhone,
    clinicAddress,
    websiteUrl,
    bookingLink,
    apptDate,
    apptTime,
    staffFirstName: staffFirstName || 'your clinician',
    appointmentRef: appointmentRef || '—',
    lwoRef: (patient.lwo_ref ?? '').trim() || '—',
    itemLabel: resolveItemLabel(appt),
  };
  const renderedBody = substituteVariables(tpl.body, variables);

  // ── Preview branch ────────────────────────────────────────────
  if (preview) {
    return jsonResponse(200, {
      ok: true,
      preview: true,
      body: renderedBody,
      to: toPhone,
    });
  }

  // ── Twilio send ───────────────────────────────────────────────
  const result = await sendSms({ to: toPhone, body: renderedBody });

  // ── Audit row regardless of outcome ───────────────────────────
  const { data: actorRow } = await admin
    .from('accounts')
    .select('id')
    .eq('auth_user_id', who.user.id)
    .maybeSingle();
  const sentBy = (actorRow as { id: string } | null)?.id ?? null;

  if (result.ok) {
    await admin.from('lng_sms_messages').insert({
      patient_id: visit.patient_id,
      visit_id: visit.id,
      appointment_id: visit.appointment_id,
      location_id: visit.location_id,
      template_key: templateKey,
      to_phone: toPhone,
      body: renderedBody,
      send_status: 'pending',
      twilio_message_sid: result.sid,
      sent_by: sentBy,
    });
    await admin.from('patient_events').insert({
      patient_id: visit.patient_id,
      event_type: 'sms_queued',
      actor_account_id: sentBy,
      payload: {
        template_key: templateKey,
        visit_id: visit.id,
        appointment_id: visit.appointment_id,
        to_phone: toPhone,
        twilio_sid: result.sid,
      },
    });
    return jsonResponse(200, {
      ok: true,
      body: renderedBody,
      to: toPhone,
      twilioSid: result.sid,
    });
  }

  await admin.from('lng_sms_messages').insert({
    patient_id: visit.patient_id,
    visit_id: visit.id,
    appointment_id: visit.appointment_id,
    location_id: visit.location_id,
    template_key: templateKey,
    to_phone: toPhone,
    body: renderedBody,
    send_status: 'failed',
    send_error: `${result.code ?? 'no-code'} ${result.message}`,
    sent_by: sentBy,
  });
  return jsonResponse(200, {
    ok: false,
    error: `Twilio send failed: ${result.code ?? 'no-code'} ${result.message}`,
    reason: 'send_failed',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function resolveItemLabel(
  appt: { service_type: string | null; product_key: string | null; arch: string | null } | null,
): string {
  if (!appt) return 'appliance';
  if (appt.service_type === 'denture_repair') return 'denture repair';
  if (appt.service_type === 'click_in_veneers') return 'click-in veneers';
  const productMap: Record<string, string> = {
    retainer: 'retainer',
    aligner: 'aligner',
    whitening_tray: 'whitening tray',
    whitening_kit: 'whitening kit',
    night_guard: 'night guard',
    day_guard: 'day guard',
    click_in_veneers: 'click-in veneers',
    missing_tooth: 'tooth retainer',
  };
  if (appt.product_key && productMap[appt.product_key]) {
    return productMap[appt.product_key];
  }
  return 'appliance';
}

// Format the appointment start_at into a UK-style short date,
// e.g. "Mon 25 May". Empty string when no start_at is available.
function formatApptDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/London',
  }).format(d);
}

// Format the appointment start_at into a 24h UK time, e.g. "14:30".
// Empty string when no start_at is available.
function formatApptTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/London',
  }).format(d);
}

// Single-line address built from the locations row's parts. Skips
// any empty parts so a clinic with only street + postcode reads
// "123 High Street, ML1 5UH" rather than "123 High Street, , ML1 5UH".
function formatClinicAddress(
  loc: { address: string | null; city: string | null; postcode: string | null } | null,
): string {
  if (!loc) return '';
  const parts = [
    (loc.address ?? '').trim(),
    (loc.city ?? '').trim(),
    (loc.postcode ?? '').trim(),
  ].filter((p) => p.length > 0);
  return parts.join(', ');
}

// Strip "https://" / "http://" so a URL renders compactly inside an
// SMS bubble. Patients tap the bare host and the OS still routes
// to the right scheme.
function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, '').trim();
}

function substituteVariables(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = variables[name];
    return value !== undefined ? value : `{{${name}}}`;
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
