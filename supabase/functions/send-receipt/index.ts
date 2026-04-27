// send-receipt
//
// Renders + delivers a previously-queued receipt row via Resend (email) or
// Twilio (SMS). Idempotent: re-calling on a receipt with sent_at already set
// is a no-op.
//
// Auth: anon-key Bearer JWT. The caller (the Lounge app, signed-in user)
// invokes this immediately after writing a row to lng_receipts with
// channel='email' or 'sms' and sent_at=null.
//
// Body: { receiptId: uuid }
//
// If RESEND_API_KEY / TWILIO_* env vars are not set, the function returns
// ok:false with reason='delivery_not_configured' so the UI can surface
// "queued, not yet delivered" instead of silently passing.
//
// Per brief §5.9 (slice 13b).

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_FROM = Deno.env.get('RESEND_FROM_EMAIL') ?? 'receipts@venneir.com';

const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const TWILIO_FROM = Deno.env.get('TWILIO_FROM_NUMBER') ?? '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders(),
    });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) return jsonResponse(401, { ok: false, error: 'No bearer token' });

  // Caller must be signed-in. Use the user's JWT to pass an RLS-validated check.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) return jsonResponse(401, { ok: false, error: 'Not signed in' });

  let body: { receiptId?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const receiptId = body.receiptId;
  if (!receiptId) return jsonResponse(400, { ok: false, error: 'receiptId required' });

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Hydrate the receipt + payment + cart/items + patient
  const { data: receiptRow, error: rErr } = await supabase
    .from('lng_receipts')
    .select('id, payment_id, channel, recipient, sent_at, content')
    .eq('id', receiptId)
    .maybeSingle();
  if (rErr || !receiptRow) return jsonResponse(404, { ok: false, error: 'receipt not found' });
  const receipt = receiptRow as ReceiptRow;
  if (receipt.sent_at) {
    return jsonResponse(200, { ok: true, alreadySent: true });
  }

  const { data: paymentRow, error: pErr } = await supabase
    .from('lng_payments')
    .select('id, amount_pence, method, payment_journey, status, succeeded_at, cart_id')
    .eq('id', receipt.payment_id)
    .maybeSingle();
  if (pErr || !paymentRow) return jsonResponse(404, { ok: false, error: 'payment not found' });
  const payment = paymentRow as PaymentRow;

  // Derive patient via cart → visit → patient. lng_payments has no direct
  // patient_id; the cart is keyed on visit_id and the visit is keyed on patient.
  const { data: cartRow } = await supabase
    .from('lng_carts')
    .select('id, visit_id, total_pence')
    .eq('id', payment.cart_id)
    .maybeSingle();
  const cart = cartRow as { id: string; visit_id: string; total_pence: number } | null;

  const { data: visitRow } = cart
    ? await supabase.from('lng_visits').select('id, patient_id').eq('id', cart.visit_id).maybeSingle()
    : { data: null };
  const visit = visitRow as { id: string; patient_id: string } | null;

  const { data: itemRows } = await supabase
    .from('lng_cart_items')
    .select('name, description, quantity, unit_price_pence, line_total_pence, discount_pence')
    .eq('cart_id', payment.cart_id)
    .order('created_at');
  const items = (itemRows ?? []) as ReceiptItem[];

  const { data: patientRow } = visit
    ? await supabase
        .from('patients')
        .select('first_name, last_name, email, phone')
        .eq('id', visit.patient_id)
        .maybeSingle()
    : { data: null };
  const patient = patientRow as { first_name: string | null; last_name: string | null; email: string | null; phone: string | null } | null;
  const patientId = visit?.patient_id ?? null;

  const recipient =
    receipt.recipient ??
    (receipt.channel === 'email' ? patient?.email ?? null : receipt.channel === 'sms' ? patient?.phone ?? null : null);

  if (!recipient) {
    await supabase
      .from('lng_receipts')
      .update({ failure_reason: 'no recipient' })
      .eq('id', receipt.id);
    return jsonResponse(400, { ok: false, error: 'no recipient on receipt or patient' });
  }

  const totalPence = cart?.total_pence ?? payment.amount_pence;
  const subjectMethod =
    payment.payment_journey === 'klarna' ? 'Klarna' :
    payment.payment_journey === 'clearpay' ? 'Clearpay' :
    payment.method === 'cash' ? 'Cash' : 'Card';
  const subject = `Your Venneir Lounge receipt · ${formatPence(totalPence)} · ${subjectMethod}`;

  const html = renderHtml({ items, totalPence, subjectMethod, payment, patient });
  const text = renderText({ items, totalPence, subjectMethod, payment, patient });

  // 2. Deliver
  let deliveryResult: { ok: true; provider: string; messageId?: string } | { ok: false; error: string };
  if (receipt.channel === 'email') {
    deliveryResult = await sendEmail(recipient, subject, html, text);
  } else if (receipt.channel === 'sms') {
    deliveryResult = await sendSms(recipient, text);
  } else {
    deliveryResult = { ok: false, error: `channel ${receipt.channel} not deliverable` };
  }

  // 3. Persist outcome
  if (!deliveryResult.ok) {
    await supabase
      .from('lng_receipts')
      .update({ failure_reason: deliveryResult.error, content: { ...receipt.content, html, text } })
      .eq('id', receipt.id);
    return jsonResponse(200, { ok: false, error: deliveryResult.error });
  }

  await supabase
    .from('lng_receipts')
    .update({
      sent_at: new Date().toISOString(),
      recipient,
      content: { ...receipt.content, html, text, provider: deliveryResult.provider, messageId: deliveryResult.messageId },
      failure_reason: null,
    })
    .eq('id', receipt.id);

  if (patientId) {
    await supabase.from('patient_events').insert({
      patient_id: patientId,
      event_type: 'receipt_sent',
      payload: { receipt_id: receipt.id, channel: receipt.channel, recipient, payment_id: payment.id },
    });
  }

  return jsonResponse(200, { ok: true, channel: receipt.channel, recipient, provider: deliveryResult.provider });
});

