// meet-delete-event
//
// Deletes the Google Calendar event that meet-create-space attached to
// an appointment, using the original host's OAuth grant. Google
// removes the event from the host's calendar AND emails the patient a
// Calendar cancellation, mirroring how the legacy service-account
// google-meet-delete worked for the shared calendar.
//
// Called from cancelAppointment.ts (when status flips to cancelled)
// and rescheduleAppointment.ts (for the old row whose Meet space has
// been superseded by the new row).
//
// Idempotent: if the appointment has no google_calendar_event_id (the
// new flow never wrote one, or a previous delete already cleared it),
// returns ok with skipped=true.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { getValidAccessToken, type MeetHostRow } from '../_shared/meetHostToken.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `meet-delete-event crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } },
    );
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors() });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) return json(200, { ok: false, error: 'Not signed in.' });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) return json(200, { ok: false, error: 'Not signed in.' });

  let body: { appointment_id?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (!body.appointment_id) return json(200, { ok: false, error: 'appointment_id required.' });

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: apptRow, error: apptErr } = await admin
    .from('lng_appointments')
    .select('id, meet_host_id, google_calendar_event_id')
    .eq('id', body.appointment_id)
    .maybeSingle();
  if (apptErr || !apptRow) {
    return json(200, { ok: false, error: 'Appointment not found.' });
  }
  const appt = apptRow as {
    id: string;
    meet_host_id: string | null;
    google_calendar_event_id: string | null;
  };
  if (!appt.meet_host_id || !appt.google_calendar_event_id) {
    return json(200, { ok: true, skipped: true });
  }

  const { data: hostRow } = await admin
    .from('lng_meet_hosts')
    .select('id, display_name, google_email, access_token, refresh_token, token_expiry, is_active')
    .eq('id', appt.meet_host_id)
    .maybeSingle();
  const host = hostRow as MeetHostRow | null;
  if (!host) return json(200, { ok: false, error: 'Host not found.' });

  const tokenResult = await getValidAccessToken(admin, host);
  if (!tokenResult.ok) return json(200, { ok: false, error: tokenResult.error });

  // sendUpdates=all triggers Google to email the patient a Calendar
  // cancellation. Mirrors the legacy service-account delete which
  // also fired the patient invite cancellation.
  const calRes = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(appt.google_calendar_event_id)}?sendUpdates=all`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenResult.accessToken}` },
    },
  );
  // 404 / 410 mean the event was already gone — both acceptable.
  if (!calRes.ok && calRes.status !== 404 && calRes.status !== 410) {
    const errBody = await calRes.text().catch(() => '');
    return json(200, {
      ok: false,
      error: `Calendar event delete failed: ${calRes.status} ${errBody.slice(0, 300)}`,
    });
  }

  // Null the columns so future reads don't keep pointing at a deleted
  // event. join_url stays as audit (it's the link that DID go out at
  // booking time; the email/Calendar invite already references it).
  await admin
    .from('lng_appointments')
    .update({ google_calendar_event_id: null })
    .eq('id', appt.id);

  return json(200, { ok: true, skipped: false });
}

function cors(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(), 'Content-Type': 'application/json' },
  });
}
