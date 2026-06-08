// meet-attendance-sweep
//
// Cron-driven backfill for Google Meet attendance. Runs every 5 minutes
// (see migration 20260528000001_lng_meet_attendance_sweep_cron.sql),
// walks every recently-ended virtual appointment, and pulls fresh
// attendance from Google. Closes the silent-failure hole behind the
// LAP-00518 incident on 2026-05-28: Google publishes participantSessions
// AFTER end_at, but the in-card poll cut out at end_at and the page-load
// auto-fetch short-circuited once conference_started_at was set, so
// nothing pulled the data unless an operator manually clicked Refresh.
//
// This sweep is the load-bearing fix. Layers B + C (in-card poll
// extension + page-load gate fix) keep the live UI honest in real
// time when someone is looking; this guarantees the data is always
// there when anyone looks.
//
// Auth: shared CRON_SECRET header OR service-role bearer (mirrors
// send-appointment-sms-reminders). User JWTs are NOT accepted —
// the sweep touches every clinic's virtual appointments.
//
// Per-appointment work is delegated to processAppointmentAttendance
// from _shared/meetAttendanceCore.ts, the same helper used by
// meet-fetch-attendance. Same Google calls, same upsert RPC.
//
// Logs:
//   • lng_event_log         — one sweep_complete row per run
//   • lng_system_failures   — one row per per-appointment failure
//                              (with a 1h dead-letter guard so a
//                              repeatedly-failing appointment doesn't
//                              fill the table with 288 rows/day)

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { getValidAccessToken, type MeetHostRow } from '../_shared/meetHostToken.ts';
import {
  loadKnownHosts,
  processAppointmentAttendance,
  type MeetAppointmentRow,
} from '../_shared/meetAttendanceCore.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('LNG_REMINDERS_CRON_SECRET') ?? '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-cron-secret',
};

// Cap per-sweep work. Edge functions cap at 60s; per-appointment Google
// calls run 2-5s when the meeting has multiple conferences. 20 leaves
// headroom for the slow-network case. A backlog bleeds down in 2-3 ticks.
const SWEEP_LIMIT = 20;

// Skip an appointment if we already logged a failure for it within
// this window. Prevents 288 failure rows/day per stuck appointment
// (e.g. revoked OAuth) while still giving one visible failure/hour.
const DEAD_LETTER_WINDOW_MS = 60 * 60 * 1000;

