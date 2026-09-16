// twilio-voice-transcription-status
//
// PUBLIC webhook. Twilio's TranscriptionCallback, requested by
// twilio-voice-recording-status the moment a recording becomes
// available. Fires once with the finished transcript text, or a
// failed status.
//
// See twilio-voice-recording-status's header comment for the same
// caveat: the request-a-transcription/receive-a-callback shape this
// pairs with is Twilio's longstanding Recordings/Transcriptions
// resource, not their newer Voice Intelligence product — worth
// re-verifying against Twilio's current API before this feature is
// ever turned on for real calls, since it ships dormant
// (voice_call.recording_enabled defaults false) with time to do that
// before it sees live traffic.
//
// Auth: none from Supabase (public webhook, verify_jwt=false) —
// gated by Twilio's X-Twilio-Signature header. Always responds 200.
//
// A plain PostgrestClient, no npm:twilio package, no full
// supabase-js — see twilio-voice-token's header comment for why.

import { PostgrestClient } from 'npm:@supabase/postgrest-js@1.19.4';
import { verifyTwilioSignature } from '../_shared/twilioSignature.ts';
type AdminClient = PostgrestClient;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/twilio-voice-transcription-status`;

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    await logFailure({
      severity: 'error',
      message: `twilio-voice-transcription-status crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
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
      message: 'twilio-voice-transcription-status: signature verification failed, event ignored',
      context: { hasAuthToken: !!TWILIO_AUTH_TOKEN },
    });
    return new Response('ok', { status: 200 });
  }

  const recordingSid = (form.get('RecordingSid') ?? '').trim();
  const transcriptionStatus = (form.get('TranscriptionStatus') ?? '').trim();
  const transcriptionText = form.get('TranscriptionText') ?? '';

  if (!recordingSid) {
    await logFailure({
      severity: 'warning',
      message: 'twilio-voice-transcription-status: missing RecordingSid',
      context: {},
    });
    return new Response('ok', { status: 200 });
  }

  const admin: AdminClient = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  const patch =
    transcriptionStatus === 'completed'
      ? { transcript_text: transcriptionText, transcript_status: 'available' }
      : { transcript_status: 'failed' };

  const { error, count } = await admin
    .from('lng_voice_call_sessions')
    .update(patch, { count: 'exact' })
    .eq('recording_sid', recordingSid);

  if (error) {
    await logFailure({
      severity: 'error',
      message: `twilio-voice-transcription-status: update failed for RecordingSid ${recordingSid}: ${error.message}`,
      context: { recordingSid, transcriptionStatus },
    });
  } else if (count === 0) {
    await logFailure({
      severity: 'warning',
      message: `twilio-voice-transcription-status: no lng_voice_call_sessions row for RecordingSid ${recordingSid}`,
      context: { recordingSid, transcriptionStatus },
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
      source: 'twilio-voice-transcription-status',
      severity: args.severity,
      message: args.message,
      context: args.context,
    });
  } catch {
    // Failure logging is best-effort; never let it break the response.
  }
}
