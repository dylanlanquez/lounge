// send-appointment-sms-reminders
//
// Twin of send-appointment-reminders, but text-message channel.
// Cron-driven sweep that fires the 24-hours-before SMS reminder
// for native (non-Calendly) Lounge bookings. Idempotent per
// appointment via lng_appointments.sms_reminder_sent_at — separate
// stamp from the email path so the two channels stamp + retry
// independently (email send succeeds, SMS API errors → next sweep
// retries SMS without re-emailing).
//
// Auth: shared CRON_SECRET header OR service-role bearer (same
// shape as the email reminder). User JWTs are NOT accepted — this
// touches every clinic's bookings.
//
// Sweep window: 23-25h before start_at, env-tunable. Misses are
// caught by the next hour's run since sms_reminder_sent_at stays
// NULL.
//
// Sender: routed through TWILIO_MESSAGING_SERVICE_SID so the
// Messaging Service picks alphanumeric (VENNEIR) or long code per
// destination. No `From` configured here.
//
// Per-row body: hardcoded inline template for v1. Switch to a
// row in lng_sms_templates when we have more than one shape; that
// migration is a follow-up, not blocking this slice.
//
// Logs:
//   • patient_events  — one row per send (timeline visibility)
//   • lng_event_log   — sweep summary (ops dashboard)
//   • lng_system_failures — anything that fell over

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { sendSms, toE164 } from '../_shared/twilioSms.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('LNG_REMINDERS_CRON_SECRET') ?? '';

const REMINDER_WINDOW_START_HOURS = Number(
  Deno.env.get('LNG_REMINDERS_WINDOW_START_HOURS') ?? '23',
);
const REMINDER_WINDOW_END_HOURS = Number(
  Deno.env.get('LNG_REMINDERS_WINDOW_END_HOURS') ?? '25',
);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-cron-secret',
};

interface AppointmentRow {
  id: string;
  patient_id: string;
  location_id: string;
  start_at: string;
  source: string;
  status: string;
  event_type_label: string | null;
}

interface PatientRow {
  first_name: string | null;
  phone: string | null;
  phone_country: string | null;
}

interface LocationRow {
  name: string | null;
  city: string | null;
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return jsonResponse(200, {
      ok: false,
      error: `send-appointment-sms-reminders crashed: ${
        e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      }`,
    });
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Auth — service-role bearer OR cron secret header. Identical
  // pattern to send-appointment-reminders; see that file for the
  // commentary on why we decode + verify the bearer payload rather
  // than string-compare against SERVICE_ROLE_KEY.
  const auth = req.headers.get('authorization') ?? '';
  const secret = req.headers.get('x-cron-secret') ?? '';
  let bearerOk = false;
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    const payload = decodeJwtPayload(token);
    if (payload?.role === 'service_role' && (!payload.ref || isExpectedProjectRef(payload.ref))) {
      bearerOk = true;
    }
  }
  const secretOk = !!CRON_SECRET && secret === CRON_SECRET;
  if (!bearerOk && !secretOk) {
    return jsonResponse(401, { ok: false, error: 'Unauthorised' });
  }

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Optional single-shot path. Body { appointmentId } skips the
  // window filter so the Timeline's "Resend SMS" button (future)
  // can fire one reminder on demand.
  let body: { appointmentId?: string } = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    body = {};
  }
  const singleId = typeof body.appointmentId === 'string' ? body.appointmentId : null;

  let rows: AppointmentRow[];
  let sweepWindow: { start: string; end: string } | null = null;

  if (singleId) {
    const { data: oneRaw, error: oneErr } = await admin
      .from('lng_appointments')
      .select('id, patient_id, location_id, start_at, source, status, event_type_label')
      .eq('id', singleId)
      .maybeSingle();
    if (oneErr) return jsonResponse(200, { ok: false, error: `Lookup failed: ${oneErr.message}` });
    if (!oneRaw) return jsonResponse(404, { ok: false, error: 'Appointment not found' });
    rows = [oneRaw as AppointmentRow];
    // Clear the stamp so the resend isn't blocked by previous run
    await admin
      .from('lng_appointments')
      .update({ sms_reminder_sent_at: null })
      .eq('id', singleId);
  } else {
    const now = new Date();
    const windowStart = new Date(now.getTime() + REMINDER_WINDOW_START_HOURS * 3600 * 1000);
    const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_END_HOURS * 3600 * 1000);
    sweepWindow = { start: windowStart.toISOString(), end: windowEnd.toISOString() };

    const { data: rowsRaw, error: sweepErr } = await admin
      .from('lng_appointments')
      .select('id, patient_id, location_id, start_at, source, status, event_type_label')
      .eq('status', 'booked')
      .neq('source', 'calendly')
      .is('sms_reminder_sent_at', null)
      .gte('start_at', windowStart.toISOString())
      .lt('start_at', windowEnd.toISOString());
    if (sweepErr) return jsonResponse(200, { ok: false, error: `Sweep failed: ${sweepErr.message}` });
    rows = (rowsRaw ?? []) as AppointmentRow[];
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const errors: Array<{ appointmentId: string; reason: string }> = [];

  for (const apt of rows) {
    try {
      const result = await processOne(admin, apt);
      if (result.outcome === 'sent') sent += 1;
      else if (result.outcome === 'skipped') skipped += 1;
      else {
        failed += 1;
        errors.push({ appointmentId: apt.id, reason: result.reason ?? 'unknown' });
      }
    } catch (e) {
      failed += 1;
      const reason = e instanceof Error ? e.message : String(e);
      errors.push({ appointmentId: apt.id, reason });
      await logFailure(admin, {
        message: `Unhandled exception in SMS reminder send: ${reason}`,
        context: { appointmentId: apt.id },
      });
    }
  }

  if (sweepWindow) {
    await admin.from('lng_event_log').insert({
      source: 'send-appointment-sms-reminders',
      event_type: 'sweep_complete',
      payload: {
        window_start: sweepWindow.start,
        window_end: sweepWindow.end,
        eligible: rows.length,
        sent,
        skipped,
        failed,
        errors: errors.slice(0, 10),
      },
    });
  }

  return jsonResponse(200, { ok: true, eligible: rows.length, sent, skipped, failed });
}

