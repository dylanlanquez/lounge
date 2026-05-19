// lng-resend-email
//
// Generic email-replay endpoint. Takes an existing lng_email_messages id
// and re-sends the persisted HTML to the patient's CURRENT email address,
// looked up from patients.email at send time. We deliberately do NOT
// rely on the historical to_email column — a patient who corrected
// their email after a bad send should get the replay at the new
// address.
//
// Used by the Timeline "Resend" pill for every email kind that doesn't
// have a bespoke dispatcher (receipts, dispatch confirmations, anything
// future). Appointment confirmations / cancellations / reminders still
// route through their per-kind senders so the re-rendered email reflects
// the latest appointment state, not the stale snapshot at the original
// send.
//
// Body: { emailMessageId: uuid }
//
// Returns:
//   { ok: true, recipient, providerMessageId, emailMessageId }
//   { ok: false, error }
//
// Auth: signed-in user JWT. Staff with read access to lng_email_messages
// (admin OR same-location) can resend.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { recordEmailMessage } from '../_shared/emailRecord.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return jsonResponse(200, {
      ok: false,
      error: `lng-resend-email crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    });
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) {
    return jsonResponse(401, { ok: false, error: 'No bearer token' });
  }
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) return jsonResponse(401, { ok: false, error: 'Not signed in' });

  let body: { emailMessageId?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const emailMessageId = body.emailMessageId;
  if (!emailMessageId) {
    return jsonResponse(400, { ok: false, error: 'emailMessageId required' });
  }

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Load the original message. Service role bypasses RLS so any row
  //    the caller has read access to in the UI is fetchable here; we
  //    do a defensive user-side read first so unauthorised staff can't
  //    replay messages from another location.
  const { data: gateRow, error: gateErr } = await userClient
    .from('lng_email_messages')
    .select('id')
    .eq('id', emailMessageId)
    .maybeSingle();
  if (gateErr) {
    return jsonResponse(500, { ok: false, error: `Permission check failed: ${gateErr.message}` });
  }
  if (!gateRow) {
    return jsonResponse(403, { ok: false, error: 'Not authorised to resend this email' });
  }

  const { data: msgRow, error: msgErr } = await admin
    .from('lng_email_messages')
    .select('id, patient_id, appointment_id, visit_id, location_id, kind, template_key, subject, html, body_text, to_email, from_email, reply_to, send_status')
    .eq('id', emailMessageId)
    .maybeSingle();
  if (msgErr || !msgRow) {
    return jsonResponse(404, { ok: false, error: 'Email message not found' });
  }
  const msg = msgRow as OriginalMessage;

  if (!RESEND_API_KEY) {
    return jsonResponse(200, { ok: false, error: 'delivery_not_configured: RESEND_API_KEY unset' });
  }

  // 2. Resolve the patient's CURRENT email. We trust patients.email
  //    over the stored to_email because a profile update is the most
  //    likely reason a receptionist is hitting Resend in the first
  //    place. Fall back to the historical to_email if the message had
  //    no patient (e.g. self-tests, staff invites).
  let recipient = msg.to_email;
  if (msg.patient_id) {
    const { data: patientRow } = await admin
      .from('patients')
      .select('email')
      .eq('id', msg.patient_id)
      .maybeSingle();
    const patient = patientRow as { email: string | null } | null;
    const currentEmail = patient?.email?.trim();
    if (currentEmail) {
      recipient = currentEmail;
    }
  }
  if (!recipient) {
    return jsonResponse(400, { ok: false, error: 'No recipient on patient or original message' });
  }

  // 3. Re-send via Resend. We replay the EXACT html + subject + text
  //    that landed on the patient last time — the persisted blob is
  //    treated as the canonical record. The only thing that shifts
  //    is the recipient.
  //
  // From/reply-to always come from the env var (the canonical
  // DNS-verified sender), never the stored from_email. A row that
  // was originally written before the sender was unified (e.g. the
  // legacy receipts@venneir.com alias) would otherwise replay to an
  // unverified domain and bounce with the same Resend 403 the
  // original send failed on. The persisted from is informational
  // audit, not a routing instruction.
  const envFrom = Deno.env.get('RESEND_FROM_BOOKING')
    ?? 'Venneir Appointments <lounge@notifications.venneir.com>';
  const envReplyTo = Deno.env.get('RESEND_REPLY_TO_BOOKING')
    ?? 'lounge@notifications.venneir.com';
  const resendBody: Record<string, unknown> = {
    from: envFrom,
    to: [recipient],
    reply_to: envReplyTo,
    subject: msg.subject,
    html: msg.html,
  };
  if (msg.body_text) resendBody.text = msg.body_text;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(resendBody),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const errorMsg = `Resend ${res.status}: ${errBody.slice(0, 300)}`;
    await recordEmailMessage(admin, {
      patient_id: msg.patient_id,
      appointment_id: msg.appointment_id,
      visit_id: msg.visit_id,
      location_id: msg.location_id,
      template_key: msg.template_key,
      kind: msg.kind ?? 'resend',
      subject: msg.subject,
      html: msg.html,
      body_text: msg.body_text,
      to_email: recipient,
      from_email: envFrom,
      reply_to: envReplyTo,
      send_status: 'failed',
      send_error: errorMsg,
    });
    return jsonResponse(200, { ok: false, error: errorMsg });
  }

  const respBody = await res.json().catch(() => ({}));
  const providerMessageId = (respBody as { id?: string }).id ?? null;

  const newEmailMessageId = await recordEmailMessage(admin, {
    patient_id: msg.patient_id,
    appointment_id: msg.appointment_id,
    visit_id: msg.visit_id,
    location_id: msg.location_id,
    template_key: msg.template_key,
    kind: msg.kind ?? 'resend',
    subject: msg.subject,
    html: msg.html,
    body_text: msg.body_text,
    to_email: recipient,
    from_email: msg.from_email,
    reply_to: msg.reply_to,
    provider_message_id: providerMessageId,
    send_status: 'sent',
  });

  return jsonResponse(200, {
    ok: true,
    recipient,
    providerMessageId,
    emailMessageId: newEmailMessageId,
  });
}

interface OriginalMessage {
  id: string;
  patient_id: string | null;
  appointment_id: string | null;
  visit_id: string | null;
  location_id: string | null;
  kind: string | null;
  template_key: string | null;
  subject: string;
  html: string;
  body_text: string | null;
  to_email: string;
  from_email: string | null;
  reply_to: string | null;
  send_status: 'sent' | 'failed';
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
