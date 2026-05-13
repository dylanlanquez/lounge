// meet-create-space
//
// Creates a Meet space and attaches it to a Calendar event so the
// virtual appointment shows on the host's calendar, the patient gets a
// Calendar invite, AND the host can later read attendance from the
// Meet REST API.
//
// IMPORTANT — order of operations:
//
//   1. POST /v2/spaces (Meet REST API, host's OAuth) — creates the
//      space directly. The host OWNS the space in Meet's books, which
//      is what lets meet-fetch-attendance later read its
//      conferenceRecords. Earlier versions of this function used
//      Calendar's conferenceData.createRequest to provision the Meet
//      room as a side-effect of the Calendar event, but the spaces
//      that path produces are tagged as Calendar-owned, NOT
//      meetings.space.created-owned, and the Meet REST API returns 0
//      conferenceRecords for them under the host's grant. We
//      diagnosed this with tokeninfo + an unfiltered list: the host
//      could see Meet-API-created spaces but NOT Calendar-created
//      ones. The fix is to create the space first, via Meet, then
//      attach.
//
//   2. POST /calendar/v3/events with conferenceData populated to
//      reference the Meet space we just created (entryPoints +
//      conferenceSolutionKey, no createRequest). Calendar links the
//      event to the existing space rather than minting a new one.
//      The patient gets the invite from Google as before.
//
// End-to-end this still produces:
//
//   • A Calendar event on the host's primary calendar.
//   • A Meet room (owned by the host in Meet's books — the critical
//     difference from before) with the join URL on join_url.
//   • A Calendar invite emailed to the patient.
//   • A queryable Meet space resource for attendance.
//
// Idempotent: if google_calendar_event_id + join_url are already
// populated we return the cached identifiers and skip every API call.
// Recovering from a partial state (e.g. space created but Calendar
// failed) requires nulling both columns on the appointment row.
//
// Auth: signed-in staff JWT.

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

  // 1. Hydrate the appointment + patient. We need patient email for
  //    the Calendar invite, and the event label for a host-readable
  //    summary on their calendar.
  const { data: apptRow, error: apptErr } = await admin
    .from('lng_appointments')
    .select(
      'id, meet_space_id, meet_meeting_code, join_url, meet_host_id, google_calendar_event_id, location_id, patient_id, start_at, end_at, event_type_label, service_type',
    )
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
    google_calendar_event_id: string | null;
    location_id: string | null;
    patient_id: string;
    start_at: string;
    end_at: string;
    event_type_label: string | null;
    service_type: string | null;
  };
  // Idempotency: if we already created a Calendar event + Meet for
  // this appointment, return the cached identifiers and skip. We key
  // off google_calendar_event_id (the most authoritative "we did create
  // an event" signal) + join_url. meet_space_id is intentionally not
  // part of this gate because it can legitimately be NULL when an
  // earlier spaces.get lookup failed — that's not a reason to redo
  // the Calendar event.
  if (appt.google_calendar_event_id && appt.join_url) {
    return json(200, {
      ok: true,
      cached: true,
      meet_space_id: appt.meet_space_id,
      meet_meeting_code: appt.meet_meeting_code,
      join_url: appt.join_url,
    });
  }

  const { data: patientRow } = await admin
    .from('patients')
    .select('first_name, last_name, email')
    .eq('id', appt.patient_id)
    .maybeSingle();
  const patient = patientRow as {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  } | null;

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
  const accessToken = tokenResult.accessToken;

  // 3. Create the Calendar event with Meet conferencing on the host's
  //    primary calendar. conferenceDataVersion=1 + createRequest tells
  //    Calendar to provision a new Meet room as part of the event.
  //    sendUpdates=all triggers Google's automatic invite to the
  //    attendees — that's the email that legacy bookings get from
  //    Google, separately from our Lounge-branded confirmation that
  //    send-appointment-confirmation later sends.
  const patientName = [patient?.first_name, patient?.last_name].filter(Boolean).join(' ').trim();
  const summary = patientName
    ? `${appt.event_type_label ?? 'Virtual appointment'} with ${patientName}`
    : appt.event_type_label ?? 'Virtual appointment';
  const description = [
    appt.event_type_label ? `Service: ${appt.event_type_label}` : null,
    patientName ? `Patient: ${patientName}` : null,
    patient?.email ? `Patient email: ${patient.email}` : null,
    '',
    'This event was created by Venneir Lounge. Reply to lounge@venneir.com for any changes.',
  ]
    .filter((line) => line !== null)
    .join('\n');

  // 3. Create the Meet space FIRST via the Meet REST API. Doing it
  //    this way (instead of using Calendar's conferenceData.createRequest)
  //    is what makes the host the owner of the space in Meet's books.
  //    Without that ownership, meetings.space.created scoped reads of
  //    conferenceRecords for this space return empty — even after the
  //    meeting actually happened.
  //
  //    An empty `{}` body asks for default access (OPEN entry, no
  //    waiting room, anyone with the link can join), matching the
  //    behaviour of a Calendar-created Meet room.
  const spaceRes = await fetch('https://meet.googleapis.com/v2/spaces', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!spaceRes.ok) {
    const errBody = await spaceRes.text().catch(() => '');
    await admin.from('lng_system_failures').insert({
      source: 'meet-create-space',
      severity: 'error',
      message: `Meet spaces.create failed: ${spaceRes.status}`,
      context: {
        appointment_id: appt.id,
        host_email: host.google_email,
        response_status: spaceRes.status,
        response_body_preview: errBody.slice(0, 500),
      },
    });
    return json(200, {
      ok: false,
      error: `Meet space create failed: ${spaceRes.status} ${errBody.slice(0, 300)}`,
    });
  }
  const meetSpace = (await spaceRes.json()) as {
    name?: string;
    meetingUri?: string;
    meetingCode?: string;
  };
  if (!meetSpace.name || !meetSpace.meetingUri || !meetSpace.meetingCode) {
    await admin.from('lng_system_failures').insert({
      source: 'meet-create-space',
      severity: 'error',
      message: 'Meet spaces.create returned an incomplete payload',
      context: {
        appointment_id: appt.id,
        host_email: host.google_email,
        space_payload: meetSpace,
      },
    });
    return json(200, {
      ok: false,
      error: 'Meet space created but key fields are missing. Check the host\'s Workspace plan includes Meet API access.',
    });
  }
  const meetSpaceName = meetSpace.name;
  const meetingCode = meetSpace.meetingCode;
  const joinUrl = meetSpace.meetingUri;

  // 4. Create the Calendar event with the existing Meet space attached.
  //    conferenceData.conferenceSolution + entryPoints (no createRequest)
  //    tells Calendar to use the supplied Meet, rather than minting a
  //    new one. The patient still gets the standard Google invite via
  //    sendUpdates=all; the host's calendar still shows the appointment.
  const calendarBody: Record<string, unknown> = {
    summary,
    description,
    start: { dateTime: appt.start_at, timeZone: 'Europe/London' },
    end: { dateTime: appt.end_at, timeZone: 'Europe/London' },
    conferenceData: {
      conferenceSolution: {
        key: { type: 'hangoutsMeet' },
        name: 'Google Meet',
      },
      conferenceId: meetingCode,
      entryPoints: [
        {
          entryPointType: 'video',
          uri: joinUrl,
          label: meetingCode,
        },
      ],
    },
    guestsCanModify: false,
    guestsCanInviteOthers: false,
  };
  if (patient?.email) {
    calendarBody.attendees = [{ email: patient.email, responseStatus: 'needsAction' }];
  }

  const calRes = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(calendarBody),
    },
  );
  if (!calRes.ok) {
    const errBody = await calRes.text().catch(() => '');
    // The Meet space exists at this point but Calendar didn't accept
    // the attach. Log loud, then bail. The host can still send the
    // join URL manually if absolutely needed, but typically this
    // signals a Calendar API quota / scope issue.
    await admin.from('lng_system_failures').insert({
      source: 'meet-create-space',
      severity: 'error',
      message: `Calendar event create failed: ${calRes.status}`,
      context: {
        appointment_id: appt.id,
        meeting_code: meetingCode,
        meet_space_name: meetSpaceName,
        host_email: host.google_email,
        response_status: calRes.status,
        response_body_preview: errBody.slice(0, 500),
      },
    });
    return json(200, {
      ok: false,
      error: `Calendar event create failed: ${calRes.status} ${errBody.slice(0, 300)}`,
    });
  }
  const calEvent = (await calRes.json()) as { id?: string };
  if (!calEvent.id) {
    return json(200, { ok: false, error: 'Calendar API returned no event id.' });
  }

  // 5. Persist onto the appointment. meet_space_id is the canonical
  //    server-generated opaque resource name (`spaces/<opaque-id>`);
  //    meet_meeting_code is the human-readable join code. Both come
  //    straight from the Meet REST API so they're authoritative — no
  //    fallback constructions, no fabricated values.
  const { error: updErr } = await admin
    .from('lng_appointments')
    .update({
      meet_host_id: host.id,
      meet_space_id: meetSpaceName,
      meet_meeting_code: meetingCode,
      google_calendar_event_id: calEvent.id,
      join_url: joinUrl,
      meeting_platform: 'google_meet',
    })
    .eq('id', appt.id);
  if (updErr) {
    return json(200, { ok: false, error: `Appointment update failed: ${updErr.message}` });
  }

  return json(200, {
    ok: true,
    cached: false,
    meet_space_id: meetSpaceName,
    meet_meeting_code: meetingCode,
    join_url: joinUrl,
    google_calendar_event_id: calEvent.id,
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
