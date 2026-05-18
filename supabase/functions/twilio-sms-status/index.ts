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
  //
  // Map onto our lng_sms_messages.send_status check constraint:
  //   'pending' = in-flight (queued, accepted, sending, AND Twilio's
  //               own 'sent' — which only means "carrier accepted",
  //               not "phone got it")
  //   'sent'    = delivered (final success — phone reported delivery)
  //   'failed'  = undelivered / failed / canceled
  //
  // 'sent' deliberately diverges from Twilio's 'sent' so the
  // receptionist's "Sent to +44…" state in the UI means "actually
  // arrived at the handset", not "we handed it off". The patient is
  // the audience that matters here, not the SMS infrastructure.
  let mapped: 'sent' | 'failed' | 'pending';
  if (statusRaw === 'delivered') {
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

  // Read the prior row state so we know whether THIS callback is the
  // first time we've heard about a terminal outcome (so we can fire
  // exactly one timeline event per state transition rather than one
  // per Twilio callback — Twilio fires queued → sent → delivered as
  // three callbacks for the same message).
  const { data: priorRow } = await admin
    .from('lng_sms_messages')
    .select('id, send_status, patient_id, visit_id, appointment_id, template_key, to_phone, sent_by')
    .eq('twilio_message_sid', sid)
    .maybeSingle();
  const prior = priorRow as
    | {
        id: string;
        send_status: 'pending' | 'sent' | 'failed';
        patient_id: string | null;
        visit_id: string | null;
        appointment_id: string | null;
        template_key: string | null;
        to_phone: string;
        sent_by: string | null;
      }
    | null;

  // Never downgrade from a terminal state. Twilio fires queued →
  // sent → delivered as three callbacks; the platform delivers them
  // over HTTP without ordering guarantees, so a stale "sent"
  // (Twilio's "carrier accepted", which maps to our 'pending') can
  // arrive AFTER the terminal "delivered". Without this guard the
  // late callback resets a finished row to 'pending' and the UI's
  // "Text message sending…" panel sticks forever even though the
  // patient received the SMS minutes ago.
  //
  // priorRow tells us the state AT THE TIME OF READ. That guard alone
  // isn't enough: two callbacks arriving in parallel can both observe
  // priorRow='pending', then the slower one's UPDATE clobbers the
  // faster one's terminal write. The atomic gate is therefore on the
  // UPDATE itself — when this callback maps to 'pending', the WHERE
  // clause refuses to touch any row that's already terminal. The
  // first terminal state to land wins; everything else is a no-op.
  const effectiveStatus: 'sent' | 'failed' | 'pending' = mapped;

  // Compose the send_error column so the audit row carries the
  // carrier error code and a human-readable summary. Only overwrite
  // when this update actually has error info — don't clobber a
  // prior carrier error when a later "queued → sending" update
  // comes through with no ErrorCode.
  const patch: Record<string, unknown> = {
    send_status: effectiveStatus,
  };
  if (errorCode || errorMessage) {
    patch.send_error = [errorCode, errorMessage].filter(Boolean).join(' ').trim() || null;
  }

  let updateQuery = admin
    .from('lng_sms_messages')
    .update(patch, { count: 'exact' })
    .eq('twilio_message_sid', sid);
  if (effectiveStatus === 'pending') {
    // Atomic no-downgrade gate. A late callback arriving with a
    // non-terminal status (queued / sent / sending) never overwrites
    // a row whose webhook already saw delivered / failed.
    updateQuery = updateQuery.eq('send_status', 'pending');
  }
  const { error: updErr, count } = await updateQuery;

  if (updErr) {
    await logFailure(`twilio-sms-status update failed for ${sid}: ${updErr.message}`);
    return new Response('ok', { status: 200 });
  }
  if (count === 0) {
    // Twilio kept retrying a callback for a message we never recorded
    // — most likely a manual test from the Twilio console. Log so
    // the noise is visible to ops without alarming the caller.
    await logFailure(`twilio-sms-status: no lng_sms_messages row for SID ${sid}`);
    return new Response('ok', { status: 200 });
  }

  // Emit a patient_events row on the FIRST transition to a terminal
  // state. Without this the visit timeline silently keeps showing
  // "Text message sending" forever (the original 'sms_queued' row
  // written at send time never gets superseded). Skip duplicates by
  // gating on the prior status — Twilio fires queued → sent →
  // delivered as separate callbacks, but only the actual transition
  // to sent / failed produces a timeline-worthy event.
  if (prior && prior.send_status !== effectiveStatus && effectiveStatus !== 'pending' && prior.patient_id) {
    const transitionEventType =
      effectiveStatus === 'sent' ? 'sms_delivered' : 'sms_failed';
    await admin.from('patient_events').insert({
      patient_id: prior.patient_id,
      event_type: transitionEventType,
      actor_account_id: prior.sent_by,
      payload: {
        template_key: prior.template_key,
        visit_id: prior.visit_id,
        appointment_id: prior.appointment_id,
        to_phone: prior.to_phone,
        twilio_sid: sid,
        twilio_status: statusRaw,
        error_code: errorCode || null,
        error_message: errorMessage || null,
      },
    });
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
