// klarna-refund
//
// POST { payment_id, amount_pence, reason_category, reason_note,
//        approver_account_id }
//
// Issues a refund against a captured Klarna order. Mirrors the
// shape of terminal-refund (Stripe path) so RefundSheet can route
// to one or the other based on payment.method.
//
// Side effects:
//   • lng_payment_refunds row inserted with status='pending',
//     method='klarna', approver + actor stamps
//   • POST {Klarna}/ordermanagement/v1/orders/{order_id}/refunds
//   • lng_payment_refunds → status='succeeded' on 2xx, 'failed'
//     otherwise (Klarna refunds settle synchronously in their API
//     unlike Stripe's async refunds)
//
// Ceiling enforcement is handled by the existing
// lng_payment_refunds_enforce_ceiling trigger — we don't need to
// gate it here.
//
// Idempotency:
//   • Klarna-Idempotency-Key on the API call is the refund row's
//     id (UUIDv4 from Postgres). A duplicate POST with the same
//     key on Klarna's side returns the original refund.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const KLARNA_API_USERNAME = Deno.env.get('KLARNA_API_USERNAME') ?? '';
const KLARNA_API_PASSWORD = Deno.env.get('KLARNA_API_PASSWORD') ?? '';
const KLARNA_API_BASE_URL = (Deno.env.get('KLARNA_API_BASE_URL') ?? 'https://api.klarna.com').replace(/\/$/, '');

interface RefundBody {
  payment_id: string;
  amount_pence: number;
  reason_category: string;
  reason_note: string;
  approver_account_id: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors();
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (!KLARNA_API_USERNAME || !KLARNA_API_PASSWORD) {
    return jsonError(500, 'Klarna credentials not configured');
  }

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return jsonError(401, 'Missing token');

