// twilio-voice-twiml
//
// PUBLIC webhook. Twilio calls this the instant a staff browser's
// Twilio Voice SDK Device places an outbound call (Device.connect()),
// because this function's URL is configured as the TwiML
// Application's VoiceUrl (see the twilio-voice-token env var
// TWILIO_TWIML_APP_SID, and the one-time provisioning script that
// creates that Application).
//
// Twilio forwards every key passed to Device.connect({ params }) as
// an additional form field alongside its own standard params
// (CallSid, AccountSid, ...). The frontend passes:
//   sessionId   the lng_voice_call_sessions row id, inserted by the
//               browser BEFORE calling connect(), so this webhook has
//               something to correlate against.
//   To          the patient's E.164 phone number. Read from OUR OWN
//               custom param, never from Twilio's own "To" — for a
//               Client-originated call Twilio's "To" is governed by
//               how the TwiML App is configured to interpret it, not
//               guaranteed to be the literal dial target.
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
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';

// The Venneir number, already voice-capable, already used for SMS.
// Fixed as the caller ID on every bridged call — never the patient's
// own number, never derived from request input.
const CALLER_ID = '+447723333530';
const STATUS_CALLBACK_URL = `${SUPABASE_URL}/functions/v1/twilio-voice-status`;
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

  if (sessionId) {
    const { error, count } = await admin
      .from('lng_voice_call_sessions')
      .update(
        { twilio_call_sid: callSid || null, status: 'ringing', started_at: new Date().toISOString() },
        { count: 'exact' },
      )
      .eq('id', sessionId);
    if (error || count === 0) {
      // Housekeeping failure only — never block the actual call over
      // a row we can't find or update. The patient still gets dialled;
      // the session just won't have live status tracking.
      await logFailure({
        severity: 'warning',
        message: `twilio-voice-twiml: could not correlate session ${sessionId} (${error?.message ?? 'no matching row'})`,
        context: { callSid, sessionId },
      });
    }
  } else {
    await logFailure({
      severity: 'warning',
      message: 'twilio-voice-twiml: no sessionId param on connect',
      context: { callSid },
    });
  }

  const dialToXml = escapeXml(toRaw);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${CALLER_ID}" answerOnBridge="true">
    <Number statusCallback="${escapeXml(STATUS_CALLBACK_URL)}" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST">${dialToXml}</Number>
  </Dial>
</Response>`;
  return xmlResponse(twiml);
}

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
