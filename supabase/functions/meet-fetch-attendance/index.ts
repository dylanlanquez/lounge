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
  //    meet_meeting_code is the canonical filter key for the
  //    conferenceRecords listing below — it's the human-readable code
  //    (abc-defg-hij) that Calendar's createRequest hands us at booking
  //    time, and Google's Meet API exposes it as a filterable field
  //    (space.meeting_code) on conferenceRecords. meet_space_id is
  //    sometimes a fallback constructed value (`spaces/<meeting_code>`)
  //    when an earlier spaces.get lookup failed; meeting_code is always
  //    the real thing because it comes straight from Calendar.
  const { data: apptRow, error: apptErr } = await admin
    .from('lng_appointments')
    .select('id, meet_space_id, meet_meeting_code, meet_host_id, end_at, google_calendar_event_id, patient_id')
    .eq('id', appointmentId)
    .maybeSingle();
  if (apptErr || !apptRow) return json(404, { ok: false, error: 'Appointment not found' });
  const appt = apptRow as {
    id: string;
    meet_space_id: string | null;
    meet_meeting_code: string | null;
    meet_host_id: string | null;
    end_at: string;
    google_calendar_event_id: string | null;
    patient_id: string;
  };
  if (!appt.meet_meeting_code || !appt.meet_host_id) {
    return json(200, { ok: false, error: 'No Meet space recorded for this appointment' });
  }

  const { data: hostRow } = await admin
    .from('lng_meet_hosts')
    .select('id, display_name, google_email, access_token, refresh_token, token_expiry, is_active')
    .eq('id', appt.meet_host_id)
    .maybeSingle();
  const host = hostRow as MeetHostRow | null;
  if (!host) return json(404, { ok: false, error: 'Host not found' });

  // Pre-load every active host's stable Google user ID + display
  // name. Host detection prefers user ID match (`signedinUser.user`
  // from the Meet API matches `users/<google_user_id>` for a host on
  // file) because the display name is forgeable — anyone can set
  // their Meet "your name" to "Dylan Lane", but only the actual
  // dylan.lane@venneir.com account can match its own Google user ID.
  //
  // Hosts that pre-date the google_user_id column (i.e. connected
  // before the OAuth-callback capture) fall back to display name
  // matching for that host specifically, so we don't suddenly lose
  // is_host detection during the rollout. After the backfill in
  // 20260513000010_lng_meet_hosts_google_user_id.sql, the only
  // registered host has its user_id, so the strict path is used.
  const { data: allHostsRaw } = await admin
    .from('lng_meet_hosts')
    .select('display_name, google_email, google_user_id')
    .eq('is_active', true);
  const knownHostUserIds = new Set<string>();
  const fallbackHostNames = new Set<string>();
  for (const h of ((allHostsRaw as Array<{ display_name: string | null; google_user_id: string | null }> | null) ?? [])) {
    if (h.google_user_id) {
      knownHostUserIds.add(`users/${h.google_user_id}`);
    } else if (h.display_name) {
      const lc = h.display_name.trim().toLowerCase();
      if (lc) fallbackHostNames.add(lc);
    }
  }

  const tokenResult = await getValidAccessToken(admin, host);
  if (!tokenResult.ok) return json(200, { ok: false, error: tokenResult.error });
  const accessToken = tokenResult.accessToken;

  // 2. Walk EVERY conferenceRecord for this space, not just the most
  //    recent. A single Meet space can host multiple conferences over
  //    its lifetime — yesterday's empty room + today's real call, or
  //    "rejoin tomorrow" follow-ups on the same link. Picking [0] would
  //    miss the others.
  //
  //    Filter on space.meeting_code, NOT space.name. Two reasons:
  //
  //      a. meeting_code is the canonical stable identifier we have on
  //         every appointment — it comes straight from the Calendar
  //         API's conferenceData.conferenceId at booking time.
  //      b. meet_space_id can be a fabricated fallback value when an
  //         earlier spaces.get lookup in meet-create-space failed
  //         silently (the function used to write `spaces/<meetingCode>`
  //         as a placeholder when it couldn't read the real
  //         server-generated space.name). Real Meet space resource
  //         names are opaque IDs like `spaces/Yqfg7gQAAAAB`, not
  //         meeting codes with a prefix. Filtering by space.name against
  //         a fabricated value matches nothing.
  //
  //    Google's Meet API v2 docs list `space.meeting_code` alongside
  //    `space.name`, `start_time`, and `end_time` as filterable fields
  //    on conferenceRecords. Using meeting_code is correct AND robust to
  //    the meet_space_id storage bug above.
  const filter = `space.meeting_code=\"${appt.meet_meeting_code}\"`;
  const conferenceRecords: Array<{ name: string; startTime?: string; endTime?: string }> = [];
  {
    let url: string | null =
      `https://meet.googleapis.com/v2/conferenceRecords?filter=${encodeURIComponent(filter)}`;
    let safetyHops = 0;
    while (url && safetyHops < 10) {
      safetyHops++;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        // Loud failure: any non-2xx here means the operator can't see
        // attendance until somebody investigates. Surface to the
        // failures sink with the full body so the cause (scope, quota,
        // malformed filter, revoked grant) is visible without re-running
        // anything.
        await admin.from('lng_system_failures').insert({
          source: 'meet-fetch-attendance',
          severity: 'error',
          message: `conferenceRecords list failed: ${res.status}`,
          context: {
            appointment_id: appointmentId,
            meet_meeting_code: appt.meet_meeting_code,
            host_email: host.google_email,
            response_status: res.status,
            response_body_preview: errBody.slice(0, 500),
            filter,
          },
        });
        return json(200, {
          ok: false,
          error: `conferenceRecords fetch failed: ${res.status} ${errBody.slice(0, 200)}`,
        });
      }
      const body = (await res.json()) as {
        conferenceRecords?: Array<{ name?: string; startTime?: string; endTime?: string }>;
        nextPageToken?: string;
      };
      for (const cr of body.conferenceRecords ?? []) {
        if (cr.name) conferenceRecords.push({ name: cr.name, startTime: cr.startTime, endTime: cr.endTime });
      }
      if (!body.nextPageToken) break;
      const next = new URL(
        `https://meet.googleapis.com/v2/conferenceRecords?filter=${encodeURIComponent(filter)}`,
      );
      next.searchParams.set('pageToken', body.nextPageToken);
      url = next.toString();
    }
  }

  // Audit log: every successful fetch records what Google returned so
  // operators can trace "I joined but the card stayed empty" disputes
  // by reading lng_event_log. Kept as a normal event, not a debug
  // toggle, because the same trail is useful for ops dashboards and
  // post-mortems. Records the filter we used, the count, and a small
  // preview so the cause (idle conference, scope, no record yet) is
  // visible without re-running the function.
  //
  // When the filtered list comes back empty, we ALSO call tokeninfo +
  // an unfiltered list so we know whether the host's grant can see
  // ANY of their own conferenceRecords. Two outcomes:
  //
  //   • Unfiltered list returns records → API + scope both work; our
  //     specific filter (or this conference) genuinely isn't there.
  //     Likely cause: Calendar-created Meet rooms not always queryable
  //     via the Meet REST API for the room's "creator".
  //   • Unfiltered list returns nothing AND tokeninfo lacks the
  //     meetings.* scope → the host's OAuth grant is too narrow;
  //     they need to disconnect + reconnect from /admin/services to
  //     re-consent with the current scope set.
  //
  // tokeninfo + unfiltered list are best-effort. We don't fail the
  // function on a 5xx from either — they're audit data, not the
  // primary path.
  let diagnostic: Record<string, unknown> | null = null;
  if (conferenceRecords.length === 0) {
    diagnostic = await runEmptyResultDiagnostic(accessToken);
  }

  await admin.from('lng_event_log').insert({
    source: 'meet-fetch-attendance',
    event_type: 'conference_list_fetched',
    payload: {
      appointment_id: appointmentId,
      meet_meeting_code: appt.meet_meeting_code,
      host_email: host.google_email,
      filter,
      conference_records_found: conferenceRecords.length,
      records_preview: conferenceRecords.slice(0, 5).map((r) => ({
        name: r.name,
        startTime: r.startTime ?? null,
        endTime: r.endTime ?? null,
      })),
      diagnostic,
    },
  });

  if (conferenceRecords.length === 0) {
    return json(200, {
      ok: true,
      waitingForMeeting: true,
      message: 'No conference record yet. Attendance lands once the meeting has ended.',
      attendance: [],
    });
  }

  // Compute the outer envelope across all conferences. The card's
  // "Conference window" line shows this — earliest start, latest end —
  // and the new conference_count column tells the UI to render
  // "(N conferences)" when more than one occurred in the space.
  let earliestStart: string | null = null;
  let latestEnd: string | null = null;
  for (const cr of conferenceRecords) {
    if (cr.startTime && (earliestStart == null || cr.startTime < earliestStart)) {
      earliestStart = cr.startTime;
    }
    if (cr.endTime && (latestEnd == null || cr.endTime > latestEnd)) {
      latestEnd = cr.endTime;
    }
  }
  await admin
    .from('lng_appointments')
    .update({
      conference_started_at: earliestStart,
      conference_ended_at: latestEnd,
      conference_count: conferenceRecords.length,
    })
    .eq('id', appointmentId);

  // 2b. Recordings + transcripts — sum across every conference record.
  //     The host might record one session and skip another; both contribute
  //     to the "did this actually happen" evidence count.
  let totalRecordings: number | null = 0;
  let totalTranscripts: number | null = 0;
  for (const cr of conferenceRecords) {
    const r = await countListing(
      `https://meet.googleapis.com/v2/${cr.name}/recordings`,
      accessToken,
      'recordings',
    );
    const t = await countListing(
      `https://meet.googleapis.com/v2/${cr.name}/transcripts`,
      accessToken,
      'transcripts',
    );
    // A null from countListing means a non-OK response — don't fold a
    // transient failure into the total; mark the whole field unknown so
    // we leave the previously-stored count alone.
    if (r == null) totalRecordings = null;
    else if (totalRecordings != null) totalRecordings += r;
    if (t == null) totalTranscripts = null;
    else if (totalTranscripts != null) totalTranscripts += t;
  }
  if (totalRecordings != null || totalTranscripts != null) {
    const update: Record<string, unknown> = {};
    if (totalRecordings != null) update.recording_count = totalRecordings;
    if (totalTranscripts != null) update.transcript_count = totalTranscripts;
    await admin.from('lng_appointments').update(update).eq('id', appointmentId);
  }

  // 3. Walk participants + sessions per conference record. Session names
  //    are globally unique across the Meet API so the upsert's
  //    (appointment_id, meet_session_name) unique constraint dedupes
  //    correctly even when the same person joined two different
  //    conferences in the same space.
  let upserts = 0;
  for (const cr of conferenceRecords) {
    const partRes = await fetch(
      `https://meet.googleapis.com/v2/${cr.name}/participants`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!partRes.ok) {
      // Skip this conference but keep aggregating the rest. The card's
      // verdict logic gracefully handles partial data.
      continue;
    }
    const partData = (await partRes.json()) as {
      participants?: Array<{
        name?: string;
        signedinUser?: { displayName?: string; user?: string };
        anonymousUser?: { displayName?: string };
        phoneUser?: { displayName?: string };
      }>;
    };

    for (const participant of partData.participants ?? []) {
      if (!participant.name) continue;
      const displayName =
        participant.signedinUser?.displayName
        ?? participant.anonymousUser?.displayName
        ?? participant.phoneUser?.displayName
        ?? 'Guest';

      const meetUserId = participant.signedinUser?.user ?? null;
      // Two-tier host detection:
      //
      //   1. PREFERRED — Google user ID match. signedinUser.user is the
      //      same stable resource id we capture for each host at OAuth
      //      time (lng_meet_hosts.google_user_id, with "users/" prefix
      //      added at compare time). Un-forgeable: even if a stranger
      //      sets their Meet display name to match the host's, they'll
      //      have a different Google user ID and won't match here.
      //
      //   2. FALLBACK — display name match for legacy hosts that
      //      pre-date the google_user_id column. Only consulted when
      //      knownHostUserIds is empty OR this participant has no
      //      signedinUser.user (anonymous joiner). After the backfill
      //      in 20260513000010, every active host has a user_id, so
      //      this branch is effectively dead code — kept as a safety
      //      net for stand-in hosts connected before the migration.
      let isHost = false;
      if (meetUserId && knownHostUserIds.has(meetUserId)) {
        isHost = true;
      } else if (knownHostUserIds.size === 0 && fallbackHostNames.has(displayName.trim().toLowerCase())) {
        isHost = true;
      }

      const sessRes = await fetch(
        `https://meet.googleapis.com/v2/${participant.name}/participantSessions`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!sessRes.ok) continue;
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
  }
  const recordingCount = totalRecordings;
  const transcriptCount = totalTranscripts;

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

// Fired only when the filtered conferenceRecords list comes back empty.
// Pulls two independent signals so the lng_event_log audit row tells us
// which of the four failure modes we're in:
//
//   • scopes_missing: the granted OAuth scopes don't include the Meet
//     ones; the host needs to reconnect.
//   • api_works_no_records_at_all: API + scopes fine, but the host has
//     NO conferenceRecords visible to them — likely the Calendar-
//     created Meet room isn't attributed to the host in a way Meet's
//     "user-created spaces" scope can read.
//   • api_works_other_records_exist: host can see other conference
//     records but not this one — our filter is wrong or this specific
//     space isn't visible to the host (e.g. they joined as a guest).
//   • diagnostic_failed: tokeninfo and/or unfiltered list errored;
//     surface the response bodies so we can diagnose anyway.
//
// Each Google call wraps its own errors so a failure on one signal
// doesn't suppress the other.
async function runEmptyResultDiagnostic(
  accessToken: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  // tokeninfo — returns the actual scopes the access token holds,
  // regardless of what we asked for at consent time. The granted set
  // can be narrower than the requested set if the user reviewed and
  // un-checked a scope on the consent screen.
  try {
    const tokenRes = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
    );
    const tokenBody = await tokenRes.text();
    out.tokeninfo_status = tokenRes.status;
    out.tokeninfo_body = tokenBody.slice(0, 800);
    if (tokenRes.ok) {
      try {
        const parsed = JSON.parse(tokenBody) as { scope?: string };
        const scopes = (parsed.scope ?? '').split(/\s+/).filter(Boolean);
        out.granted_scopes = scopes;
        out.has_meet_scope = scopes.some((s) => s.startsWith('https://www.googleapis.com/auth/meetings.'));
      } catch {
        out.tokeninfo_parse_error = true;
      }
    }
  } catch (e) {
    out.tokeninfo_threw = e instanceof Error ? e.message : String(e);
  }

  // Unfiltered conferenceRecords list — top 10. If this returns rows,
  // the API + scope work and the issue is filter-specific (or this
  // particular conference isn't owned by the host). If it returns
  // empty, the host has no visible conferenceRecords at all.
  try {
    const listRes = await fetch(
      'https://meet.googleapis.com/v2/conferenceRecords?pageSize=10',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    out.unfiltered_list_status = listRes.status;
    if (listRes.ok) {
      const body = (await listRes.json()) as {
        conferenceRecords?: Array<{ name?: string; startTime?: string; endTime?: string; space?: string }>;
      };
      const records = body.conferenceRecords ?? [];
      out.unfiltered_list_count = records.length;
      out.unfiltered_list_preview = records.slice(0, 5).map((r) => ({
        name: r.name ?? null,
        space: r.space ?? null,
        startTime: r.startTime ?? null,
        endTime: r.endTime ?? null,
      }));
    } else {
      const errBody = await listRes.text().catch(() => '');
      out.unfiltered_list_error = errBody.slice(0, 500);
    }
  } catch (e) {
    out.unfiltered_list_threw = e instanceof Error ? e.message : String(e);
  }

  return out;
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