  let body: RefundBody;
  try { body = await req.json(); } catch { return jsonError(400, 'Bad JSON'); }
  if (
    !body.payment_id ||
    !Number.isFinite(body.amount_pence) || body.amount_pence <= 0 ||
    !body.reason_category || !body.reason_note?.trim() ||
    !body.approver_account_id
  ) {
    return jsonError(400, 'payment_id, amount_pence (positive int), reason_category, reason_note, approver_account_id required');
  }

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });
  const { data: meRow } = await userClient.rpc('auth_account_id');
  const performedBy = (meRow as string | null) ?? null;
  if (!performedBy) return jsonError(401, 'Could not resolve actor');
  if (performedBy === body.approver_account_id) {
    return jsonError(409, 'Performer and approver must be different staff');
  }

  // Resolve the payment, its visit, and the Klarna order_id from
  // the linked session row.
  const { data: payment, error: payErr } = await supabase
    .from('lng_payments')
    .select('id, cart_id, method, amount_pence, status')
    .eq('id', body.payment_id)
    .maybeSingle();
  if (payErr || !payment) return jsonError(404, 'Payment not found');
  const pay = payment as {
    id: string;
    cart_id: string;
    method: string;
    amount_pence: number;
    status: string;
  };
  if (pay.method !== 'klarna') return jsonError(409, 'Payment is not a Klarna payment');
  if (pay.status !== 'succeeded') return jsonError(409, 'Payment not in succeeded state');

  const { data: session, error: sesErr } = await supabase
    .from('lng_klarna_sessions')
    .select('id, klarna_order_id, visit_id, cart_id')
    .eq('payment_id', pay.id)
    .maybeSingle();
  if (sesErr || !session) return jsonError(404, 'Klarna session not found');
  const ses = session as {
    id: string;
    klarna_order_id: string | null;
    visit_id: string;
    cart_id: string;
  };
  if (!ses.klarna_order_id) return jsonError(409, 'Klarna order id missing — payment not yet captured?');

  // Visit + appointment denormalisation for the refund row's
  // foreign-key handles.
  const { data: visit } = await supabase
    .from('lng_visits')
    .select('appointment_id')
    .eq('id', ses.visit_id)
    .maybeSingle();
  const appointmentId = (visit as { appointment_id: string | null } | null)?.appointment_id ?? null;

  // Insert the refund row first so the ceiling trigger fires
  // BEFORE we hit Klarna's API (and so we have a stable UUID to
  // use as the Klarna-Idempotency-Key). If insert fails (e.g.
  // ceiling exceeded), we never touch Klarna.
  const { data: refundRow, error: refErr } = await supabase
    .from('lng_payment_refunds')
    .insert({
      payment_id: pay.id,
      amount_pence: body.amount_pence,
      currency: 'gbp',
      method: 'klarna',
      status: 'pending',
      reason_category: body.reason_category,
      reason_note: body.reason_note.trim(),
      performed_by_account_id: performedBy,
      approver_account_id: body.approver_account_id,
      visit_id: ses.visit_id,
      appointment_id: appointmentId,
    })
    .select('id')
    .single();
  if (refErr || !refundRow) {
    return jsonError(409, refErr?.message ?? 'Could not record refund');
  }
  const refundId = (refundRow as { id: string }).id;

  // Klarna refund call. The Klarna-Idempotency-Key is the refund
  // row's UUID so a retry of the same gesture (network flake,
  // double-tap) hits the same Klarna refund.
  const klarnaRes = await klarnaFetch(
    'POST',
    `/ordermanagement/v1/orders/${encodeURIComponent(ses.klarna_order_id)}/refunds`,
    {
      refunded_amount: body.amount_pence,
      description: body.reason_note.trim().slice(0, 255),
    },
    refundId,
  );
  if (!klarnaRes.ok) {
    await supabase
      .from('lng_payment_refunds')
      .update({
        status: 'failed',
        failure_reason: typeof klarnaRes.body === 'object'
          ? JSON.stringify(klarnaRes.body).slice(0, 500)
          : String(klarnaRes.status),
      })
      .eq('id', refundId);
    await logFailure('klarna_refund_failed', {
      refund_id: refundId,
      klarna_order_id: ses.klarna_order_id,
      status: klarnaRes.status,
      body: klarnaRes.body,
    });
    return jsonError(502, 'Klarna refund failed');
  }

  // Klarna returns 201 Created with refund_id in headers; the
  // edge function fetch doesn't expose headers cleanly so we
  // rely on the body / status to confirm. Klarna's refund is
  // synchronous — 2xx means money's moving.
  await supabase
    .from('lng_payment_refunds')
    .update({
      status: 'succeeded',
      stripe_refund_id: null,  // not a Stripe refund
    })
    .eq('id', refundId);

  // Full-refund threshold + payment-row flip — mirrors the
  // terminal-refund flow so the cart status auto-unlocks when
  // money's been fully returned via Klarna. Reads the cumulative
  // refunded total to avoid duplicating it from the request.
  const { data: refundsSoFar } = await supabase
    .from('lng_payment_refunds')
    .select('amount_pence')
    .eq('payment_id', pay.id)
    .eq('status', 'succeeded');
  const cumulativeRefunded = ((refundsSoFar ?? []) as { amount_pence: number }[]).reduce(
    (acc, r) => acc + (r.amount_pence ?? 0),
    0,
  );
  const isFullRefund = cumulativeRefunded >= pay.amount_pence;
  if (isFullRefund) {
    await supabase
      .from('lng_payments')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', pay.id);
  }

  // Patient resolution for the timeline event. The visit's
  // appointment carries patient_id (preferred); fall back to the
  // walk-in if the visit wasn't from an appointment.
  let patientId: string | null = null;
  if (appointmentId) {
    const { data: apptRow } = await supabase
      .from('lng_appointments')
      .select('patient_id')
      .eq('id', appointmentId)
      .maybeSingle();
    patientId = (apptRow as { patient_id: string | null } | null)?.patient_id ?? null;
  }
  if (!patientId) {
    const { data: visitWalkIn } = await supabase
      .from('lng_visits')
      .select('walk_in_id')
      .eq('id', ses.visit_id)
      .maybeSingle();
    const walkInId = (visitWalkIn as { walk_in_id: string | null } | null)?.walk_in_id ?? null;
    if (walkInId) {
      const { data: walkIn } = await supabase
        .from('lng_walk_ins')
        .select('patient_id')
        .eq('id', walkInId)
        .maybeSingle();
      patientId = (walkIn as { patient_id: string | null } | null)?.patient_id ?? null;
    }
  }

  // patient_events.refund_issued — mirrors the terminal-refund
  // payload shape so the notification bell + visit timeline treat
  // every refund identically, regardless of method (cash, card,
  // Klarna, Clearpay).
  if (patientId) {
    await supabase.from('patient_events').insert({
      patient_id: patientId,
      event_type: 'refund_issued',
      actor_account_id: performedBy,
      notes: body.reason_note.trim(),
      payload: {
        refund_id: refundId,
        refund_source: 'payment',
        payment_id: pay.id,
        deposit_appointment_id: null,
        amount_pence: body.amount_pence,
        cumulative_refunded_pence: cumulativeRefunded,
        source_captured_pence: pay.amount_pence,
        is_full_refund: isFullRefund,
        method: 'klarna',
        reason_category: body.reason_category,
        reason_note: body.reason_note.trim(),
        visit_id: ses.visit_id,
        appointment_id: appointmentId,
        staff_account_id: performedBy,
        approver_account_id: body.approver_account_id,
      },
    });
  }

  return jsonOk({ refund_id: refundId, is_full_refund: isFullRefund });
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function cors(): Response { return new Response('ok', { headers: CORS_HEADERS }); }
function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
function jsonOk(extra: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, ...extra }), {
    status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function klarnaFetch(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const credentials = btoa(`${KLARNA_API_USERNAME}:${KLARNA_API_PASSWORD}`);
  const headers: Record<string, string> = {
    Authorization: `Basic ${credentials}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Klarna-Idempotency-Key'] = idempotencyKey;
  const r = await fetch(`${KLARNA_API_BASE_URL}${path}`, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown = {};
  const text = await r.text();
  if (text.length > 0) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  }
  return { ok: r.ok, status: r.status, body: parsed };
}

async function logFailure(
  message: string,
  context: Record<string, unknown>,
  severity: 'info' | 'warning' | 'error' | 'critical' = 'error',
) {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from('lng_system_failures').insert({
      source: 'klarna-refund',
      severity, message, context,
    });
  } catch { /* best-effort */ }
}
