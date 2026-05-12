// meet-create-space
//
// Creates a Google Meet space for a virtual appointment using the
// chosen host's OAuth token. Called from the manual booking flow
// (createAppointment.ts) after the appointment row is inserted; on
// success we write meet_host_id + meet_space_id + meet_meeting_code
// back onto the appointment AND set join_url so the existing
// virtual-impression UI surfaces the join button without any extra
// rewiring.
//
// Idempotent: if the appointment already has a meet_space_id we
// return the cached identifiers and skip the API call. Re-running
// after a host change requires meet_space_id=null on the row
// (caller's responsibility).
//
// Auth: signed-in staff JWT. Booking-flow callers already have one;
// we re-verify rather than trust the body so a stale public link
// can't be used to spin up Meet rooms.

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
        error: `meet-create-space crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } },
    );
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors() });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Expected failures return 200 with ok:false so callers surface the
  // real reason in the toast (supabase-js wraps non-2xx as a generic
  // "non-2xx status code" string and the precise message is lost).
  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) return json(200, { ok: false, error: 'Not signed in. Sign in and retry.' });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) return json(200, { ok: false, error: 'Not signed in. Sign in and retry.' });

  let body: { appointment_id?: string; host_id?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (!body.appointment_id || !body.host_id) {
    return json(200, { ok: false, error: 'appointment_id and host_id required.' });
  }

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Load the appointment — if it already has a Meet space, return
  //    the cached values. Saves an API call and prevents a flaky
  //    booking-flow retry from creating two rooms.
  const { data: apptRow, error: apptErr } = await admin
    .from('lng_appointments')
    .select('id, meet_space_id, meet_meeting_code, join_url, meet_host_id, location_id, patient_id, start_at, end_at')
    .eq('id', body.appointment_id)
    .maybeSingle();
  if (apptErr || !apptRow) {
    return json(200, { ok: false, error: 'Appointment not found.' });
  }
  const appt = apptRow as {
    id: string;
    meet_space_id: string | null;
    meet_meeting_code: string | null;
    join_url: string | null;
    meet_host_id: string | null;
    location_id: string | null;
    patient_id: string;
    start_at: string;
    end_at: string;
  };
  if (appt.meet_space_id && appt.join_url) {
    return json(200, {
      ok: true,
      cached: true,
      meet_space_id: appt.meet_space_id,
      meet_meeting_code: appt.meet_meeting_code,
      join_url: appt.join_url,
    });
  }

  // 2. Load the host + refresh tokens if needed.
  const { data: hostRow } = await admin
    .from('lng_meet_hosts')
    .select('id, display_name, google_email, access_token, refresh_token, token_expiry, is_active')
    .eq('id', body.host_id)
    .maybeSingle();
  const host = hostRow as MeetHostRow | null;
  if (!host) return json(200, { ok: false, error: 'Host not found.' });
  if (!host.is_active) return json(200, { ok: false, error: 'Host is inactive. Reactivate it in Admin, Services first.' });

  const tokenResult = await getValidAccessToken(admin, host);
  if (!tokenResult.ok) return json(200, { ok: false, error: tokenResult.error });

  // 3. Create the Meet space. attendanceReportGenerationType may
  //    quietly fall back on Workspace tiers that don't support it —
  //    we still proceed because participant sessions are readable
  //    on every tier via the conferenceRecords API.
  const spaceRes = await fetch('https://meet.googleapis.com/v2/spaces', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenResult.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      config: {
        accessType: 'TRUSTED',
        attendanceReportGenerationType: 'GENERATE_REPORT',
      },
    }),
  });
  if (!spaceRes.ok) {
    const errBody = await spaceRes.text().catch(() => '');
    return json(200, {
      ok: false,
      error: `Meet API create failed: ${spaceRes.status} ${errBody.slice(0, 300)}`,
    });
  }
  const space = (await spaceRes.json()) as {
    name?: string;       // spaces/abc123
    meetingUri?: string; // https://meet.google.com/abc-defg-hij
    meetingCode?: string; // abc-defg-hij
  };
  if (!space.name || !space.meetingUri || !space.meetingCode) {
    return json(200, { ok: false, error: 'Meet API returned an incomplete space record' });
  }

  // 4. Persist onto the appointment. Reusing join_url keeps the
  //    existing virtual-impression UI (Schedule cards, AppointmentDetail
  //    Join button, email templates) working without per-call rewiring.
  const { error: updErr } = await admin
    .from('lng_appointments')
    .update({
      meet_host_id: host.id,
      meet_space_id: space.name,
      meet_meeting_code: space.meetingCode,
      join_url: space.meetingUri,
      meeting_platform: 'google_meet',
    })
    .eq('id', appt.id);
  if (updErr) {
    return json(200, { ok: false, error: `Appointment update failed: ${updErr.message}` });
  }

  return json(200, {
    ok: true,
    cached: false,
    meet_space_id: space.name,
    meet_meeting_code: space.meetingCode,
    join_url: space.meetingUri,
  });
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
