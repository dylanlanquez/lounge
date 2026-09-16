// twilio-voice-conference-join
//
// PUBLIC webhook. This is the `Url` Twilio requests for the PATIENT'S
// own call leg, the moment they answer — set as the `Url` param on
// the outbound Calls.json REST dial twilio-voice-twiml makes. Twilio
// fetches this exactly once per outbound call, before joining that
// leg to anything, giving this function's own TwiML full control
// over what the patient hears first and how their leg joins the
// shared Conference.
//
// This is also where the recording-consent announcement lives, and
// it is the ONLY correct place for it: this TwiML runs on the
// patient's leg specifically, not the agent's. A <Say> placed on the
// agent's own leg (in twilio-voice-twiml) would be heard by the
// AGENT, not the patient — getting this backwards would be a real
// compliance failure, not just a bug, so the notice is deliberately
// built here and nowhere else.
//
// The sessionId is carried as a query-string param on the Url Twilio
// was given (not a form field — a REST-created call's initial Url
// fetch carries only Twilio's own standard call params, there is no
// equivalent of Device.connect()'s custom `params` for a plain
// outbound dial). The canonical URL used for signature verification
// is reconstructed from a known base + that same param, never
// trusted wholesale from the incoming request (Supabase's edge
// gateway can present a different URL internally than the one Twilio
// actually signed against — the same reasoning as every other
// webhook in this feature).
//
// Recording is enabled/disabled and worded entirely from
// lng_settings (voice_call.recording_enabled / .recording_notice),
// re-read fresh on every call — see _shared/voiceRecordingSettings.ts.
// Off by default; when off, this function's output is exactly what
// it would have been before recording existed at all.
//
// A plain PostgrestClient, no npm:twilio package, no full
// supabase-js — see twilio-voice-token's header comment for why.

import { PostgrestClient } from 'npm:@supabase/postgrest-js@1.19.4';
import { verifyTwilioSignature } from '../_shared/twilioSignature.ts';
import { readVoiceRecordingSettings } from '../_shared/voiceRecordingSettings.ts';
type AdminClient = PostgrestClient;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';

const CALLER_ID = '+447723333530';
const BASE_URL = `${SUPABASE_URL}/functions/v1/twilio-voice-conference-join`;
const CONFERENCE_STATUS_URL = `${SUPABASE_URL}/functions/v1/twilio-voice-conference-status`;
const RECORDING_STATUS_URL = `${SUPABASE_URL}/functions/v1/twilio-voice-recording-status`;

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    await logFailure({
      severity: 'critical',
      message: `twilio-voice-conference-join crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      context: {},
    });
    return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const incomingUrl = new URL(req.url);
  const sessionId = (incomingUrl.searchParams.get('sessionId') ?? '').trim();
  const canonicalUrl = sessionId ? `${BASE_URL}?sessionId=${sessionId}` : BASE_URL;

  const bodyText = await req.text();
  const form = new URLSearchParams(bodyText);
  const signatureHeader = req.headers.get('x-twilio-signature');

  const validSignature = TWILIO_AUTH_TOKEN
    ? await verifyTwilioSignature({
        url: canonicalUrl,
        authToken: TWILIO_AUTH_TOKEN,
        formParams: form,
        signatureHeader,
      })
    : false;
  if (!validSignature) {
    await logFailure({
      severity: 'critical',
      message: 'twilio-voice-conference-join: signature verification failed, call rejected',
      context: { sessionId, hasAuthToken: !!TWILIO_AUTH_TOKEN },
    });
    return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
  }

  if (!sessionId) {
    await logFailure({
      severity: 'error',
      message: 'twilio-voice-conference-join: no sessionId query param',
      context: {},
    });
    return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
  }

  const admin: AdminClient = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  const settings = await readVoiceRecordingSettings(admin as unknown as Parameters<typeof readVoiceRecordingSettings>[0]);
  const conferenceName = `voice-session-${sessionId}`;

  const sayNotice = settings.enabled ? `<Say>${escapeXml(settings.noticeText)}</Say>` : '';
  const conferenceAttrs = settings.enabled
    ? ` record="record-from-start" recordingStatusCallback="${escapeXml(RECORDING_STATUS_URL)}" recordingStatusCallbackEvent="completed" recordingStatusCallbackMethod="POST"`
    : '';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${sayNotice}
  <Dial callerId="${CALLER_ID}" answerOnBridge="true">
    <Conference statusCallback="${escapeXml(CONFERENCE_STATUS_URL)}" statusCallbackEvent="start end join leave"
                endConferenceOnExit="true" beep="false"${conferenceAttrs}>${escapeXml(conferenceName)}</Conference>
  </Dial>
</Response>`;
  return xmlResponse(twiml);
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
      source: 'twilio-voice-conference-join',
      severity: args.severity,
      message: args.message,
      context: args.context,
    });
  } catch {
    // Failure logging is best-effort; never let it break the response.
  }
}
