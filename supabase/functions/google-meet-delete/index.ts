// google-meet-delete
//
// Deletes the Google Calendar event backing a virtual_impression_appointment
// and clears join_url + google_calendar_event_id from the lng_appointments row.
//
// Called from:
//   - cancelAppointment.ts (staff cancel)
//   - rescheduleAppointment.ts (staff reschedule — clears the old row's event
//     after the new row's google-meet-create has run)
//
// Widget-side edge functions call the Calendar API inline using
// _shared/googleCalendar.ts directly.
//
// Safe to call on non-virtual appointments — if the row has no
// google_calendar_event_id the function is a no-op.
//
// Auth: any valid Supabase JWT.
//
// Required Supabase secrets:
//   GOOGLE_CALENDAR_SA_EMAIL
//   GOOGLE_CALENDAR_SA_PRIVATE_KEY
//   GOOGLE_CALENDAR_ID

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import {
  deleteMeetEvent,
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
    .select('id, google_calendar_event_id')
    .eq('id', appointmentId)
    .maybeSingle();
  if (readErr) {
    await logFailure('appointment_read_failed', { appointmentId, error: readErr.message });
    return j(500, { error: 'read_failed' });
  }
  if (!rowRaw) return j(404, { error: 'appointment_not_found' });

  const row = rowRaw as { id: string; google_calendar_event_id: string | null };

  // No calendar event on this row — nothing to delete.
  if (!row.google_calendar_event_id) {
    return j(200, { ok: true, skipped: true });
  }

  if (!GOOGLE_CALENDAR_SA_EMAIL || !GOOGLE_CALENDAR_SA_PRIVATE_KEY || !GOOGLE_CALENDAR_ID) {
    await logFailure('google_calendar_secrets_missing', { appointmentId });
    return j(500, { error: 'google_calendar_not_configured' });
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

  try {
    await deleteMeetEvent({
      accessToken,
      calendarId: GOOGLE_CALENDAR_ID,
      eventId: row.google_calendar_event_id,
    });
  } catch (e) {
    await logFailure('calendar_event_delete_failed', {
      appointmentId,
      eventId: row.google_calendar_event_id,
      error: e instanceof Error ? e.message : String(e),
    });
    return j(500, { error: 'calendar_event_delete_failed' });
  }

  // Clear the fields from the appointment row.
  const { error: patchErr } = await supabase
    .from('lng_appointments')
    .update({ join_url: null, google_calendar_event_id: null })
    .eq('id', appointmentId);
  if (patchErr) {
    await logFailure('appointment_patch_failed', {
      appointmentId,
      error: patchErr.message,
    }, 'warning');
    // Event is deleted from Google's side; the DB fields are stale but
    // harmless. Log and return success so the caller's flow isn't blocked.
  }

  return j(200, { ok: true });
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
      source: 'google-meet-delete',
      severity,
      message,
      context,
    });
  } catch (e) {
    console.error('[google-meet-delete] failure log insert failed:', e);
  }
}
