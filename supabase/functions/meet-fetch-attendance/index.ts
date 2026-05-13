// meet-fetch-attendance
//
// Called from the Appointment detail page's "Refresh attendance" button.
// Reads the host's OAuth tokens, queries the Meet conferenceRecords
// API for the appointment's space, walks participants → sessions,
// upserts each session into lng_meet_attendance.
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

  // 1. Hydrate the appointment + its host.
  const { data: apptRow, error: apptErr } = await admin
    .from('lng_appointments')
    .select('id, meet_space_id, meet_host_id, end_at')
    .eq('id', appointmentId)
    .maybeSingle();
  if (apptErr || !apptRow) return json(404, { ok: false, error: 'Appointment not found' });
  const appt = apptRow as {
    id: string;
    meet_space_id: string | null;
    meet_host_id: string | null;
    end_at: string;
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

  return json(200, {
    ok: true,
    waitingForMeeting: false,
    upserts,
  });
});

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
