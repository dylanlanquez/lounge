// twilio-voice-listen-in
//
// Staff-authenticated, admin-only. Mints a Twilio Voice Access Token
// for an admin who wants to silently listen in on a call already in
// progress, and records the lng_voice_call_listeners row that
// twilio-voice-conference-status later stamps left_at on.
//
// This is the actual authorization boundary for live listening, not
// the client UI that only shows the "Listen in" button to admins —
// that's discoverability, this is the gate. Re-derives admin status
// server-side from lng_staff_members/accounts exactly the way
// currentAccount.tsx does client-side (active staff row AND is_admin,
// OR the super-admin email), never trusting a client-supplied flag.
//
// Response: { ok: true, token, identity, sessionId, ttlSeconds } on
// success. { ok: false, error, reason? } on failure.
//
//   reason codes:
//     not_signed_in     no/invalid bearer token
//     not_admin         signed in, but not an admin
//     not_configured    a required Twilio env var is missing
//     session_not_live  the target call isn't ringing/in-progress
//
// The minted token's identity is prefixed listener-<accountId>, not
// staff-<accountId>, so Twilio's own call logs visibly distinguish a
// listening leg from a normal outbound one. device.connect() must be
// called with { params: { sessionId, listen: '1' } } — the frontend
// listen-in hook does this, not this function.
//
// A plain PostgrestClient, not the full supabase-js SupabaseClient,
// no npm:twilio package — see twilio-voice-token's header comment
// for why.

import { PostgrestClient } from 'npm:@supabase/postgrest-js@1.19.4';
import { buildVoiceAccessToken } from '../_shared/twilioVoiceToken.ts';
type AdminClient = PostgrestClient;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
// Matches currentAccount.tsx's SUPER_ADMIN_EMAIL exactly — the
// super admin always passes every gate so a fresh install can be
// administered without a bootstrap chicken-and-egg problem.
const SUPER_ADMIN_EMAIL = 'dylan@lanquez.com';
const TOKEN_TTL_SECONDS = 3600;

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return jsonResponse(200, {
      ok: false,
      error: `twilio-voice-listen-in crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
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

  const { data: accRaw } = await admin
    .from('accounts')
    .select('id, login_email')
    .eq('auth_user_id', callerAuthId)
    .maybeSingle();
  const acc = accRaw as { id: string; login_email: string } | null;
  if (!acc) return jsonResponse(401, { ok: false, error: 'Not signed in', reason: 'not_signed_in' });

  const isSuperAdmin = acc.login_email === SUPER_ADMIN_EMAIL;
  let isAdmin = isSuperAdmin;
  if (!isAdmin) {
    const { data: membershipRaw } = await admin
      .from('lng_staff_members')
      .select('is_admin, status')
      .eq('account_id', acc.id)
      .maybeSingle();
    const membership = membershipRaw as { is_admin: boolean; status: string } | null;
    isAdmin = membership?.status === 'active' && membership?.is_admin === true;
  }
  if (!isAdmin) {
    await logFailure(admin, {
      severity: 'warning',
      message: `twilio-voice-listen-in: non-admin account ${acc.id} attempted to listen in on session ${sessionId}`,
      context: { sessionId },
      accountId: acc.id,
    });
    return jsonResponse(403, { ok: false, error: 'Admin access required', reason: 'not_admin' });
  }

  const { data: sessionRaw } = await admin
    .from('lng_voice_call_sessions')
    .select('id, status')
    .eq('id', sessionId)
    .maybeSingle();
  const session = sessionRaw as { id: string; status: string } | null;
  if (!session || !['ringing', 'in-progress'].includes(session.status)) {
    return jsonResponse(409, { ok: false, error: 'This call is not currently live', reason: 'session_not_live' });
  }

  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
  const apiKeySid = Deno.env.get('TWILIO_VOICE_API_KEY_SID') ?? '';
  const apiKeySecret = Deno.env.get('TWILIO_VOICE_API_KEY_SECRET') ?? '';
  const appSid = Deno.env.get('TWILIO_TWIML_APP_SID') ?? '';
  const missing = [
    !accountSid && 'TWILIO_ACCOUNT_SID',
    !apiKeySid && 'TWILIO_VOICE_API_KEY_SID',
    !apiKeySecret && 'TWILIO_VOICE_API_KEY_SECRET',
    !appSid && 'TWILIO_TWIML_APP_SID',
  ].filter(Boolean);
  if (missing.length > 0) {
    await logFailure(admin, {
      severity: 'error',
      message: `twilio-voice-listen-in: Twilio not configured: missing ${missing.join(', ')}`,
      context: { sessionId },
      accountId: acc.id,
    });
    return jsonResponse(200, { ok: false, error: 'Voice calling is not configured yet.', reason: 'not_configured' });
  }

  const identity = `listener-${acc.id}`;
  const token = await buildVoiceAccessToken({
    accountSid,
    apiKeySid,
    apiKeySecret,
    appSid,
    identity,
    ttlSeconds: TOKEN_TTL_SECONDS,
  });

  await admin.from('lng_voice_call_listeners').insert({ session_id: sessionId, account_id: acc.id });

  return jsonResponse(200, { ok: true, token, identity, sessionId, ttlSeconds: TOKEN_TTL_SECONDS });
}

async function logFailure(
  admin: AdminClient,
  args: { severity: 'warning' | 'error'; message: string; context: Record<string, unknown>; accountId: string | null },
): Promise<void> {
  try {
    await admin.from('lng_system_failures').insert({
      source: 'twilio-voice-listen-in',
      severity: args.severity,
      message: args.message,
      context: args.context,
      user_id: args.accountId,
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
