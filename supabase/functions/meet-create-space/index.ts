// meet-create-space
//
// Creates a Google Calendar event with Meet conferencing for a virtual
// appointment under the chosen host's OAuth grant. End-to-end this
// produces:
//
//   1. A Calendar event on the host's primary calendar (the host sees
//      the appointment alongside their other meetings).
//   2. A Google Meet room attached to that event (the join URL goes
//      onto the appointment row as join_url, matching the legacy
//      flow's contract).
//   3. A Calendar invite emailed to the patient by Google itself, so
//      Apple Mail / Outlook / Gmail surface the booking as a calendar
//      event the same way they do for legacy bookings.
//   4. A Meet space resource we can later query for attendance.
//
// This replaces the earlier "create a standalone Meet space" approach,
// which gave us a join URL but skipped the host calendar visibility +
// patient invite that legacy virtual impression appointments have. The
// brief asked for parity-or-better with the legacy service-account
// flow — this surface delivers parity (host calendar + invite) AND the
// new per-host attendance capability.
//
// Idempotent: if the appointment already has a meet_space_id we return
// the cached identifiers and skip the API call. Re-running after a
// host change requires meet_space_id=null on the row.
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

  const calendarBody: Record<string, unknown> = {
    summary,
    description,
    start: { dateTime: appt.start_at, timeZone: 'Europe/London' },
    end: { dateTime: appt.end_at, timeZone: 'Europe/London' },
    conferenceData: {
      createRequest: {
        requestId: appt.id, // Idempotency key for retries.
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
    guestsCanModify: false,
    guestsCanInviteOthers: false,
  };
  if (patient?.email) {
    calendarBody.attendees = [{ email: patient.email, responseStatus: 'needsAction' }];
  }

  // sendUpdates=all → Google emails the calendar invite to attendees.
  // conferenceDataVersion=1 enables the conferenceData.createRequest path.
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
    return json(200, {
      ok: false,
      error: `Calendar event create failed: ${calRes.status} ${errBody.slice(0, 300)}`,
    });
  }
  const calEvent = (await calRes.json()) as {
    id?: string;
    hangoutLink?: string;
    conferenceData?: {
      conferenceId?: string;
      entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
    };
  };
  if (!calEvent.id) {
    return json(200, { ok: false, error: 'Calendar API returned no event id.' });
  }
  // hangoutLink is the user-facing Meet URL; conferenceId is the short
  // meetingCode (e.g. abc-defg-hij). Pull them robustly because Google
  // sometimes returns the URL on conferenceData.entryPoints[].uri rather
  // than the top-level hangoutLink field.
  const joinUrl =
    calEvent.hangoutLink
    ?? calEvent.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri
    ?? null;
  const meetingCode = calEvent.conferenceData?.conferenceId ?? null;
  if (!joinUrl || !meetingCode) {
    return json(200, {
      ok: false,
      error: 'Calendar event created but Meet details were not returned. Confirm Google Meet is enabled for this host.',
    });
  }

  // 4. Look up the canonical Meet space resource so we can query it
  //    later for attendance. The Meet API's spaces.get endpoint resolves
  //    a meetingCode in the resource path. The returned space.name is
  //    the opaque server-generated identifier (`spaces/Yqfg7gQAAAAB`),
  //    NOT the meeting code with a prefix.
  //
  //    On failure we store NULL and log the response to
  //    lng_system_failures rather than fabricating a value. Two reasons:
  //
  //      a. The old code fell through to `spaces/${meetingCode}` when
  //         this call failed. That string isn't a valid space resource
  //         name, so every later filter against it matched nothing —
  //         attendance was silently broken for any appointment whose
  //         spaces.get failed at create time.
  //      b. meet-fetch-attendance now filters by space.meeting_code
  //         (which is always correct) rather than space.name, so a NULL
  //         meet_space_id doesn't break attendance fetching. It just
  //         means we don't carry the canonical name around — also fine.
  //
  //    Logging the failure makes the cause visible (scope, quota,
  //    propagation delay) instead of paving over it.
  let meetSpaceName: string | null = null;
  try {
    const spaceRes = await fetch(`https://meet.googleapis.com/v2/spaces/${encodeURIComponent(meetingCode)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (spaceRes.ok) {
      const space = (await spaceRes.json()) as { name?: string };
      if (space.name) meetSpaceName = space.name;
    } else {
      const errBody = await spaceRes.text().catch(() => '');
      await admin.from('lng_system_failures').insert({
        source: 'meet-create-space',
        severity: 'warning',
        message: `spaces.get failed: ${spaceRes.status}`,
        context: {
          appointment_id: appt.id,
          meeting_code: meetingCode,
          host_email: host.google_email,
          response_status: spaceRes.status,
          response_body_preview: errBody.slice(0, 500),
        },
      });
    }
  } catch (e) {
    await admin.from('lng_system_failures').insert({
      source: 'meet-create-space',
      severity: 'warning',
      message: `spaces.get threw: ${e instanceof Error ? e.message : String(e)}`,
      context: {
        appointment_id: appt.id,
        meeting_code: meetingCode,
        host_email: host.google_email,
      },
    });
  }

  // 5. Persist onto the appointment. We mirror the legacy column set
  //    (join_url + google_calendar_event_id) so every existing surface
  //    — schedule card teal accent, AppointmentDetail virtual hero,
  //    confirmation email template, cancel-deletes-calendar-event flow
  //    — reads the appointment as virtual identically. The new
  //    meet_host_id + meet_space_id + meet_meeting_code add per-host
  //    attendance capability on top of that. meet_space_id is null when
  //    spaces.get failed; meet_meeting_code is always set (it's what
  //    meet-fetch-attendance actually filters on).
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
