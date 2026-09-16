// twilio-voice-twiml
//
// PUBLIC webhook. Twilio calls this the instant a staff browser's
// Twilio Voice SDK Device places an outbound call (Device.connect()),
// because this function's URL is configured as the TwiML
// Application's VoiceUrl (see the twilio-voice-token env var
// TWILIO_TWIML_APP_SID, and the one-time provisioning script that
// creates that Application). Two callers hit this same endpoint:
//
//   The agent, dialing out. device.connect({ params: { sessionId, To } }).
//     This function makes an outbound REST call to Twilio's own
//     Calls API to dial the patient, whose own TwiML (a different
//     function, twilio-voice-conference-join) joins the SAME named
//     Conference this function's own response puts the agent into.
//     A plain <Dial><Number> can't support a third listener joining
//     later — a Conference can, which is the whole reason this
//     moved off the simpler two-party bridge it used to be.
//
//   An admin, listening in. device.connect({ params: { sessionId,
//     listen: '1' } }), after twilio-voice-listen-in has already
//     authorized them and minted their token. Joins the same
//     Conference muted, silently. Never touches
//     lng_voice_call_sessions — joining to listen is not a call-
//     status transition.
//
// Auth: none from Supabase (public webhook, verify_jwt=false in
// config.toml) — gated entirely by Twilio's X-Twilio-Signature header
// (see _shared/twilioSignature.ts). On a bad/missing signature this
// rejects the call outright (<Reject/>) and logs a critical failure;
// it does NOT proceed to dial anything.
//
// Response is always TwiML XML, never a JSON envelope — Twilio can't
// interpret JSON here. Even on an internal failure this must return
// valid TwiML (an apology <Say> or <Reject/>), never a bare error.
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

