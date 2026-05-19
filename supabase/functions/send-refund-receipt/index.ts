// send-refund-receipt
//
// Renders + delivers the refund_receipt email when a refund settles.
// Invoked by terminal-refund (synchronous success path) and
// stripe-refund-webhook (async settlement path) — both pass the
// lng_payment_refunds.id; this function hydrates the rest.
//
// Idempotent: if the row already has refund_email_sent_at set, the
// function no-ops and returns ok:true with alreadySent:true.
//
// Auth: service-role only. Callers carry the SERVICE_ROLE bearer
// (terminal-refund already runs under it; the webhook ditto). No
// patient-facing route — staff don't manually send these.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import {
  loadBrand,
  loadTemplate,
  renderAndSend,
} from '../_shared/emailRenderer.ts';
import { recordEmailMessage } from '../_shared/emailRecord.ts';
import { properCase } from '../_shared/properCase.ts';
import { getEmailSenderHeaders } from '../_shared/emailSender.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';

const TEMPLATE_KEY = 'refund_receipt';

const REASON_CATEGORY_LABELS: Record<string, string> = {
  item_removed: 'Item removed from your cart',
  visit_cancelled: 'Visit cancelled',
  visit_ended_early: 'Visit ended early',
  service_not_delivered: 'Service couldn’t be delivered',
  patient_request: 'Refund requested',
  cart_correction: 'Cart correction',
  other: 'Refund issued',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders(),
    });
  }
  if (req.method !== 'POST') return j(405, { ok: false, error: 'Method not allowed' });

  let body: { refundId?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (!body.refundId) return j(400, { ok: false, error: 'refundId required' });

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── 1. Hydrate the refund row ──────────────────────────────
  const { data: refundRow, error: rErr } = await supabase
    .from('lng_payment_refunds')
    .select(
      'id, payment_id, deposit_appointment_id, amount_pence, currency, method, status, reason_category, reason_note, refunded_at, visit_id, appointment_id',
    )
    .eq('id', body.refundId)
    .maybeSingle();
  if (rErr || !refundRow) return j(404, { ok: false, error: 'Refund not found' });
  const refund = refundRow as {
    id: string;
    payment_id: string | null;
    deposit_appointment_id: string | null;
    amount_pence: number;
    currency: string;
    method: string;
    status: string;
    reason_category: string;
    reason_note: string;
    refunded_at: string;
    visit_id: string | null;
    appointment_id: string | null;
  };

  if (refund.status !== 'succeeded') {
    return j(409, {
      ok: false,
      error: `Refund is not yet succeeded (status: ${refund.status})`,
    });
  }

  // ── 2. Resolve the patient ────────────────────────────────
  let patientId: string | null = null;
  if (refund.visit_id) {
    const { data } = await supabase
      .from('lng_visits')
      .select('patient_id')
      .eq('id', refund.visit_id)
      .maybeSingle();
    patientId = (data as { patient_id: string | null } | null)?.patient_id ?? null;
  }
  if (!patientId && (refund.appointment_id || refund.deposit_appointment_id)) {
    const apptId = refund.appointment_id ?? refund.deposit_appointment_id;
    const { data } = await supabase
      .from('lng_appointments')
      .select('patient_id')
      .eq('id', apptId)
      .maybeSingle();
    patientId = (data as { patient_id: string | null } | null)?.patient_id ?? null;
  }
  if (!patientId) {
    return j(404, { ok: false, error: 'Could not resolve patient' });
  }

  const { data: patientRow } = await supabase
    .from('patients')
    .select('id, first_name, email, location_id')
    .eq('id', patientId)
    .maybeSingle();
  const patient = patientRow as {
    id: string;
    first_name: string | null;
    email: string | null;
    location_id: string | null;
  } | null;
  if (!patient?.email) {
    return j(200, { ok: false, reason: 'no_email' });
  }

  // ── 3. Load template + brand ──────────────────────────────
  const template = await loadTemplate(supabase, TEMPLATE_KEY);
  if (!template || !template.enabled) {
    return j(200, { ok: false, reason: 'template_disabled' });
  }
  const brand = await loadBrand(supabase);

  // ── 4. Render variables ────────────────────────────────────
  const isDeposit = refund.deposit_appointment_id != null;
  const isCardRefund = refund.method === 'card_terminal';
  // Method-specific settlement timing copy. Card refunds (including
  // every deposit refund, which always goes via Stripe) get the
  // "5 to 10 working days" note; cash gets the in-hand line; other
  // methods (gift card, account credit) get no line at all rather
  // than a misleading one.
  const settlementNote =
    isCardRefund || isDeposit
      ? 'Card refunds usually appear within 5 to 10 working days, depending on your bank.'
      : refund.method === 'cash'
        ? 'The refund has been handed back to you at the till, so there’s no bank delay.'
        : '';
  const variables: Record<string, string> = {
    patientFirstName: properCase(patient.first_name?.trim() ?? '') || 'there',
    refundAmount: formatGbp(refund.amount_pence, refund.currency),
    refundMethod: humaniseMethod(refund.method, isDeposit),
    refundDate: formatDate(refund.refunded_at),
    reasonNote: refund.reason_note.trim() ||
      REASON_CATEGORY_LABELS[refund.reason_category] ||
      'No reason recorded',
    reference: refund.id.split('-')[0]?.toUpperCase() ?? refund.id,
    settlementNote,
  };

  // ── 5. Resend ──────────────────────────────────────────────
  if (!RESEND_API_KEY) {
    return j(200, { ok: false, reason: 'delivery_not_configured' });
  }
  const sender = await getEmailSenderHeaders(supabase);
  const send = await renderAndSend({
    apiKey: RESEND_API_KEY,
    from: sender.from,
    replyTo: sender.replyTo,
    to: patient.email,
    template,
    brand,
    variables,
  });
  if (!send.ok) {
    await logFailure('refund_receipt_send_failed', {
      refund_id: refund.id,
      error: send.error,
    });
    return j(502, { ok: false, error: send.error });
  }

  // ── 6. Record the message + flag the refund as emailed ──
  // recordEmailMessage returns the row id directly (null on
  // failure) so the patient timeline's "View email" button can
  // fetch the row later.
  const messageId = await recordEmailMessage(supabase, {
    patient_id: patient.id,
    location_id: patient.location_id,
    appointment_id: refund.appointment_id,
    visit_id: refund.visit_id,
    kind: 'refund_receipt',
    template_key: TEMPLATE_KEY,
    subject: send.subject,
    to_email: patient.email,
    from_email: sender.from,
    reply_to: sender.replyTo,
    provider: 'resend',
    provider_message_id: send.messageId ?? null,
    send_status: 'sent',
    html: send.html,
    body_text: send.text,
  });
  if (!messageId) {
    await logFailure('refund_receipt_record_failed', {
      refund_id: refund.id,
      reason: 'recordEmailMessage returned null',
    });
  }

  // patient_events trail — keeps "refund email sent" alongside
  // the original 'refund_issued' row on the timeline.
  await supabase.from('patient_events').insert({
    patient_id: patient.id,
    event_type: 'refund_receipt_sent',
    payload: {
      refund_id: refund.id,
      email: patient.email,
      message_id: messageId,
      resend_message_id: send.messageId ?? null,
    },
  });

  return j(200, { ok: true, messageId, subject: send.subject });
});

function humaniseMethod(method: string, isDeposit: boolean): string {
  if (isDeposit) return 'Original online card';
  switch (method) {
    case 'cash':
      return 'Cash';
    case 'card_terminal':
      return 'Card';
    case 'gift_card':
      return 'Gift card';
    case 'account_credit':
      return 'Account credit';
    default:
      return method;
  }
}

function formatGbp(pence: number, currency: string): string {
  const value = pence / 100;
  const formatter = new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: (currency || 'gbp').toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return formatter.format(value);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Pin Europe/London so a refund issued at 23:50 BST doesn't
  // render as the next calendar day in the receipt.
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/London',
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  };
}

function j(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

async function logFailure(
  message: string,
  context: Record<string, unknown>,
  severity: 'info' | 'warning' | 'error' | 'critical' = 'error',
) {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from('lng_system_failures').insert({
      source: 'send-refund-receipt',
      severity,
      message,
      context,
    });
  } catch {
    // best-effort
  }
}
