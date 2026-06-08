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
//       from a stable-id match against lng_meet_hosts.google_user_id,
//       and meet_user_id (Google's stable user-resource id) so the card
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
// The list-walk + upsert pipeline lives in _shared/meetAttendanceCore.ts
// so the meet-attendance-sweep cron can run the same pull from the
// server side without needing this function's user-facing envelope.
// The empty-result diagnostic + Calendar RSVP block stay inline here:
// they're UI-debug aids the cron doesn't need.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { getValidAccessToken, type MeetHostRow } from '../_shared/meetHostToken.ts';
import {
  loadKnownHosts,
  processAppointmentAttendance,
} from '../_shared/meetAttendanceCore.ts';

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

  const { data: apptRow, error: apptErr } = await admin
    .from('lng_appointments')
    .select('id, meet_meeting_code, meet_host_id, end_at, google_calendar_event_id, patient_id')
    .eq('id', appointmentId)
    .maybeSingle();
  if (apptErr || !apptRow) return json(404, { ok: false, error: 'Appointment not found' });
  const appt = apptRow as {
    id: string;
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

  const tokenResult = await getValidAccessToken(admin, host);
  if (!tokenResult.ok) return json(200, { ok: false, error: tokenResult.error });
  const accessToken = tokenResult.accessToken;

  const knownHosts = await loadKnownHosts(admin);

  const filter = `space.meeting_code=\"${appt.meet_meeting_code}\"`;
  const result = await processAppointmentAttendance({
    admin,
    appt: {
      id: appt.id,
      meet_meeting_code: appt.meet_meeting_code,
      meet_host_id: appt.meet_host_id,
      end_at: appt.end_at,
    },
    accessToken,
    hostEmail: host.google_email,
    knownHosts,
    source: 'meet-fetch-attendance',
  });

  if (!result.ok) {
    return json(200, { ok: false, error: result.error });
  }

  // Audit log: every successful list-walk records what Google returned
  // so operators can trace "I joined but the card stayed empty"
  // disputes by reading lng_event_log. Kept as a normal event, not a
  // debug toggle, because the same trail is useful for ops dashboards
  // and post-mortems.
  //
  // When the filtered list comes back empty, we ALSO call tokeninfo +
  // an unfiltered list so we know whether the host's grant can see
  // ANY of their own conferenceRecords. Inline here (not in the shared
  // core) because the sweep doesn't need it — only the operator-
  // initiated path uses it for "why is this still empty?" diagnosis.
  let diagnostic: Record<string, unknown> | null = null;
  if (result.conferenceRecords.length === 0) {
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
      conference_records_found: result.conferenceRecords.length,
      records_preview: result.conferenceRecords.slice(0, 5).map((r) => ({
        name: r.name,
        startTime: r.startTime ?? null,
        endTime: r.endTime ?? null,
      })),
      diagnostic,
    },
  });

  if (result.waitingForMeeting) {
    return json(200, {
      ok: true,
      waitingForMeeting: true,
      message: 'No conference record yet. Attendance lands once the meeting has ended.',
      attendance: [],
    });
  }

  // Patient RSVP from the underlying Calendar event. Tells us whether
  // the patient ever opened the invite, and which way they responded
  // if so. Best-effort: when there's no calendar event id or no patient
  // email we skip silently. Inline here because the sweep doesn't need
  // RSVP metadata for verdict logic.
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
        // RSVP read failure is non-fatal.
      }
    }
  }

  return json(200, {
    ok: true,
    waitingForMeeting: false,
    upserts: result.upserts,
    recordingCount: result.recordingCount,
    transcriptCount: result.transcriptCount,
  });
});

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
async function runEmptyResultDiagnostic(
  accessToken: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

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
