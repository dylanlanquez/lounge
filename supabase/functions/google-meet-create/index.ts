// google-meet-create
//
// Creates a Google Calendar event with Google Meet conferencing for a
// virtual_impression_appointment and writes join_url +
// google_calendar_event_id back onto the lng_appointments row.
//
// Called from the staff-side client (createAppointment.ts,
// rescheduleAppointment.ts) via supabase.functions.invoke. Widget-side
// edge functions (widget-create-appointment, widget-reschedule-booking)
// call the Calendar API inline using _shared/googleCalendar.ts directly
// to avoid an extra round-trip.
//
// Idempotent: if the row already has a google_calendar_event_id the
// existing join_url is returned and no new event is created.
//
// Auth: any valid Supabase JWT (anon or authenticated user).
//       Writes back to the DB using SUPABASE_SERVICE_ROLE_KEY so RLS
//       is bypassed for the patch — the caller already owns the row.
//
// Required Supabase secrets:
//   GOOGLE_CALENDAR_SA_EMAIL
//   GOOGLE_CALENDAR_SA_PRIVATE_KEY
//   GOOGLE_CALENDAR_ID

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import {
  createMeetEvent,
  getGoogleAccessToken,
} from '../_shared/googleCalendar.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GOOGLE_CALENDAR_SA_EMAIL = Deno.env.get('GOOGLE_CALENDAR_SA_EMAIL') ?? '';
const GOOGLE_CALENDAR_SA_PRIVATE_KEY = Deno.env.get('GOOGLE_CALENDAR_SA_PRIVATE_KEY') ?? '';
const GOOGLE_CALENDAR_ID = Deno.env.get('GOOGLE_CALENDAR_ID') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return j(405, { error: 'method_not_allowed' });

  if (!GOOGLE_CALENDAR_SA_EMAIL || !GOOGLE_CALENDAR_SA_PRIVATE_KEY || !GOOGLE_CALENDAR_ID) {
    await logFailure('google_calendar_secrets_missing', {});
    return j(500, { error: 'google_calendar_not_configured' });
  }

  let body: { appointmentId?: unknown };
  try {
    body = await req.json();
  } catch {
    return j(400, { error: 'bad_json' });
  }
  const appointmentId = typeof body.appointmentId === 'string' ? body.appointmentId.trim() : '';
  if (!appointmentId) return j(400, { error: 'appointmentId_missing' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: rowRaw, error: readErr } = await supabase
    .from('lng_appointments')
    .select('id, service_type, start_at, end_at, event_type_label, join_url, google_calendar_event_id')
    .eq('id', appointmentId)
    .maybeSingle();
  if (readErr) {
    await logFailure('appointment_read_failed', { appointmentId, error: readErr.message });
    return j(500, { error: 'read_failed' });
  }
  if (!rowRaw) return j(404, { error: 'appointment_not_found' });

  const row = rowRaw as {
    id: string;
    service_type: string | null;
    start_at: string;
    end_at: string;
    event_type_label: string | null;
    join_url: string | null;
    google_calendar_event_id: string | null;
  };

  if (row.service_type !== 'virtual_impression_appointment') {
    return j(200, { ok: true, skipped: true });
  }

  // Idempotent: already has a Meet link — return it without creating another event.
  if (row.google_calendar_event_id && row.join_url) {
    return j(200, { ok: true, joinUrl: row.join_url, alreadyExists: true });
  }

  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken(
      GOOGLE_CALENDAR_SA_EMAIL,
      GOOGLE_CALENDAR_SA_PRIVATE_KEY,
    );
  } catch (e) {
    await logFailure('google_auth_failed', {
      appointmentId,
      error: e instanceof Error ? e.message : String(e),
    });
    return j(500, { error: 'google_auth_failed' });
  }

  let hangoutLink: string;
  let eventId: string;
  try {
    ({ hangoutLink, eventId } = await createMeetEvent({
      accessToken,
      calendarId: GOOGLE_CALENDAR_ID,
      appointmentId: row.id,
      startAt: row.start_at,
      endAt: row.end_at,
      summary: row.event_type_label ?? 'Virtual impression appointment',
    }));
  } catch (e) {
    await logFailure('calendar_event_create_failed', {
      appointmentId,
      error: e instanceof Error ? e.message : String(e),
    });
    return j(500, { error: 'calendar_event_failed' });
  }

  const { error: patchErr } = await supabase
    .from('lng_appointments')
    .update({ join_url: hangoutLink, google_calendar_event_id: eventId })
    .eq('id', appointmentId);
  if (patchErr) {
    // The calendar event exists but the row wasn't patched — log prominently
    // so it can be reconciled manually. Don't block the caller.
    await logFailure('appointment_patch_failed', {
      appointmentId,
      eventId,
      hangoutLink,
      error: patchErr.message,
    }, 'critical');
    return j(500, { error: 'patch_failed' });
  }

  return j(200, { ok: true, joinUrl: hangoutLink });
});

function j(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function logFailure(
  message: string,
  context: Record<string, unknown>,
  severity: 'warning' | 'error' | 'critical' = 'error',
): Promise<void> {
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await sb.from('lng_system_failures').insert({
      source: 'google-meet-create',
      severity,
      message,
      context,
    });
  } catch (e) {
    console.error('[google-meet-create] failure log insert failed:', e);
  }
}