// ---------- Senders ----------

async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text: string
): Promise<{ ok: true; provider: string; messageId?: string } | { ok: false; error: string }> {
  if (!RESEND_API_KEY) return { ok: false, error: 'delivery_not_configured: RESEND_API_KEY unset' };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html, text }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: `Resend ${r.status}: ${JSON.stringify(body)}` };
  return { ok: true, provider: 'resend', messageId: (body as { id?: string }).id };
}

async function sendSms(
  to: string,
  text: string
): Promise<{ ok: true; provider: string; messageId?: string } | { ok: false; error: string }> {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    return { ok: false, error: 'delivery_not_configured: TWILIO_* unset' };
  }
  const auth = btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`);
  const params = new URLSearchParams({ From: TWILIO_FROM, To: to, Body: text });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: `Twilio ${r.status}: ${(body as { message?: string }).message ?? 'failed'}` };
  return { ok: true, provider: 'twilio', messageId: (body as { sid?: string }).sid };
}

// ---------- Render ----------

interface ReceiptContext {
  items: ReceiptItem[];
  totalPence: number;
  subjectMethod: string;
  payment: PaymentRow;
  patient: { first_name: string | null; last_name: string | null } | null;
}

function renderHtml({ items, totalPence, subjectMethod, payment, patient }: ReceiptContext): string {
  const name = patient ? `${patient.first_name ?? ''} ${patient.last_name ?? ''}`.trim() : '';
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const lineRows = items
    .map(
      (i) => `
        <tr>
          <td style="padding: 8px 0; color: #0E1414;">${escapeHtml(i.name)}${i.quantity > 1 ? ` × ${i.quantity}` : ''}</td>
          <td style="padding: 8px 0; text-align: right; font-variant-numeric: tabular-nums; color: #0E1414;">${formatPence(i.line_total_pence)}</td>
        </tr>`
    )
    .join('');
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F7F6F2;font-family: -apple-system, system-ui, sans-serif;color:#0E1414;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;">
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;">Receipt from Venneir Lounge</h1>
    <p style="margin:0 0 24px;color:#5A6266;">${greeting} thanks for stopping by. Here's your receipt.</p>
    <table style="width:100%;border-collapse:collapse;">
      ${lineRows}
      <tr><td colspan="2" style="border-top:1px solid #E5E2DC;padding-top:12px;"></td></tr>
      <tr>
        <td style="padding:8px 0;font-weight:600;">Total</td>
        <td style="padding:8px 0;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${formatPence(totalPence)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#5A6266;font-size:14px;">Paid by</td>
        <td style="padding:8px 0;text-align:right;color:#5A6266;font-size:14px;">${subjectMethod}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#5A6266;font-size:14px;">Reference</td>
        <td style="padding:8px 0;text-align:right;color:#5A6266;font-size:14px;font-variant-numeric:tabular-nums;">${payment.id.slice(0, 8)}</td>
      </tr>
    </table>
    <p style="margin:32px 0 0;color:#7B8285;font-size:12px;">Venneir Limited · Questions? Reply to this email.</p>
  </div>
</body></html>`;
}

function renderText({ items, totalPence, subjectMethod, payment, patient }: ReceiptContext): string {
  const name = patient ? `${patient.first_name ?? ''} ${patient.last_name ?? ''}`.trim() : '';
  const lines = items
    .map((i) => `${i.name}${i.quantity > 1 ? ` x${i.quantity}` : ''}  ${formatPence(i.line_total_pence)}`)
    .join('\n');
  return `Venneir Lounge receipt
${name ? `Hi ${name},\n` : ''}
${lines}
---
Total: ${formatPence(totalPence)}
Paid by: ${subjectMethod}
Ref: ${payment.id.slice(0, 8)}

Venneir Limited`;
}

// ---------- helpers ----------

interface ReceiptRow {
  id: string;
  payment_id: string;
  channel: 'email' | 'sms' | 'print' | 'none';
  recipient: string | null;
  sent_at: string | null;
  content: Record<string, unknown> | null;
}

interface PaymentRow {
  id: string;
  amount_pence: number;
  method: string;
  payment_journey: string | null;
  status: string;
  succeeded_at: string | null;
  cart_id: string;
}

interface ReceiptItem {
  name: string;
  description: string | null;
  quantity: number;
  unit_price_pence: number;
  line_total_pence: number;
  discount_pence: number;
}

function formatPence(p: number): string {
  return `£${(p / 100).toFixed(2)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
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