interface ProcessResult {
  outcome: 'sent' | 'skipped' | 'failed';
  reason?: string;
}

async function processOne(admin: SupabaseClient, apt: AppointmentRow): Promise<ProcessResult> {
  const [{ data: patientRaw }, { data: locationRaw }] = await Promise.all([
    admin
      .from('patients')
      .select('first_name, phone, phone_country')
      .eq('id', apt.patient_id)
      .maybeSingle(),
    admin
      .from('locations')
      .select('name, city')
      .eq('id', apt.location_id)
      .maybeSingle(),
  ]);
  const patient = patientRaw as PatientRow | null;
  const location = locationRaw as LocationRow | null;

  if (!patient?.phone) {
    // No phone — stamp anyway so the sweep doesn't keep retrying.
    // Skip is visible on the timeline.
    await admin
      .from('lng_appointments')
      .update({ sms_reminder_sent_at: new Date().toISOString() })
      .eq('id', apt.id);
    await admin.from('patient_events').insert({
      patient_id: apt.patient_id,
      event_type: 'appointment_sms_reminder_skipped',
      payload: { appointment_id: apt.id, reason: 'no_phone_on_patient' },
    });
    return { outcome: 'skipped', reason: 'no_phone_on_patient' };
  }

  const e164 = toE164(patient.phone_country, patient.phone);
  if (!e164) {
    await admin.from('patient_events').insert({
      patient_id: apt.patient_id,
      event_type: 'appointment_sms_reminder_skipped',
      payload: { appointment_id: apt.id, reason: 'phone_unparseable', raw: patient.phone },
    });
    return { outcome: 'skipped', reason: 'phone_unparseable' };
  }

  const body = composeBody(apt, patient, location);
  const result = await sendSms({ to: e164, body });
  if (!result.ok) {
    await logFailure(admin, {
      message: `Twilio send failed: ${result.code ?? 'no-code'} ${result.message}`,
      context: { appointmentId: apt.id, to: e164, twilioStatus: result.status },
    });
    return { outcome: 'failed', reason: result.message };
  }

  await admin
    .from('lng_appointments')
    .update({ sms_reminder_sent_at: new Date().toISOString() })
    .eq('id', apt.id);
  await admin.from('patient_events').insert({
    patient_id: apt.patient_id,
    event_type: 'appointment_sms_reminder_sent',
    payload: {
      appointment_id: apt.id,
      twilio_sid: result.sid,
      twilio_status: result.status,
      to: e164,
    },
  });
  return { outcome: 'sent' };
}

// Inline SMS template. Single segment when possible — Smart
// Encoding on the Messaging Service strips Unicode for us, so we
// avoid em-dashes etc. that would otherwise tip the message over
// 160 chars (each extra segment is billed separately). Tweak this
// copy when product wants different phrasing; one-off changes
// here are cheaper than a template table for a single message
// shape.
function composeBody(
  apt: AppointmentRow,
  patient: PatientRow | null,
  location: LocationRow | null,
): string {
  const name = (patient?.first_name ?? '').trim();
  const greeting = name ? `Hi ${name}, ` : 'Hi, ';
  const when = formatWhen(apt.start_at);
  const where = location?.city ?? location?.name ?? 'the clinic';
  return `${greeting}quick reminder of your appointment at Venneir Lounge ${where} ${when}. See you then. Reply if you need to change.`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'soon';
  const day = d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/London',
  });
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/London',
  });
  return `on ${day} at ${time}`;
}

// ── Helpers ──────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function decodeJwtPayload(token: string): { role?: string; ref?: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const pad = payload.length % 4 === 0 ? '' : '='.repeat(4 - (payload.length % 4));
    const json = atob(payload + pad);
    return JSON.parse(json) as { role?: string; ref?: string };
  } catch {
    return null;
  }
}

function isExpectedProjectRef(ref: string): boolean {
  const url = SUPABASE_URL ?? '';
  const m = url.match(/^https?:\/\/([^.]+)\./);
  return !!m && m[1] === ref;
}

async function logFailure(
  admin: SupabaseClient,
  payload: { message: string; context: Record<string, unknown> },
): Promise<void> {
  try {
    await admin.from('lng_system_failures').insert({
      source: 'send-appointment-sms-reminders',
      severity: 'error',
      message: payload.message,
      context: payload.context,
    });
  } catch {
    // Swallow — failing to log is not worth crashing the sweep.
  }
}