const STATUS_CALLBACK_URL = `${SUPABASE_URL}/functions/v1/twilio-voice-status`;
const CONFERENCE_STATUS_URL = `${SUPABASE_URL}/functions/v1/twilio-voice-conference-status`;
const CONFERENCE_JOIN_BASE_URL = `${SUPABASE_URL}/functions/v1/twilio-voice-conference-join`;
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/twilio-voice-twiml`;
const E164_RE = /^\+[1-9]\d{6,14}$/;

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    await logFailure({
      severity: 'critical',
      message: `twilio-voice-twiml crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      context: {},
    });
    return xmlResponse(sayAndHangup('Something went wrong placing this call. Please try again.'));
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
      message: 'twilio-voice-twiml: signature verification failed, call rejected',
      context: { hasAuthToken: !!TWILIO_AUTH_TOKEN },
    });
    return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
  }

  const callSid = (form.get('CallSid') ?? '').trim();
  const sessionId = (form.get('sessionId') ?? '').trim();
  const isListener = (form.get('listen') ?? '').trim() === '1';

  if (!sessionId) {
    await logFailure({
      severity: 'error',
      message: 'twilio-voice-twiml: no sessionId param on connect',
      context: { callSid },
    });
    return xmlResponse(sayAndHangup('Something went wrong placing this call. Please try again.'));
  }

  const conferenceName = `voice-session-${sessionId}`;

  if (isListener) {
    // A muted, silent join — never touches lng_voice_call_sessions.
    // startConferenceOnEnter=false so a listener can never be the one
    // who starts the room (and its hold music) by joining early;
    // endConferenceOnExit defaults to false, so leaving never affects
    // the real call. See twilio-voice-conference-status for the
    // join/leave bookkeeping this feeds.
    const admin: AdminClient = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    // Correlate this Client leg's own CallSid to the listener row
    // twilio-voice-listen-in already inserted, so
    // twilio-voice-conference-status can later stamp left_at against
    // it. There's only ever one unclaimed row for this session in
    // practice — the listen-in mint and this connect() happen back
    // to back — but scope the match defensively anyway.
    const { error } = await admin
      .from('lng_voice_call_listeners')
      .update({ listener_call_sid: callSid })
      .eq('session_id', sessionId)
      .is('left_at', null)
      .is('listener_call_sid', null);
    if (error) {
      await logFailure({
        severity: 'warning',
        message: `twilio-voice-twiml: could not correlate listener call sid for session ${sessionId} (${error.message})`,
        context: { sessionId, callSid },
      });
    }
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference muted="true" startConferenceOnEnter="false" endConferenceOnExit="false" beep="false"
                statusCallback="${escapeXml(CONFERENCE_STATUS_URL)}" statusCallbackEvent="join leave">${escapeXml(conferenceName)}</Conference>
  </Dial>
</Response>`;
    return xmlResponse(twiml);
  }

  const toRaw = (form.get('To') ?? '').trim();
  if (!E164_RE.test(toRaw)) {
    await logFailure({
      severity: 'error',
      message: `twilio-voice-twiml: To param is not E.164-shaped: "${toRaw}"`,
      context: { callSid, sessionId },
    });
    return xmlResponse(sayAndHangup('This patient does not have a valid phone number on file.'));
  }

  const admin: AdminClient = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  // Dial the patient out via the REST API, not a nested <Number> —
  // that's what makes this a genuinely separate call leg the patient
  // joins into the same Conference from its own TwiML
  // (twilio-voice-conference-join), rather than a child of this
  // request the way <Dial><Number> worked before. The CallSid this
  // returns is the patient leg's own, real, unambiguous SID — no
  // more guessing which of two possible CallSids twilio-voice-status
  // will report on, the way the old nested-Number shape left open.
  const joinUrl = `${CONFERENCE_JOIN_BASE_URL}?sessionId=${sessionId}`;
  const outboundCallSid = await placeOutboundCall({ to: toRaw, url: joinUrl });

  if (!outboundCallSid) {
    await logFailure({
      severity: 'error',
      message: `twilio-voice-twiml: outbound Calls.json dial failed for session ${sessionId}`,
      context: { sessionId, to: toRaw },
    });
    return xmlResponse(sayAndHangup('This call could not be placed. Please try again.'));
  }

  const { error, count } = await admin
    .from('lng_voice_call_sessions')
    .update(
      { twilio_call_sid: outboundCallSid, status: 'ringing', started_at: new Date().toISOString() },
      { count: 'exact' },
    )
    .eq('id', sessionId);
  if (error || count === 0) {
    // Housekeeping failure only — never block the actual call over a
    // row we can't find or update. The patient still gets dialled;
    // the session just won't have live status tracking.
    await logFailure({
      severity: 'warning',
      message: `twilio-voice-twiml: could not correlate session ${sessionId} (${error?.message ?? 'no matching row'})`,
      context: { sessionId, outboundCallSid },
    });
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference statusCallback="${escapeXml(CONFERENCE_STATUS_URL)}" statusCallbackEvent="start end join leave"
                endConferenceOnExit="true" beep="false">${escapeXml(conferenceName)}</Conference>
  </Dial>
</Response>`;
  return xmlResponse(twiml);
}

// One outbound REST call, Basic-authed with the master account
// credentials (this is placing a call, not signing a Voice SDK
// Access Token — the dedicated TWILIO_VOICE_API_KEY_* pair that
// distinction matters for is unrelated to this). Returns the new
// call's own CallSid, or null on any failure.
async function placeOutboundCall(args: { to: string; url: string }): Promise<string | null> {
  const auth = 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const form = new URLSearchParams({
    To: args.to,
    From: CALLER_ID,
    Url: args.url,
    Method: 'POST',
    StatusCallback: STATUS_CALLBACK_URL,
    StatusCallbackEvent: 'initiated ringing answered completed',
    StatusCallbackMethod: 'POST',
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { sid?: string } | null;
  return body?.sid ?? null;
}

// The Venneir number, already voice-capable, already used for SMS.
// Fixed as the caller ID on every bridged call — never the patient's
// own number, never derived from request input.
const CALLER_ID = '+447723333530';

function sayAndHangup(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(message)}</Say><Hangup/></Response>`;
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlResponse(xml: string): Response {
  return new Response(xml, { status: 200, headers: { 'Content-Type': 'text/xml' } });
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
      source: 'twilio-voice-twiml',
      severity: args.severity,
      message: args.message,
      context: args.context,
    });
  } catch {
    // Failure logging is best-effort; never let it break the response.
  }
}
