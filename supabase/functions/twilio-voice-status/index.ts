// twilio-voice-status
//
// PUBLIC webhook. Twilio POSTs here as the bridged <Number> leg (see
// twilio-voice-twiml) progresses: queued -> ringing -> in-progress ->
// completed / busy / failed / no-answer / canceled. Updates the
// matching lng_voice_call_sessions row by twilio_call_sid.
//
// Auth: none from Supabase (verify_jwt=false in config.toml) —
// gated by Twilio's X-Twilio-Signature header, same as
// twilio-voice-twiml. Always responds 200 regardless of outcome:
// Twilio retries any non-2xx response, and the only thing a retry
// storm achieves here is more lng_system_failures noise (same
// convention as the existing twilio-sms-status function).
//
// A plain PostgrestClient, no npm:twilio package, no full
// supabase-js — see twilio-voice-token's header comment for why.

import { PostgrestClient } from 'npm:@supabase/postgrest-js@1.19.4';
import { verifyTwilioSignature } from '../_shared/twilioSignature.ts';
type AdminClient = PostgrestClient;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/twilio-voice-status`;

const TERMINAL_STATUSES = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];
const KNOWN_STATUSES = ['initiated', 'queued', 'ringing', 'in-progress', ...TERMINAL_STATUSES];

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    await logFailure({
      severity: 'error',
      message: `twilio-voice-status crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
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
      message: 'twilio-voice-status: signature verification failed, update ignored',
      context: { hasAuthToken: !!TWILIO_AUTH_TOKEN },
    });
    return new Response('ok', { status: 200 });
  }

  const callSid = (form.get('CallSid') ?? '').trim();
  const statusRaw = (form.get('CallStatus') ?? '').trim().toLowerCase();
  const durationRaw = (form.get('CallDuration') ?? '').trim();

  if (!callSid) {
    await logFailure({ severity: 'warning', message: 'twilio-voice-status: missing CallSid', context: {} });
    return new Response('ok', { status: 200 });
  }
  if (!KNOWN_STATUSES.includes(statusRaw)) {
    await logFailure({
      severity: 'warning',
      message: `twilio-voice-status: unrecognised CallStatus "${statusRaw}"`,
      context: { callSid },
    });
    return new Response('ok', { status: 200 });
  }

  const admin: AdminClient = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  // started_at is normally set by twilio-voice-twiml the moment the
  // call is placed; nothing here needs to touch it.
  const isTerminal = TERMINAL_STATUSES.includes(statusRaw);
  const patch: Record<string, unknown> = { status: statusRaw };
  if (isTerminal) {
    patch.ended_at = new Date().toISOString();
    if (statusRaw === 'completed' && durationRaw) {
      const seconds = Number.parseInt(durationRaw, 10);
      if (Number.isFinite(seconds)) patch.duration_seconds = seconds;
    }
  }

  // Never move a row backward out of a terminal state. Twilio's
  // documented event order for a <Number> leg is strictly forward
  // (initiated/ringing/answered/completed fire once each, in order),
  // but HTTP delivery gives no ordering guarantee, so the same
  // no-downgrade discipline as twilio-sms-status applies: a
  // non-terminal update never overwrites a row that's already
  // terminal.
  let updateQuery = admin
    .from('lng_voice_call_sessions')
    .update(patch, { count: 'exact' })
    .eq('twilio_call_sid', callSid);
  if (!isTerminal) {
    updateQuery = updateQuery.not('status', 'in', `(${TERMINAL_STATUSES.join(',')})`);
  }
  const { error, count } = await updateQuery;

  if (error) {
    await logFailure({
      severity: 'error',
      message: `twilio-voice-status: update failed for ${callSid}: ${error.message}`,
      context: { callSid, status: statusRaw },
    });
  } else if (count === 0) {
    await logFailure({
      severity: 'warning',
      message: `twilio-voice-status: no lng_voice_call_sessions row for CallSid ${callSid}`,
      context: { callSid, status: statusRaw },
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
      source: 'twilio-voice-status',
      severity: args.severity,
      message: args.message,
      context: args.context,
    });
  } catch {
    // Failure logging is best-effort; never let it break the response.
  }
}
