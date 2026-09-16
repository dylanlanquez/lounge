// twilio-voice-token
//
// Mints a short-lived Twilio Voice Access Token for the calling
// staff member's browser, so it can register a Twilio Voice SDK
// Device and place an outbound call through the "Call patient"
// button on a voice-call appointment. Auth: anon-key Bearer JWT, the
// caller is a signed-in Lounge staff member.
//
// Response: { ok: true, token, identity, ttlSeconds } on success.
// { ok: false, error, reason? } on failure.
//
//   reason codes:
//     not_signed_in       no/invalid bearer token
//     not_configured      a required Twilio env var is missing
//
// The token grants ONLY outgoing voice (via the TwiML App configured
// as TWILIO_TWIML_APP_SID) — incoming.allow is false, since nothing
// in this app calls staff browsers, only the reverse.
//
// A plain PostgrestClient, not the full supabase-js SupabaseClient,
// and no npm:twilio package either: this function only ever does a
// single accounts lookup as the service role, and hand-rolls the
// Access Token JWT with native crypto.subtle. The full supabase-js
// meta-package pulls in @supabase/realtime-js, which drags in `ws`
// and crashed Deno's edge runtime intermittently on cold start
// earlier today — see send-appointment-confirmation for the
// full incident writeup. Same discipline applies to every new
// function from here on.

import { PostgrestClient } from 'npm:@supabase/postgrest-js@1.19.4';
import { buildVoiceAccessToken } from '../_shared/twilioVoiceToken.ts';
type AdminClient = PostgrestClient;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const TOKEN_TTL_SECONDS = 3600;

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return jsonResponse(200, {
      ok: false,
      error: `twilio-voice-token crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
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

  const admin: AdminClient = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  const { data: acc } = await admin
    .from('accounts')
    .select('id')
    .eq('auth_user_id', callerAuthId)
    .maybeSingle();
  const accountId = (acc as { id: string } | null)?.id ?? callerAuthId;

  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
  // A dedicated key, not the TWILIO_API_KEY_SID/SECRET pair
  // _shared/twilioSms.ts uses: that one is a restricted key scoped
  // only to Messaging (confirmed via Twilio's own Keys API — it
  // 401s with "required permission twilio/messaging/messages/list is
  // missing" against anything outside Messaging), and Twilio's
  // signaling servers rejected every Access Token signed with it as
  // "JWT signature validation failed" (31202) even once the payload
  // shape itself was fixed. This key was created specifically for
  // Voice, with no scope restriction.
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
      message: `Twilio not configured: missing ${missing.join(', ')}`,
      context: {},
      callerAccountAuthId: callerAuthId,
    });
    return jsonResponse(200, {
      ok: false,
      error: 'Voice calling is not configured yet.',
      reason: 'not_configured',
    });
  }

  const identity = `staff-${accountId}`;
  const token = await buildVoiceAccessToken({
    accountSid,
    apiKeySid,
    apiKeySecret,
    appSid,
    identity,
    ttlSeconds: TOKEN_TTL_SECONDS,
  });

  return jsonResponse(200, { ok: true, token, identity, ttlSeconds: TOKEN_TTL_SECONDS });
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
      source: 'twilio-voice-token',
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
