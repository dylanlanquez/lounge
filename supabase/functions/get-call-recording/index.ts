// get-call-recording
//
// Staff-authenticated. Proxies a call recording's audio from Twilio
// to the signed-in browser, so the client never sees a raw Twilio
// URL or Twilio credentials — the same "never hand out a directly
// playable link" spirit as this app's signed-storage-URL pattern
// (src/lib/queries/patientFiles.ts), even though the bytes live on
// Twilio for this feature's first version rather than in Supabase
// Storage. See the plan's Part 3 for why: mirroring every recording
// into our own storage on every call adds a real new
// download/upload/delete failure class for a feature that's meant to
// ship dormant and low-risk; a scheduled retention sweep
// (voice-recording-retention-sweep) is what keeps "no longer than
// necessary" true instead.
//
// Auth: anon-key Bearer JWT, the caller is a signed-in Lounge staff
// member — no extra role check beyond being staff, matching who can
// already see the Call record card this plays back from.
//
// Request: POST { sessionId }
// Response: audio/mpeg bytes on success. JSON { ok:false, error,
// reason } on failure:
//   not_signed_in    no/invalid bearer token
//   not_found        no such session
//   not_available    recording_status isn't 'available'
//
// Every successful play is logged to patient_events
// (voice_recording_played) — a materially more sensitive read than a
// text note, worth its own audit trail regardless of how the
// consent/detectability compliance questions get resolved.
//
// A plain PostgrestClient, not the full supabase-js SupabaseClient,
// no npm:twilio package — see twilio-voice-token's header comment
// for why.

import { PostgrestClient } from 'npm:@supabase/postgrest-js@1.19.4';
type AdminClient = PostgrestClient;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return jsonResponse(200, {
      ok: false,
      error: `get-call-recording crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    });
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) {
    return jsonResponse(401, { ok: false, error: 'No bearer token' });
  }
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: userJwt },
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!who?.id) return jsonResponse(401, { ok: false, error: 'Not signed in', reason: 'not_signed_in' });
  const callerAuthId = who.id as string;

  let body: { sessionId?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const sessionId = body.sessionId;
  if (!sessionId) return jsonResponse(400, { ok: false, error: 'sessionId required' });

  const admin: AdminClient = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  const { data: session } = await admin
    .from('lng_voice_call_sessions')
    .select('id, appointment_id, patient_id, recording_sid, recording_status')
    .eq('id', sessionId)
    .maybeSingle();
  const row = session as
    | { id: string; appointment_id: string; patient_id: string; recording_sid: string | null; recording_status: string }
    | null;
  if (!row) return jsonResponse(404, { ok: false, error: 'No such call session', reason: 'not_found' });
  if (row.recording_status !== 'available' || !row.recording_sid) {
    return jsonResponse(409, { ok: false, error: 'Recording not available', reason: 'not_available' });
  }

  const auth = 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const twilioRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${row.recording_sid}.mp3`,
    { headers: { Authorization: auth } },
  );
  if (!twilioRes.ok || !twilioRes.body) {
    await logFailure(admin, {
      severity: 'error',
      message: `get-call-recording: Twilio fetch failed (${twilioRes.status}) for recording ${row.recording_sid}`,
      context: { sessionId },
      callerAccountAuthId: callerAuthId,
    });
    return jsonResponse(502, { ok: false, error: 'Could not fetch the recording' });
  }

  const { data: acc } = await admin
    .from('accounts')
    .select('id')
    .eq('auth_user_id', callerAuthId)
    .maybeSingle();
  const staffAccountId = (acc as { id: string } | null)?.id ?? null;

  await admin.from('patient_events').insert({
    patient_id: row.patient_id,
    event_type: 'voice_recording_played',
    actor_account_id: staffAccountId,
    payload: { appointment_id: row.appointment_id, session_id: row.id, staff_account_id: staffAccountId },
  });

  return new Response(twilioRes.body, {
    status: 200,
    headers: { ...corsHeaders(), 'Content-Type': 'audio/mpeg' },
  });
}

async function logFailure(
  admin: AdminClient,
  args: {
    severity: 'warning' | 'error';
    message: string;
    context: Record<string, unknown>;
    callerAccountAuthId: string | null;
  },
): Promise<void> {
  try {
    let userId: string | null = null;
    if (args.callerAccountAuthId) {
      const { data: acc } = await admin
        .from('accounts')
        .select('id')
        .eq('auth_user_id', args.callerAccountAuthId)
        .maybeSingle();
      userId = (acc as { id: string } | null)?.id ?? null;
    }
    await admin.from('lng_system_failures').insert({
      source: 'get-call-recording',
      severity: args.severity,
      message: args.message,
      context: args.context,
      user_id: userId,
    });
  } catch {
    // Failure logging is best-effort; never let it break the response.
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}
