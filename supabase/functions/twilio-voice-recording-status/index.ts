// twilio-voice-recording-status
//
// PUBLIC webhook. Twilio's recordingStatusCallback for the Conference
// recording set on the patient leg's <Conference> tag in
// twilio-voice-conference-join (record="record-from-start"). Fires
// once, with RecordingStatus=completed, when the recording is ready.
//
// On success: stores the recording SID + duration against the
// matching lng_voice_call_sessions row (by CallSid — the parent call
// the Conference recording belongs to), then requests a transcription
// of that recording so twilio-voice-transcription-status has
// something to receive later.
//
// IMPORTANT — verify before relying on this in production: this uses
// Twilio's REST Recordings/{Sid}/Transcriptions resource, the
// longstanding synchronous-request/async-callback shape for
// requesting a transcript of an existing recording. Twilio has been
// steering new integrations toward its separate Voice Intelligence
// product instead, which needs its own Service SID and setup step
// this function does not do. Since voice_call.recording_enabled
// ships false and nothing here runs until Dylan turns it on after
// the compliance review, there is time to re-verify this exact
// request shape against Twilio's current API before it ever sees a
// real call — treat this as unverified against live traffic, not as
// a settled integration.
//
// Auth: none from Supabase (public webhook, verify_jwt=false) —
// gated by Twilio's X-Twilio-Signature header, same as every other
// webhook in this feature. Always responds 200: Twilio retries any
// non-2xx, and the only thing a retry storm achieves here is more
// lng_system_failures noise.
//
// A plain PostgrestClient, no npm:twilio package, no full
// supabase-js — see twilio-voice-token's header comment for why.

import { PostgrestClient } from 'npm:@supabase/postgrest-js@1.19.4';
import { verifyTwilioSignature } from '../_shared/twilioSignature.ts';
type AdminClient = PostgrestClient;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/twilio-voice-recording-status`;
const TRANSCRIPTION_CALLBACK_URL = `${SUPABASE_URL}/functions/v1/twilio-voice-transcription-status`;

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    await logFailure({
      severity: 'error',
      message: `twilio-voice-recording-status crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
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
      message: 'twilio-voice-recording-status: signature verification failed, event ignored',
      context: { hasAuthToken: !!TWILIO_AUTH_TOKEN },
    });
    return new Response('ok', { status: 200 });
  }

  const recordingStatus = (form.get('RecordingStatus') ?? '').trim();
  const recordingSid = (form.get('RecordingSid') ?? '').trim();
  const callSid = (form.get('CallSid') ?? '').trim();
  const durationRaw = (form.get('RecordingDuration') ?? '').trim();

  if (recordingStatus !== 'completed' || !recordingSid || !callSid) {
    return new Response('ok', { status: 200 });
  }

  const admin: AdminClient = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  const duration = Number.parseInt(durationRaw, 10);
  const { error, count } = await admin
    .from('lng_voice_call_sessions')
    .update(
      {
        recording_sid: recordingSid,
        recording_status: 'available',
        recording_duration_seconds: Number.isFinite(duration) ? duration : null,
      },
      { count: 'exact' },
    )
    .eq('twilio_call_sid', callSid);

  if (error) {
    await logFailure({
      severity: 'error',
      message: `twilio-voice-recording-status: update failed for CallSid ${callSid}: ${error.message}`,
      context: { callSid, recordingSid },
    });
    return new Response('ok', { status: 200 });
  }
  if (count === 0) {
    await logFailure({
      severity: 'warning',
      message: `twilio-voice-recording-status: no lng_voice_call_sessions row for CallSid ${callSid}`,
      context: { callSid, recordingSid },
    });
    return new Response('ok', { status: 200 });
  }

  await requestTranscription(admin, recordingSid, callSid);

  return new Response('ok', { status: 200 });
}

async function requestTranscription(admin: AdminClient, recordingSid: string, callSid: string): Promise<void> {
  try {
    const auth = 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
    const form = new URLSearchParams({ TranscriptionCallback: TRANSCRIPTION_CALLBACK_URL });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}/Transcriptions.json`,
      {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
    );
    if (res.ok) {
      await admin.from('lng_voice_call_sessions').update({ transcript_status: 'pending' }).eq('twilio_call_sid', callSid);
      return;
    }
    const body = await res.text().catch(() => '');
    await admin.from('lng_voice_call_sessions').update({ transcript_status: 'failed' }).eq('twilio_call_sid', callSid);
    await logFailure({
      severity: 'warning',
      message: `twilio-voice-recording-status: transcription request failed (${res.status}): ${body}`,
      context: { recordingSid, callSid },
    });
  } catch (e) {
    await admin.from('lng_voice_call_sessions').update({ transcript_status: 'failed' }).eq('twilio_call_sid', callSid);
    await logFailure({
      severity: 'warning',
      message: `twilio-voice-recording-status: transcription request threw: ${e instanceof Error ? e.message : String(e)}`,
      context: { recordingSid, callSid },
    });
  }
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
      source: 'twilio-voice-recording-status',
      severity: args.severity,
      message: args.message,
      context: args.context,
    });
  } catch {
    // Failure logging is best-effort; never let it break the response.
  }
}
