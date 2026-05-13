// meet-fetch-attendance
//
// Pulls every scrap of evidence we can from Google about a virtual
// appointment, so staff-vs-patient disputes ("the patient never joined"
// / "the host wasn't there") are answerable from data, not opinion.
//
// What it captures, written back to lng_appointments + lng_meet_attendance:
//
//   conferenceRecords.startTime / .endTime
//     → conference_started_at / conference_ended_at.
//       NULL after end_at = the conference never opened. Smoking gun.
//
//   participants + participantSessions
//     → one lng_meet_attendance row per session, with is_host derived
//       from a display_name match against lng_meet_hosts, and
//       meet_user_id (Google's stable user-resource id) so the card
//       can group multi-session joins into one row per person.
//
//   recordings + transcripts (per conference record)
//     → recording_count / transcript_count on the appointment. Their
//       very existence is unfakeable proof the call happened.
//
//   Calendar event attendees[] for the patient
//     → patient_rsvp_status / patient_rsvp_updated_at. Tells us if the
//       patient accepted, declined, or never opened the invite.
//
// Meet only publishes conferenceRecords once the meeting has ended,
// so an empty response before then is not an error — the response
// reports waitingForMeeting=true and the UI surfaces it gracefully.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { getValidAccessToken, type MeetHostRow } from '../_shared/meetHostToken.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors() });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) return json(401, { ok: false, error: 'No bearer token' });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) return json(401, { ok: false, error: 'Not signed in' });

  let body: { appointment_id?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const appointmentId = body.appointment_id;
  if (!appointmentId) return json(400, { ok: false, error: 'appointment_id required' });

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Hydrate the appointment + its host. google_calendar_event_id
  //    + patient_id are pulled here so the Calendar RSVP block below
  //    can read the patient's responseStatus off the underlying event.
  const { data: apptRow, error: apptErr } = await admin
    .from('lng_appointments')
    .select('id, meet_space_id, meet_host_id, end_at, google_calendar_event_id, patient_id')
    .eq('id', appointmentId)
    .maybeSingle();
  if (apptErr || !apptRow) return json(404, { ok: false, error: 'Appointment not found' });
  const appt = apptRow as {
    id: string;
    meet_space_id: string | null;
    meet_host_id: string | null;
    end_at: string;
    google_calendar_event_id: string | null;
    patient_id: string;
  };
  if (!appt.meet_space_id || !appt.meet_host_id) {
    return json(200, { ok: false, error: 'No Meet space recorded for this appointment' });
  }

  const { data: hostRow } = await admin
    .from('lng_meet_hosts')
    .select('id, display_name, google_email, access_token, refresh_token, token_expiry, is_active')
    .eq('id', appt.meet_host_id)
    .maybeSingle();
  const host = hostRow as MeetHostRow | null;
  if (!host) return json(404, { ok: false, error: 'Host not found' });

  // Pre-load every active host's display_name. We label a participant
  // as "host" if their Meet display name matches any host on file, not
  // just THIS appointment's assigned host — a stand-in (Karly covering
  // Lab) still reads as staff in the verdict line.
  const { data: allHostsRaw } = await admin
    .from('lng_meet_hosts')
    .select('display_name, google_email')
    .eq('is_active', true);
  const knownHostNames = new Set(
    ((allHostsRaw as Array<{ display_name: string | null }> | null) ?? [])
      .map((h) => (h.display_name ?? '').trim().toLowerCase())
      .filter((s) => s.length > 0),
  );

  const tokenResult = await getValidAccessToken(admin, host);
  if (!tokenResult.ok) return json(200, { ok: false, error: tokenResult.error });
  const accessToken = tokenResult.accessToken;

  // 2. Find the conference record for this space. Filter syntax per
  //    Meet API: filter=space.name="spaces/abc"
  const filter = `space.name=\"${appt.meet_space_id}\"`;
  const confRes = await fetch(
    `https://meet.googleapis.com/v2/conferenceRecords?filter=${encodeURIComponent(filter)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!confRes.ok) {
    const errBody = await confRes.text().catch(() => '');
    return json(200, {
      ok: false,
      error: `conferenceRecords fetch failed: ${confRes.status} ${errBody.slice(0, 200)}`,
    });
  }
  const confData = (await confRes.json()) as {
    conferenceRecords?: Array<{ name?: string; startTime?: string; endTime?: string }>;
  };
  const record = confData.conferenceRecords?.[0];
  if (!record?.name) {
    return json(200, {
      ok: true,
      waitingForMeeting: true,
      message: 'No conference record yet. Attendance lands once the meeting has ended.',
      attendance: [],
    });
  }

  // Persist the conferenceRecord's own start/end times on the
  // appointment. This is the smoking-gun column: if conference_started_at
  // is still null after end_at has passed, Google has no record of the
  // conference ever opening — i.e. nobody connected, period. Helps the
  // verdict line settle "the patient never joined" disputes without the
  // operator having to read the session list.
  if (record.startTime || record.endTime) {
    await admin
      .from('lng_appointments')
      .update({
        conference_started_at: record.startTime ?? null,
        conference_ended_at: record.endTime ?? null,
      })
      .eq('id', appointmentId);
  }

  // 2b. Corroborating evidence — recordings + transcripts. Both endpoints
  //     return an empty list when the host didn't record or caption the
  //     call, which is fine; the count of 0 is itself a useful negative
  //     signal ("call happened but wasn't recorded"). A non-zero count is
  //     unfakeable proof the meeting took place. Failures here downgrade
  //     to "leave the counts as-is" — we don't want a transient 5xx on
  //     /recordings to wipe out a previously-captured count.
  const recordingCount = await countListing(
    `https://meet.googleapis.com/v2/${record.name}/recordings`,
    accessToken,
    'recordings',
  );
  const transcriptCount = await countListing(
    `https://meet.googleapis.com/v2/${record.name}/transcripts`,
    accessToken,
    'transcripts',
  );
  if (recordingCount != null || transcriptCount != null) {
    const update: Record<string, unknown> = {};
    if (recordingCount != null) update.recording_count = recordingCount;
    if (transcriptCount != null) update.transcript_count = transcriptCount;
    await admin.from('lng_appointments').update(update).eq('id', appointmentId);
  }

  // 3. List participants and, for each, list their sessions.
  const partRes = await fetch(
    `https://meet.googleapis.com/v2/${record.name}/participants`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!partRes.ok) {
    const errBody = await partRes.text().catch(() => '');
    return json(200, {
      ok: false,
      error: `participants fetch failed: ${partRes.status} ${errBody.slice(0, 200)}`,
    });
  }
  const partData = (await partRes.json()) as {
    participants?: Array<{
      name?: string;
      // signedinUser.user is the stable Google user-resource id we use
      // to group rows by person across sessions. displayName covers the
      // label rendered in the card.
      signedinUser?: { displayName?: string; user?: string };
      anonymousUser?: { displayName?: string };
      phoneUser?: { displayName?: string };
    }>;
  };

  // For email lookup we hit the userinfo API for signed-in users by
  // their user resource name; the Meet API does NOT publish emails
  // directly. We accept that the email may end up null for guests
  // and surface "Guest" / "Anonymous" in the UI accordingly.
  let upserts = 0;
  for (const participant of partData.participants ?? []) {
    if (!participant.name) continue;
    const displayName =
      participant.signedinUser?.displayName
      ?? participant.anonymousUser?.displayName
      ?? participant.phoneUser?.displayName
      ?? 'Guest';

    // signedinUser.user is Google's stable user-resource id ("users/abc").
    // Same person across sessions resolves to the same id, so the UI can
    // group rows by it. Null for anonymous / phone joiners, in which case
    // we fall back to participant_name (which is also null-safe — we
    // group those under their displayName).
    const meetUserId = participant.signedinUser?.user ?? null;

    // Tag as host when the Meet display_name matches an active
    // lng_meet_hosts.display_name. Lowercased + trimmed both sides for
    // robustness. The patient's Meet display name has to come from
    // their Google account or their typed-in guest name, neither of
    // which we control — so a non-match defaults to false (patient).
    const isHost = knownHostNames.has(displayName.trim().toLowerCase());

    const sessRes = await fetch(
      `https://meet.googleapis.com/v2/${participant.name}/participantSessions`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!sessRes.ok) {
      // Skip this participant rather than aborting the whole sync —
      // a transient 5xx on one row shouldn't lose attendance for the
      // rest of the meeting.
      continue;
    }
    const sessData = (await sessRes.json()) as {
      participantSessions?: Array<{ name?: string; startTime?: string; endTime?: string }>;
    };
    for (const session of sessData.participantSessions ?? []) {
      if (!session.name || !session.startTime) continue;
      const joinedAt = session.startTime;
      const leftAt = session.endTime ?? null;
      const durationSeconds = leftAt
        ? Math.max(0, Math.floor((new Date(leftAt).getTime() - new Date(joinedAt).getTime()) / 1000))
        : null;
      const { error: upErr } = await admin
        .from('lng_meet_attendance')
        .upsert(
          {
            appointment_id: appointmentId,
            participant_name: displayName,
            participant_email: null,
            meet_session_name: session.name,
            joined_at: joinedAt,
            left_at: leftAt,
            duration_seconds: durationSeconds,
            is_host: isHost,
            meet_user_id: meetUserId,
          },
          { onConflict: 'appointment_id,meet_session_name' },
        );
      if (!upErr) upserts++;
    }
  }

  // 4. Patient RSVP from the underlying Calendar event. Tells us
  //    whether the patient ever opened the invite, and which way they
  //    responded if so. Best-effort: when there's no calendar event id
  //    or no patient email we skip silently — the column just stays as
  //    whatever was previously recorded (NULL on the first run).
  if (appt.google_calendar_event_id) {
    const { data: patientRow } = await admin
      .from('patients')
      .select('email')
      .eq('id', appt.patient_id)
      .maybeSingle();
    const patientEmail = ((patientRow as { email: string | null } | null)?.email ?? '').trim().toLowerCase();
    if (patientEmail) {
      try {
        const eventRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(appt.google_calendar_event_id)}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (eventRes.ok) {
          const eventData = (await eventRes.json()) as {
            attendees?: Array<{ email?: string; responseStatus?: string }>;
          };
          const match = (eventData.attendees ?? []).find(
            (a) => (a.email ?? '').trim().toLowerCase() === patientEmail,
          );
          const status = match?.responseStatus ?? null;
          // Only persist when we get a recognised value or a null match
          // for an attendee we know exists. If the calendar event has
          // no attendees field at all (organiser-only event) we leave
          // the column alone — no signal to write.
          if (status && ['accepted', 'declined', 'tentative', 'needsAction'].includes(status)) {
            await admin
              .from('lng_appointments')
              .update({
                patient_rsvp_status: status,
                patient_rsvp_updated_at: new Date().toISOString(),
              })
              .eq('id', appointmentId);
          }
        }
      } catch {
        // RSVP read failure is non-fatal — the verdict line keeps
        // working off the conferenceRecord data.
      }
    }
  }

  return json(200, {
    ok: true,
    waitingForMeeting: false,
    upserts,
    recordingCount,
    transcriptCount,
  });
});

// Returns the total number of items at a v2 listing endpoint
// (recordings or transcripts) by walking nextPageToken. Returns null
// on a non-OK response so callers can leave the previously-stored
// count untouched rather than overwriting it with a transient 0.
async function countListing(
  baseUrl: string,
  accessToken: string,
  arrayKey: 'recordings' | 'transcripts',
): Promise<number | null> {
  let total = 0;
  let url: string | null = baseUrl;
  let safetyHops = 0;
  while (url && safetyHops < 10) {
    safetyHops++;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      recordings?: Array<unknown>;
      transcripts?: Array<unknown>;
      nextPageToken?: string;
    };
    const list = (body[arrayKey] ?? []) as Array<unknown>;
    total += list.length;
    if (!body.nextPageToken) break;
    const next = new URL(baseUrl);
    next.searchParams.set('pageToken', body.nextPageToken);
    url = next.toString();
  }
  return total;
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