interface CandidateAppointment {
  id: string;
  meet_meeting_code: string;
  meet_host_id: string;
  end_at: string;
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return jsonResponse(200, {
      ok: false,
      error: `meet-attendance-sweep crashed: ${
        e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      }`,
    });
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Auth gate — service-role bearer OR cron secret header. Mirrors
  // send-appointment-sms-reminders' decode-and-verify approach so a
  // forged token with a different `ref` claim is rejected.
  const auth = req.headers.get('authorization') ?? '';
  const secret = req.headers.get('x-cron-secret') ?? '';
  let bearerOk = false;
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    const payload = decodeJwtPayload(token);
    if (payload?.role === 'service_role' && (!payload.ref || isExpectedProjectRef(payload.ref))) {
      bearerOk = true;
    }
  }
  const secretOk = !!CRON_SECRET && secret === CRON_SECRET;
  if (!bearerOk && !secretOk) {
    return jsonResponse(401, { ok: false, error: 'Unauthorised' });
  }

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Candidate query — virtual appointments whose end_at is in the
  // 24h tail (today's incident proved 7h lag is possible) past a
  // 5min head buffer (avoid wasteful empty pulls at exactly end_at).
  //
  // Re-pull predicate: never-pulled OR no attendance rows yet OR
  // conference still flagged as in-progress within 30 min of end_at
  // (catches late rejoins after our first pull).
  const { data: candidatesRaw, error: candErr } = await admin
    .from('lng_appointments')
    .select('id, meet_meeting_code, meet_host_id, end_at, conference_started_at, conference_ended_at')
    .not('meet_meeting_code', 'is', null)
    .not('meet_host_id', 'is', null)
    .neq('status', 'cancelled')
    .gt('end_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .lt('end_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
    .order('end_at', { ascending: false })
    .limit(SWEEP_LIMIT * 2); // overfetch so the JS-side filter can drop stable rows without starving the LIMIT
  if (candErr) {
    return jsonResponse(200, { ok: false, error: `Sweep query failed: ${candErr.message}` });
  }

  // JS-side filter: drop rows where Google has already stamped a
  // conference_ended_at AND we have attendance rows. Those are stable;
  // re-pulling is wasted Google API quota. We check attendance-rows
  // existence with a per-row count() — cheap because of the index on
  // appointment_id.
  const candidates: CandidateAppointment[] = [];
  for (const row of (candidatesRaw ?? []) as Array<{
    id: string;
    meet_meeting_code: string;
    meet_host_id: string;
    end_at: string;
    conference_started_at: string | null;
    conference_ended_at: string | null;
  }>) {
    if (candidates.length >= SWEEP_LIMIT) break;
    const endMs = new Date(row.end_at).getTime();
    const minutesPastEnd = (Date.now() - endMs) / 60000;
    const conferenceStable = row.conference_ended_at != null && minutesPastEnd > 30;
    if (conferenceStable) {
      // Was the data ever pulled? If we have rows, treat as stable.
      const { count } = await admin
        .from('lng_meet_attendance')
        .select('id', { count: 'exact', head: true })
        .eq('appointment_id', row.id);
      if ((count ?? 0) > 0) continue;
    }
    candidates.push({
      id: row.id,
      meet_meeting_code: row.meet_meeting_code,
      meet_host_id: row.meet_host_id,
      end_at: row.end_at,
    });
  }

  if (candidates.length === 0) {
    await admin.from('lng_event_log').insert({
      source: 'meet-attendance-sweep',
      event_type: 'sweep_complete',
      payload: { eligible: 0, processed: 0, upserts_total: 0, failed: 0 },
    });
    return jsonResponse(200, { ok: true, eligible: 0, processed: 0, upserts_total: 0, failed: 0 });
  }

  // Hosts are shared across appointments. Hoist once outside the loop.
  const knownHosts = await loadKnownHosts(admin);

  let processed = 0;
  let upsertsTotal = 0;
  let failed = 0;
  const errors: Array<{ appointmentId: string; reason: string }> = [];

  for (const candidate of candidates) {
    try {
      // Dead-letter guard: skip if we already logged an unresolved
      // failure for this appointment from this source in the last hour.
      const oneHourAgo = new Date(Date.now() - DEAD_LETTER_WINDOW_MS).toISOString();
      const { count: recentFailures } = await admin
        .from('lng_system_failures')
        .select('id', { count: 'exact', head: true })
        .eq('source', 'meet-attendance-sweep')
        .gte('occurred_at', oneHourAgo)
        .is('resolved_at', null)
        .filter('context->>appointment_id', 'eq', candidate.id);
      if ((recentFailures ?? 0) > 0) continue;

      const { data: hostRow } = await admin
        .from('lng_meet_hosts')
        .select('id, display_name, google_email, access_token, refresh_token, token_expiry, is_active, oauth_client')
        .eq('id', candidate.meet_host_id)
        .maybeSingle();
      const host = hostRow as MeetHostRow | null;
      if (!host) {
        await logFailure(admin, {
          message: 'Host not found for sweep candidate',
          context: { appointment_id: candidate.id, meet_host_id: candidate.meet_host_id },
        });
        failed += 1;
        errors.push({ appointmentId: candidate.id, reason: 'host not found' });
        continue;
      }

      const tokenResult = await getValidAccessToken(admin, host);
      if (!tokenResult.ok) {
        await logFailure(admin, {
          message: `OAuth token refresh failed: ${tokenResult.error}`,
          context: { appointment_id: candidate.id, host_email: host.google_email },
        });
        failed += 1;
        errors.push({ appointmentId: candidate.id, reason: tokenResult.error });
        continue;
      }

      const apptRow: MeetAppointmentRow = {
        id: candidate.id,
        meet_meeting_code: candidate.meet_meeting_code,
        meet_host_id: candidate.meet_host_id,
        end_at: candidate.end_at,
      };
      const result = await processAppointmentAttendance({
        admin,
        appt: apptRow,
        accessToken: tokenResult.accessToken,
        hostEmail: host.google_email,
        knownHosts,
        source: 'meet-attendance-sweep',
      });

      processed += 1;
      if (!result.ok) {
        failed += 1;
        errors.push({ appointmentId: candidate.id, reason: result.error ?? 'unknown' });
        continue;
      }
      upsertsTotal += result.upserts;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      failed += 1;
      errors.push({ appointmentId: candidate.id, reason });
      await logFailure(admin, {
        message: `Unhandled exception in sweep: ${reason}`,
        context: { appointment_id: candidate.id },
      });
    }
  }

  await admin.from('lng_event_log').insert({
    source: 'meet-attendance-sweep',
    event_type: 'sweep_complete',
    payload: {
      eligible: candidates.length,
      processed,
      upserts_total: upsertsTotal,
      failed,
      errors: errors.slice(0, 10),
    },
  });

  return jsonResponse(200, {
    ok: true,
    eligible: candidates.length,
    processed,
    upserts_total: upsertsTotal,
    failed,
  });
}

// ── Helpers ──────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function decodeJwtPayload(token: string): { role?: string; ref?: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const pad = payload.length % 4 === 0 ? '' : '='.repeat(4 - (payload.length % 4));
    const json = atob(payload + pad);
    return JSON.parse(json) as { role?: string; ref?: string };
  } catch {
    return null;
  }
}

function isExpectedProjectRef(ref: string): boolean {
  const url = SUPABASE_URL ?? '';
  const m = url.match(/^https?:\/\/([^.]+)\./);
  return !!m && m[1] === ref;
}

async function logFailure(
  admin: SupabaseClient,
  payload: { message: string; context: Record<string, unknown> },
): Promise<void> {
  try {
    await admin.from('lng_system_failures').insert({
      source: 'meet-attendance-sweep',
      severity: 'error',
      message: payload.message,
      context: payload.context,
    });
  } catch {
    // Failure sink is best-effort; don't recursively crash the sweep.
  }
}
