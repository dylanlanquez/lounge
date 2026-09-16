// voice-recording-retention-sweep
//
// Cron-driven (daily, see lng_run_voice_recording_retention_sweep +
// its pg_cron schedule). Recordings and transcripts live on Twilio,
// not in our own storage (see get-call-recording's header comment
// for why) — this sweep is what actually enforces "no longer than
// necessary" against that: it finds every session whose recording is
// older than the retention window, deletes it from Twilio, and
// clears the transcript locally.
//
// RETENTION_MONTHS is a plain code constant, not an admin-editable
// lng_settings toggle on purpose — changing how long patient call
// recordings are kept should go through a code review, not a
// settings-page click. 12 months, matching the "audit" tier already
// used elsewhere in this project's retention table (see
// docs/02-data-protection.md) — a recording is a verification/
// training artifact of an administrative contact, not the clinical
// record itself (the outcome + note already are that). This is a
// recommendation Dylan should confirm, not treat as settled, before
// the recording feature is ever turned on for real patients.
//
// Auth: service-role bearer JWT (decoded and checked for
// role=service_role + matching project ref), same pattern
// meet-attendance-sweep already uses for its own cron-only auth —
// verify_jwt=true would reject the opaque service-role token with
// UNAUTHORIZED_INVALID_JWT_FORMAT, so this function's own check is
// the real gate (see config.toml).
//
// A plain PostgrestClient, no npm:twilio package, no full
// supabase-js — see twilio-voice-token's header comment for why.

import { PostgrestClient } from 'npm:@supabase/postgrest-js@1.19.4';
type AdminClient = PostgrestClient;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';

const RETENTION_MONTHS = 12;

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return jsonResponse(200, {
      ok: false,
      error: `voice-recording-retention-sweep crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    });
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = req.headers.get('authorization') ?? '';
  let authorised = false;
  if (auth.startsWith('Bearer ')) {
    const payload = decodeJwtPayload(auth.slice('Bearer '.length).trim());
    if (payload?.role === 'service_role' && (!payload.ref || isExpectedProjectRef(payload.ref))) {
      authorised = true;
    }
  }
  if (!authorised) return jsonResponse(401, { ok: false, error: 'Unauthorised' });

  const admin: AdminClient = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);

  const { data: candidates, error: fetchErr } = await admin
    .from('lng_voice_call_sessions')
    .select('id, recording_sid, ended_at')
    .eq('recording_status', 'available')
    .not('recording_sid', 'is', null)
    .lt('ended_at', cutoff.toISOString());
  if (fetchErr) {
    await logFailure(admin, { severity: 'error', message: `voice-recording-retention-sweep: fetch failed: ${fetchErr.message}`, context: {} });
    return jsonResponse(200, { ok: false, error: fetchErr.message });
  }

  const rows = (candidates ?? []) as { id: string; recording_sid: string; ended_at: string | null }[];
  let deleted = 0;
  let failed = 0;

  for (const row of rows) {
    const ok = await deleteFromTwilio(row.recording_sid);
    if (!ok) {
      failed++;
      await logFailure(admin, {
        severity: 'warning',
        message: `voice-recording-retention-sweep: Twilio delete failed for recording ${row.recording_sid}`,
        context: { sessionId: row.id },
      });
      continue;
    }
    const { error: updateErr } = await admin
      .from('lng_voice_call_sessions')
      .update({ recording_status: 'deleted', transcript_text: null, transcript_status: 'purged' })
      .eq('id', row.id);
    if (updateErr) {
      failed++;
      await logFailure(admin, {
        severity: 'error',
        message: `voice-recording-retention-sweep: local update failed for session ${row.id}: ${updateErr.message}`,
        context: { sessionId: row.id },
      });
      continue;
    }
    deleted++;
  }

  return jsonResponse(200, { ok: true, candidates: rows.length, deleted, failed });
}

// A 404 means the recording is already gone from Twilio's side
// (deleted by hand, or a previous sweep run that succeeded at Twilio
// but failed to persist locally) — treated as success so the local
// row still gets cleaned up rather than retried forever.
async function deleteFromTwilio(recordingSid: string): Promise<boolean> {
  const auth = 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.json`, {
    method: 'DELETE',
    headers: { Authorization: auth },
  });
  return res.ok || res.status === 404;
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
  const m = SUPABASE_URL.match(/^https?:\/\/([^.]+)\./);
  return !!m && m[1] === ref;
}

async function logFailure(
  admin: AdminClient,
  args: { severity: 'warning' | 'error'; message: string; context: Record<string, unknown> },
): Promise<void> {
  try {
    await admin.from('lng_system_failures').insert({
      source: 'voice-recording-retention-sweep',
      severity: args.severity,
      message: args.message,
      context: args.context,
    });
  } catch {
    // Failure logging is best-effort; never let it break the response.
  }
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
