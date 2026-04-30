// terminal-refund
//
// POST { payment_id, amount_pence?, reason? }
// Issues a Stripe refund for a card_terminal payment, OR records a
// cash refund row directly. Updates lng_payments to status='cancelled'
// (or partial — for v0 we only support full refunds).
//
// Per brief §5 (refund considerations) and §10.1 #14.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS')
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return j(401, { ok: false, error: 'Missing token' });

  let body: { payment_id?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return j(400, { ok: false, error: 'Bad JSON' });
  }
  if (!body.payment_id) return j(400, { ok: false, error: 'payment_id required' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Resolve the staff member who initiated the refund. Mirrors the
  // pattern in terminal-start-payment: anon-key client carrying the
  // request's bearer token, which RLS resolves into the auth user,
  // which auth_account_id() maps to accounts.id. Used as the
  // patient_events actor below.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });
  const { data: meRow } = await userClient.rpc('auth_account_id');
  const refundedBy = (meRow as string | null) ?? null;

  const { data: payment, error: pErr } = await supabase
    .from('lng_payments')
    .select('id, cart_id, method, payment_journey, amount_pence, status')
    .eq('id', body.payment_id)
    .maybeSingle();
  if (pErr || !payment) return j(404, { ok: false, error: 'Payment not found' });
  if (payment.status !== 'succeeded') return j(409, { ok: false, error: `Cannot refund payment in status ${payment.status}` });

  if (payment.method === 'card_terminal') {
    if (!STRIPE_SECRET_KEY) return j(500, { ok: false, error: 'STRIPE_SECRET_KEY missing' });
    const { data: tp } = await supabase
      .from('lng_terminal_payments')
      .select('stripe_payment_intent_id')
      .eq('payment_id', payment.id)
      .maybeSingle();
    if (!tp) return j(404, { ok: false, error: 'Terminal record not found' });
    const r = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        payment_intent: (tp as { stripe_payment_intent_id: string }).stripe_payment_intent_id,
        reason: body.reason === 'fraudulent' ? 'fraudulent' : 'requested_by_customer',
      }).toString(),
    });
    const refundBody = await r.json();
    if (!r.ok) return j(502, { ok: false, error: 'Stripe refund failed', detail: refundBody });
  }

  // Mark the payment as cancelled (full-refund semantics for v0)
  await supabase
    .from('lng_payments')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', payment.id);

  // Re-open the cart so a new charge could be attempted (rare, but supports edit-and-recharge)
  await supabase.from('lng_carts').update({ status: 'open', closed_at: null }).eq('id', payment.cart_id);

  // patient_events
  const { data: cart } = await supabase.from('lng_carts').select('visit_id').eq('id', payment.cart_id).maybeSingle();
  if (cart) {
    const { data: visit } = await supabase
      .from('lng_visits')
      .select('patient_id')
      .eq('id', (cart as { visit_id: string }).visit_id)
      .maybeSingle();
    if (visit) {
      await supabase.from('patient_events').insert({
        patient_id: (visit as { patient_id: string }).patient_id,
        event_type: 'refund_issued',
        actor_account_id: refundedBy,
        payload: {
          payment_id: payment.id,
          amount_pence: payment.amount_pence,
          method: payment.method,
          payment_journey: payment.payment_journey,
          reason: body.reason ?? 'requested_by_customer',
          staff_account_id: refundedBy,
        },
      });
    }
  }

  return j(200, { ok: true });
});

function j(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
