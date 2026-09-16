// twilio-voice-conference-status
//
// PUBLIC webhook. Twilio's Conference-level status callback (start,
// end, join, leave), set on every <Conference> tag in this feature
// (the agent's, the patient's, and a listener's). The only thing
// this function does is stamp lng_voice_call_listeners.left_at when
// a listener's own call leg leaves — pure bookkeeping for the "who's
// currently listening" audit trail, never a teardown mechanism.
// Nothing here disconnects anyone: endConferenceOnExit on the
// agent/patient legs (set in twilio-voice-twiml and
// twilio-voice-conference-join) is what actually ends a listener's
// leg when the real call ends, automatically, server-side, before
// this callback even fires for them.
//
// Auth: none from Supabase (public webhook, verify_jwt=false) —
// gated by Twilio's X-Twilio-Signature header, same as every other
// webhook in this feature. Always responds 200 regardless of
// outcome: Twilio retries any non-2xx, and the only thing a retry
// storm achieves here is more lng_system_failures noise (same
// convention as twilio-voice-status).
//
// A plain PostgrestClient, no npm:twilio package, no full
// supabase-js — see twilio-voice-token's header comment for why.

import { PostgrestClient } from 'npm:@supabase/postgrest-js@1.19.4';
import { verifyTwilioSignature } from '../_shared/twilioSignature.ts';
type AdminClient = PostgrestClient;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/twilio-voice-conference-status`;

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    await logFailure({
      severity: 'error',
      message: `twilio-voice-conference-status crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      context: {},
    });
    return new Response('ok', { status: 200 });
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const bodyText = await req.text();
  const form = new URLSearchParams(bodyText);
  const signatureHeader = req.headers.get('x-twilio-signature');

  const validSignature = TWILIO_AUTH_TOKEN
    ? await verifyTwilioSignature({
        url: WEBHOOK_URL,
        authToken: TWILIO_AUTH_TOKEN,
        formParams: form,
        signatureHeader,
      })
    : false;
  if (!validSignature) {
    await logFailure({
      severity: 'critical',
      message: 'twilio-voice-conference-status: signature verification failed, event ignored',
      context: { hasAuthToken: !!TWILIO_AUTH_TOKEN },
    });
    return new Response('ok', { status: 200 });
  }

  const event = (form.get('StatusCallbackEvent') ?? '').trim();
  const callSid = (form.get('CallSid') ?? '').trim();

  if (event !== 'leave' || !callSid) {
    // start/end/join carry nothing this function needs to persist.
    return new Response('ok', { status: 200 });
  }

  const admin: AdminClient = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  const { error } = await admin
    .from('lng_voice_call_listeners')
    .update({ left_at: new Date().toISOString() })
    .eq('listener_call_sid', callSid)
    .is('left_at', null);
  if (error) {
    // Not every "leave" event belongs to a listener — the agent's and
    // patient's own legs leave the conference too, and neither has a
    // lng_voice_call_listeners row at all, so a "no matching row"
    // outcome here is normal and not logged as a failure. Only a real
    // query error is.
    await logFailure({
      severity: 'warning',
      message: `twilio-voice-conference-status: update failed for CallSid ${callSid}: ${error.message}`,
      context: { callSid },
    });
  }

  return new Response('ok', { status: 200 });
}

async function logFailure(args: {
  severity: 'warning' | 'error' | 'critical';
  message: string;
  context: Record<string, unknown>;
}): Promise<void> {
  try {
    const admin: AdminClient = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    await admin.from('lng_system_failures').insert({
      source: 'twilio-voice-conference-status',
      severity: args.severity,
      message: args.message,
      context: args.context,
    });
  } catch {
    // Failure logging is best-effort; never let it break the response.
  }
}
