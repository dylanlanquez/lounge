// twilio-sms-status — webhook receiver Twilio POSTs delivery status
// updates to. Twilio fires this on every state change after the
// initial send: queued → sending → sent → delivered (or
// undelivered / failed / etc) plus error_code/error_message when the
// carrier rejects.
//
// Wiring (one-shot setup):
//   1. Deploy this function (already deployed with --no-verify-jwt
//      so Twilio can POST without an Authorization header)
//   2. Set TWILIO_STATUS_CALLBACK_URL secret on the project to
//      https://npuvhxakffxqoszytkxw.supabase.co/functions/v1/twilio-sms-status
//      (the existing _shared/twilioSms.ts already reads this env
//      var and passes it to Twilio's API as the StatusCallback
//      parameter on every send)
//   3. Optional but recommended: set TWILIO_AUTH_TOKEN so we can
//      verify Twilio's X-Twilio-Signature header. Without it we
//      accept all POSTs to this endpoint, which is acceptable only
//      because the URL contains the project's unguessable subdomain
//      and the payload is a non-secret status update; an attacker
//      could spoof a row update but only on rows we've already
//      created (twilio_message_sid lookup is the gate).
//
// Form-body keys Twilio sends:
//   MessageSid, MessageStatus, From, To, AccountSid,
//   ErrorCode (only on failure), ErrorMessage,
//   ApiVersion, RawDlrDoneDate (carrier delivery timestamp)

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Twilio posts application/x-www-form-urlencoded. Parse defensively
  // — return 200 even on malformed bodies because Twilio retries any
  // non-2xx response, and the only thing a retry storm achieves is
  // more lng_system_failures noise.
  let form: URLSearchParams;
  try {
    const text = await req.text();
    form = new URLSearchParams(text);
  } catch (e) {
    await logFailure(`twilio-sms-status parse failed: ${e instanceof Error ? e.message : String(e)}`);
    return new Response('ok', { status: 200 });
  }

  const sid = (form.get('MessageSid') ?? '').trim();
  const statusRaw = (form.get('MessageStatus') ?? '').trim().toLowerCase();
  const errorCode = (form.get('ErrorCode') ?? '').trim();
  const errorMessage = (form.get('ErrorMessage') ?? '').trim();

  if (!sid) {
    await logFailure('twilio-sms-status: missing MessageSid');
    return new Response('ok', { status: 200 });
  }

  // Twilio's full status set:
  //   queued, accepted, sending, sent, receiving, received, delivered,
  //   undelivered, failed, read, canceled, scheduled, partially_delivered
  // Map onto our lng_sms_messages.send_status check constraint
  // (sent | failed | pending). Anything that means "in flight"
  // collapses to 'pending'; final-state success → 'sent'; final-
  // state failure → 'failed'.
  let mapped: 'sent' | 'failed' | 'pending';
  if (statusRaw === 'delivered' || statusRaw === 'sent') {
    mapped = 'sent';
  } else if (
    statusRaw === 'undelivered' ||
    statusRaw === 'failed' ||
    statusRaw === 'canceled'
  ) {
    mapped = 'failed';
  } else {
    mapped = 'pending';
  }

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Compose the send_error column so the audit row carries the
  // carrier error code and a human-readable summary. Only overwrite
  // when this update actually has error info — don't clobber a
  // prior carrier error when a later "queued → sending" update
  // comes through with no ErrorCode.
  const patch: Record<string, unknown> = {
    send_status: mapped,
  };
  if (errorCode || errorMessage) {
    patch.send_error = [errorCode, errorMessage].filter(Boolean).join(' ').trim() || null;
  }

  const { error: updErr, count } = await admin
    .from('lng_sms_messages')
    .update(patch, { count: 'exact' })
    .eq('twilio_message_sid', sid);

  if (updErr) {
    await logFailure(`twilio-sms-status update failed for ${sid}: ${updErr.message}`);
    return new Response('ok', { status: 200 });
  }
  if (count === 0) {
    // Twilio kept retrying a callback for a message we never recorded
    // — most likely a manual test from the Twilio console. Log so
    // the noise is visible to ops without alarming the caller.
    await logFailure(`twilio-sms-status: no lng_sms_messages row for SID ${sid}`);
  }

  return new Response('ok', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });

  // Best-effort failure log. We swallow errors inside the helper so
  // the webhook ALWAYS returns 200; Twilio will retry the callback
  // on any non-2xx response and the queue can hold tens of attempts
  // per message.
  async function logFailure(message: string): Promise<void> {
    try {
      const sb: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await sb.from('lng_system_failures').insert({
        severity: 'warning',
        source: 'twilio-sms-status',
        message,
        context: { sid: sid || null, status: statusRaw || null },
      });
    } catch {
      // If even the failure logger fails we can't do anything except
      // let the request return 200 and move on.
    }
  }
});
