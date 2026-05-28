// _shared/meetAttendanceCore.ts
//
// Per-appointment Google Meet attendance fetch — the conferenceRecords
// list → participants → participantSessions → upsert pipeline. Shared
// between two callers:
//
//   • meet-fetch-attendance  — operator-initiated single-appointment
//                              pull (Refresh button + page-load auto-
//                              fetch in AppointmentDetail).
//   • meet-attendance-sweep  — cron-driven sweep of every recently-
//                              ended virtual appointment.
//
// What stays OUT of this module (intentional, to keep the refactor
// surface small):
//
//   • runEmptyResultDiagnostic — operator-debug aid only, used when the
//     UI path comes back empty. Lives in meet-fetch-attendance.
//   • Calendar RSVP attendee lookup — best-effort UI metadata, also
//     lives in meet-fetch-attendance.
//
// Source attribution: the `source` arg threads into every audit and
// failure log row so ops can trace whether the data was written by the
// operator path or the cron path.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

export interface MeetAppointmentRow {
  id: string;
  meet_meeting_code: string;
  meet_host_id: string;
  end_at: string;
}

export interface ConferenceRecord {
  name: string;
  startTime?: string;
  endTime?: string;
}

export type MeetAttendanceSource = 'meet-fetch-attendance' | 'meet-attendance-sweep';

export interface ProcessAttendanceResult {
  ok: boolean;
  waitingForMeeting: boolean;
  upserts: number;
  recordingCount: number | null;
  transcriptCount: number | null;
  conferenceRecords: ConferenceRecord[];
  error?: string;
}

// Pre-load every active host's stable Google user ID + display name.
// Host detection prefers user-id match (un-forgeable) and falls back
// to display name only when no user_id is on file (legacy hosts).
// Both callers (sweep + fetch) share the same active host set, so we
// hoist the read here.
export async function loadKnownHosts(
  admin: SupabaseClient,
): Promise<{ userIds: Set<string>; fallbackNames: Set<string> }> {
  const { data } = await admin
    .from('lng_meet_hosts')
    .select('display_name, google_user_id')
    .eq('is_active', true);
  const userIds = new Set<string>();
  const fallbackNames = new Set<string>();
  for (const h of ((data as Array<{ display_name: string | null; google_user_id: string | null }> | null) ?? [])) {
    if (h.google_user_id) {
      userIds.add(`users/${h.google_user_id}`);
    } else if (h.display_name) {
      const lc = h.display_name.trim().toLowerCase();
      if (lc) fallbackNames.add(lc);
    }
  }
  return { userIds, fallbackNames };
}

export async function processAppointmentAttendance(args: {
  admin: SupabaseClient;
  appt: MeetAppointmentRow;
  accessToken: string;
  hostEmail: string;
  knownHostUserIds: Set<string>;
  fallbackHostNames: Set<string>;
  source: MeetAttendanceSource;
}): Promise<ProcessAttendanceResult> {
  const { admin, appt, accessToken, hostEmail, knownHostUserIds, fallbackHostNames, source } = args;

  // 1. List EVERY conferenceRecord for this space (one space can host
  //    multiple conferences — test blips, follow-up rejoins). Filter by
  //    space.meeting_code, not space.name, because meet_space_id is
  //    sometimes a fabricated fallback value when an earlier spaces.get
  //    lookup failed.
  const filter = `space.meeting_code=\"${appt.meet_meeting_code}\"`;
  const conferenceRecords: ConferenceRecord[] = [];
  {
    let url: string | null =
      `https://meet.googleapis.com/v2/conferenceRecords?filter=${encodeURIComponent(filter)}`;
    let safetyHops = 0;
    while (url && safetyHops < 10) {
      safetyHops++;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        await admin.from('lng_system_failures').insert({
          source,
          severity: 'error',
          message: `conferenceRecords list failed: ${res.status}`,
          context: {
            appointment_id: appt.id,
            meet_meeting_code: appt.meet_meeting_code,
            host_email: hostEmail,
            response_status: res.status,
            response_body_preview: errBody.slice(0, 500),
            filter,
          },
        });
        return {
          ok: false,
          waitingForMeeting: false,
          upserts: 0,
          recordingCount: null,
          transcriptCount: null,
          conferenceRecords: [],
          error: `conferenceRecords fetch failed: ${res.status} ${errBody.slice(0, 200)}`,
        };
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

  if (conferenceRecords.length === 0) {
    return {
      ok: true,
      waitingForMeeting: true,
      upserts: 0,
      recordingCount: null,
      transcriptCount: null,
      conferenceRecords: [],
    };
  }

  // 2. Outer envelope across all conferences.
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
    .eq('id', appt.id);

  // 3. Recordings + transcripts per conference. Null on transient
  //    failure leaves the previously-stored count alone.
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
    if (r == null) totalRecordings = null;
    else if (totalRecordings != null) totalRecordings += r;
    if (t == null) totalTranscripts = null;
    else if (totalTranscripts != null) totalTranscripts += t;
  }
  if (totalRecordings != null || totalTranscripts != null) {
    const update: Record<string, unknown> = {};
    if (totalRecordings != null) update.recording_count = totalRecordings;
    if (totalTranscripts != null) update.transcript_count = totalTranscripts;
    await admin.from('lng_appointments').update(update).eq('id', appt.id);
  }

  // 4. Walk participants + sessions per conference. The upsert goes
  //    through lng_upsert_meet_attendance_session — an RPC that uses
  //    coalesce(EXCLUDED.left_at, existing.left_at) merge semantics so
  //    a concurrent still-in-progress read can't clobber a completed
  //    read's left_at with NULL. Two callers (sweep + fetch) can race
  //    on the same session row without losing data.
  let upserts = 0;
  for (const cr of conferenceRecords) {
    const partRes = await fetch(
      `https://meet.googleapis.com/v2/${cr.name}/participants`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!partRes.ok) continue;
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
      // Two-tier host detection: user-id match preferred, display-name
      // match as fallback only when no host has a user_id on file.
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
        const { error: upErr } = await admin.rpc('lng_upsert_meet_attendance_session', {
          p_appointment_id: appt.id,
          p_meet_session_name: session.name,
          p_participant_name: displayName,
          p_joined_at: joinedAt,
          p_left_at: leftAt,
          p_duration_seconds: durationSeconds,
          p_is_host: isHost,
          p_meet_user_id: meetUserId,
        });
        if (!upErr) upserts++;
      }
    }
  }

  return {
    ok: true,
    waitingForMeeting: false,
    upserts,
    recordingCount: totalRecordings,
    transcriptCount: totalTranscripts,
    conferenceRecords,
  };
}

// Returns the total number of items at a v2 listing endpoint
// (recordings or transcripts). Returns null on a non-OK response so
// callers can leave the previously-stored count untouched.
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
