// widget-cancel-booking
//
// Customer self-serve booking cancellation. The patient hits this
// from the manage page (/widget/manage?token=<uuid>); we verify
// the manage token, mark the appointment cancelled, and trigger
// the cancellation email so their calendar invite gets a CANCEL
// .ics and they have a paper trail.
//
// Auth model: anon-callable. The manage_token IS the auth — it's
// 122 bits of unguessable randomness handed only to the patient
// via their booking confirmation email. No way to enumerate;
// brute-forcing is infeasible.
//
// Refund handling: not in scope for v1. The deposit_status stays
// 'paid' and staff issues refunds via the Stripe dashboard per
// clinic policy (some clinics keep the deposit on cancel within X
// hours, etc). The cancellation email body is the right place to
// communicate the refund policy — admin edits the
// booking_cancellation template.
//
// Idempotency: re-submitting the same token after a successful
// cancel is a no-op (returns ok:true, already_cancelled:true).
// The manage page state shifts to "Cancelled" on the next reload
// so the user can't double-tap.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import {
  deleteMeetEvent,
  getGoogleAccessToken,
} from '../_shared/googleCalendar.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GOOGLE_CALENDAR_SA_EMAIL = Deno.env.get('GOOGLE_CALENDAR_SA_EMAIL') ?? '';
const GOOGLE_CALENDAR_SA_PRIVATE_KEY = Deno.env.get('GOOGLE_CALENDAR_SA_PRIVATE_KEY') ?? '';
const GOOGLE_CALENDAR_ID = Deno.env.get('GOOGLE_CALENDAR_ID') ?? '';;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

interface Body {
  token?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch (e) {
    return jsonResponse(400, { error: 'bad_json', detail: String(e) });
  }
  const token = (body.token ?? '').trim();
  if (!UUID_RE.test(token)) {
    return jsonResponse(400, { error: 'invalid_token' });
  }

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Look up appointment by token. Use service-role client so we
  // pick up RLS-hidden columns (status, patient_id, start_at) that
  // anon couldn't read — but only AFTER verifying the unguessable
  // token. The token IS the auth.
  const { data: row, error: lookupErr } = await supabase
    .from('lng_appointments')
    .select('id, status, start_at, patient_id, location_id, appointment_ref, google_calendar_event_id')
    .eq('manage_token', token)
    .maybeSingle();
  if (lookupErr) {
    await logFailure('lookup_failed', { error: lookupErr.message });
    return jsonResponse(500, { error: 'lookup_failed' });
  }
  if (!row) {
    return jsonResponse(404, { error: 'token_not_found' });
  }
  const appointment = row as {
    id: string;
    status: string;
    start_at: string;
    patient_id: string;
    location_id: string;
    appointment_ref: string | null;
    google_calendar_event_id: string | null;
  };

  // Idempotent on already-cancelled bookings — a refresh-mid-cancel
  // double-submit returns ok cleanly.
  if (appointment.status === 'cancelled') {
    return jsonResponse(200, {
      ok: true,
      already_cancelled: true,
      appointmentId: appointment.id,
    });
  }
  // Block cancel on terminal statuses. The manage page wouldn't
  // surface the button in these cases either, but defend in depth.
  if (
    appointment.status !== 'booked' &&
    appointment.status !== 'arrived' &&
    appointment.status !== 'in_progress'
  ) {
    return jsonResponse(409, { error: 'not_cancellable', status: appointment.status });
  }
  // No cancelling a past appointment from the widget — the
  // arrival flow already moved the row through the lifecycle.
  if (new Date(appointment.start_at).getTime() < Date.now()) {
    return jsonResponse(409, { error: 'too_late_to_cancel' });
  }

  const { error: updateErr } = await supabase
    .from('lng_appointments')
    .update({
      status: 'cancelled',
      cancel_reason: 'patient_self_serve',
    })
    .eq('id', appointment.id);
  if (updateErr) {
    await logFailure('update_failed', { error: updateErr.message, appointmentId: appointment.id });
    return jsonResponse(500, { error: 'update_failed' });
  }

  // Google Meet cleanup — best-effort, no-op if no event_id on row.
  if (
    appointment.google_calendar_event_id &&
    GOOGLE_CALENDAR_SA_EMAIL &&
    GOOGLE_CALENDAR_SA_PRIVATE_KEY &&
    GOOGLE_CALENDAR_ID
  ) {
    try {
      const token = await getGoogleAccessToken(
        GOOGLE_CALENDAR_SA_EMAIL,
        GOOGLE_CALENDAR_SA_PRIVATE_KEY,
      );
      await deleteMeetEvent({
        accessToken: token,
        calendarId: GOOGLE_CALENDAR_ID,
        eventId: appointment.google_calendar_event_id,
      });
    } catch (e) {
      await logFailure('google_meet_delete_failed', {
        appointmentId: appointment.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Patient timeline event so the staff app's audit trail shows
  // the cancellation came from the widget side.
  await supabase.from('patient_events').insert({
    patient_id: appointment.patient_id,
    event_type: 'appointment_cancelled',
    payload: {
      appointment_id: appointment.id,
      appointment_ref: appointment.appointment_ref,
      source: 'widget_self_serve',
    },
  });

  // Fire-and-forget cancellation email. Recognises the service-
  // role Bearer and skips the user-auth check the staff app
  // normally requires (per the bypass added in the widget
  // confirmation-email work).
  try {
    const { error: emailErr } = await supabase.functions.invoke(
      'send-appointment-confirmation',
      { body: { appointmentId: appointment.id, intent: 'cancellation' } },
    );
    if (emailErr) {
      await logFailure('cancellation_email_invoke_failed', {
        appointmentId: appointment.id,
        error: emailErr.message,
      }, 'warning');
    }
  } catch (e) {
    await logFailure('cancellation_email_threw', {
      appointmentId: appointment.id,
      error: e instanceof Error ? e.message : String(e),
    }, 'warning');
  }

  return jsonResponse(200, {
    ok: true,
    appointmentId: appointment.id,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function logFailure(
  message: string,
  context: Record<string, unknown>,
  severity: 'info' | 'warning' | 'error' | 'critical' = 'error',
) {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from('lng_system_failures').insert({
      source: 'widget-cancel-booking',
      severity,
      message,
      context,
    });
  } catch {
    // best-effort
  }
}
