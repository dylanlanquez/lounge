// send-visit-ready-sms
//
// One-shot "your appliance / repair is ready to collect" text fired by
// a receptionist from the Visit page after the patient's been marked
// arrived. Two-step contract with the UI:
//
//   • Preview pass: ?preview=1 (or { preview: true }) — renders the
//     template body with the visit's variables and returns the text
//     without sending anything. Lets the receptionist read the SMS
//     before committing.
//   • Send pass: default — same render + Twilio send + audit row in
//     lng_sms_messages so the timeline can show "SMS sent · last4
//     07…".
//
// Auth: signed-in staff JWT. No service-role bypass — this is always
// invoked from a browser session (the Visit page button).
//
// Body shape:
//   { visit_id: string, preview?: boolean }
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

const TEMPLATE_KEY = 'visit_ready';

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
  let body: { visit_id?: string; preview?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (!body.visit_id) return jsonResponse(200, { ok: false, error: 'visit_id required' });
  const preview = body.preview === true;

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
  //   2. locations — name (for the human "ready to collect at X" line)
  //   3. lng_appointments — service_type + product_key for itemLabel
  const [patientRes, locationRes, apptRes] = await Promise.all([
    admin
      .from('patients')
      .select('first_name, lwo_ref, phone')
      .eq('id', visit.patient_id)
      .maybeSingle(),
    visit.location_id
      ? admin
          .from('locations')
          .select('name')
          .eq('id', visit.location_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    visit.appointment_id
      ? admin
          .from('lng_appointments')
          .select('service_type, product_key, arch, appointment_ref, walk_in_id')
          .eq('id', visit.appointment_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const patient = patientRes.data as
    | { first_name: string | null; lwo_ref: string | null; phone: string | null }
    | null;
  const location = locationRes.data as { name: string | null } | null;
  const appt = apptRes.data as
    | {
        service_type: string | null;
        product_key: string | null;
        arch: string | null;
        appointment_ref: string | null;
        walk_in_id: string | null;
      }
    | null;

  // Walk-in fallback: by design lng_appointments.appointment_ref is
  // NULL on walk-in marker rows (per the
  // 20260518000007_lng_auto_ref_walk_in_discriminator migration —
  // the trigger gates on walk_in_id IS NULL). The LAP for walk-ins
  // lives on lng_walk_ins.appointment_ref instead. Without this
  // fallback every walk-in visit would render "Reference -." in
  // the SMS even though a LAP exists on a sibling row.
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
  // Auto-format whatever's on the patient record into E.164 before
  // it hits Twilio. UK clinics enter phones every which way (07…,
  // 07878 023 449, +44 7878 023449, 00447…), all of which Twilio
  // would reject with 21211. normalisePhone handles the common
  // shapes; the cleaned value flows into both the audit row and
  // the UI preview so what the receptionist sees is what Twilio
  // gets.
  const toPhone = normalisePhone(rawPhone);

  // ── Load the template ─────────────────────────────────────────
  const { data: tplRaw, error: tplErr } = await admin
    .from('lng_sms_templates')
    .select('body, enabled')
    .eq('key', TEMPLATE_KEY)
    .maybeSingle();
  if (tplErr || !tplRaw) {
    return jsonResponse(200, {
      ok: false,
      error: `SMS template "${TEMPLATE_KEY}" not configured. Seed it from Admin → Emails & SMS.`,
      reason: 'template_not_found',
    });
  }
  const tpl = tplRaw as { body: string; enabled: boolean };
  if (!tpl.enabled) {
    return jsonResponse(200, {
      ok: false,
      error: 'SMS template is paused. Re-enable it in Admin → Emails & SMS to send.',
      reason: 'template_disabled',
    });
  }

  // ── Substitute variables ─────────────────────────────────────
  // Proper-case at the boundary so a row stored as "DARREN" or
  // "darren" renders as "Darren" in the patient-facing SMS.
  const variables: Record<string, string> = {
    patientFirstName: properCase((patient.first_name ?? '').trim()) || 'there',
    // appointmentRef is what the patient saw in their original
    // confirmation email ("Booking Reference: LAP-00042"). That's
    // the string they actually remember to quote when they walk
    // into the clinic to collect, so it's the natural primary
    // reference for the ready-to-collect SMS. lwoRef stays
    // available as a separate variable for admins who want the
    // internal lab reference (it's patient-level + immutable per
    // CLAUDE.md), but it's NOT in the default template body because
    // many older patient rows don't have one on file and the
    // resulting "Reference -." looks broken to the patient.
    appointmentRef: appointmentRef || '—',
    lwoRef: (patient.lwo_ref ?? '').trim() || '—',
    locationName: (location?.name ?? '').trim() || 'the clinic',
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
  // Resolve the actor (Lounge account id) so the timeline can read
  // "sent by Sarah Henderson" without joining auth.users.
  const { data: actorRow } = await admin
    .from('accounts')
    .select('id')
    .eq('auth_user_id', who.user.id)
    .maybeSingle();
  const sentBy = (actorRow as { id: string } | null)?.id ?? null;

  if (result.ok) {
    // Initial state is 'pending' — Twilio has ACCEPTED the message
    // for delivery but the carrier hasn't reported back yet. The
    // twilio-sms-status webhook flips this to 'sent' on delivered
    // or 'failed' on undelivered/failed/canceled, usually within a
    // few seconds for UK numbers. Without the in-flight state the
    // UI would tell the receptionist "sent" when really we're still
    // waiting on the carrier — and a 30005 ten seconds later would
    // arrive after the receptionist had walked away.
    await admin.from('lng_sms_messages').insert({
      patient_id: visit.patient_id,
      visit_id: visit.id,
      appointment_id: visit.appointment_id,
      location_id: visit.location_id,
      template_key: TEMPLATE_KEY,
      to_phone: toPhone,
      body: renderedBody,
      send_status: 'pending',
      twilio_message_sid: result.sid,
      sent_by: sentBy,
    });
    // Patient-axis event row mirrors the email-send pattern so the
    // appointment / visit timeline picks it up alongside other
    // touchpoints. 'sms_queued' captures the actual state: we've
    // handed it to Twilio, but the carrier's verdict is still
    // pending. A future migration / patient-event consumer can
    // listen for the webhook's 'delivered'/'failed' events when we
    // wire them; for now the audit row's status is the truth.
    await admin.from('patient_events').insert({
      patient_id: visit.patient_id,
      event_type: 'sms_queued',
      actor_account_id: sentBy,
      payload: {
        template_key: TEMPLATE_KEY,
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
    template_key: TEMPLATE_KEY,
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

/** Format the {{itemLabel}} variable from the visit's appointment row.
 *  Falls back to "appliance" for any service type whose label we
 *  haven't pinned, since "your appliance is ready" reads naturally
 *  for almost everything. */
function resolveItemLabel(
  appt: { service_type: string | null; product_key: string | null; arch: string | null } | null,
): string {
  if (!appt) return 'appliance';
  if (appt.service_type === 'denture_repair') return 'denture repair';
  if (appt.service_type === 'click_in_veneers') return 'click-in veneers';
  // same_day_appliance + impression_appointment + virtual_impression_appointment
  // all map to the product the patient ordered. Product key takes
  // precedence over a bare "appliance".
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
