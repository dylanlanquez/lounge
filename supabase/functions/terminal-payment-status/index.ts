// terminal-payment-status
//
// POST { payment_id }
//
// Reconciles a Lounge lng_payments row against the source-of-truth
// PaymentIntent at Stripe. Used by:
//
//   • TerminalPaymentModal — polls every few seconds while waiting on
//     a tap so the UI doesn't sit forever if the Stripe webhook is
//     delayed, dropped, or not yet configured for the active mode
//     (live vs test). One missed webhook used to leave the till
//     spinning while the customer's card was actually captured.
//
//   • terminal-cancel-payment — checks PI status before flipping the
//     local row to cancelled, so a "stuck" cancel can't overwrite a
//     payment that Stripe has already taken.
//
// Behaviour: GET the PI, then mirror Stripe's truth into local
// state. Idempotent — re-runs against the same PI converge to the
// same row state. Same maybeFlipCartPaid logic the webhook uses, so
// a successful reconcile flips the cart to 'paid' (when the cart's
// total is met) without depending on the webhook ever arriving.
//
// Auth: PUBLIC over Bearer JWT (the modal calls it with the
// receptionist's session). RLS doesn't gate this call because we
// need service-role to write past the per-row policies on
// lng_payments — but we only act on a payment_id the caller already
// owns access to, by virtue of having received it from
// terminal-start-payment.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

interface StripePaymentIntent {
  id: string;
  status:
    | 'requires_payment_method'
    | 'requires_confirmation'
    | 'requires_action'
    | 'processing'
    | 'requires_capture'
    | 'canceled'
    | 'succeeded';
  amount: number;
  last_payment_error?: { message?: string };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return j(405, { error: 'Method not allowed' });

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return j(401, { error: 'Missing token' });

  let body: { payment_id?: string };
  try {
    body = await req.json();
  } catch {
    return j(400, { error: 'Bad JSON' });
  }
  if (!body.payment_id) return j(400, { error: 'payment_id required' });
  if (!STRIPE_SECRET_KEY) return j(500, { error: 'STRIPE_SECRET_KEY missing' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: tp, error: tpErr } = await supabase
    .from('lng_terminal_payments')
    .select('stripe_payment_intent_id, payment_id, succeeded_at')
    .eq('payment_id', body.payment_id)
    .maybeSingle();
  if (tpErr) return j(500, { error: tpErr.message });
  if (!tp) return j(404, { error: 'Terminal payment row not found' });

  const piId = (tp as { stripe_payment_intent_id: string }).stripe_payment_intent_id;

  const piRes = await fetch(`https://api.stripe.com/v1/payment_intents/${piId}`, {
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2024-10-28.acacia',
    },
  });
  const piBody = await piRes.json();
  if (!piRes.ok) {
    return j(502, { error: piBody?.error?.message ?? 'Stripe lookup failed' });
  }
  const pi = piBody as StripePaymentIntent;

  // Map Stripe → local. Treat requires_capture (pre-capture) the same
  // as succeeded for terminal flows: payment_intent_data.capture_method
  // defaults to automatic, so requires_capture only appears when the
  // caller explicitly used manual; either way the customer has paid
  // and the next webhook will be capture confirmation.
  let next: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled' | null = null;
  let succeededAt: string | null = null;
  let cancelledAt: string | null = null;
  let failureReason: string | null = null;
  if (pi.status === 'succeeded' || pi.status === 'requires_capture') {
    next = 'succeeded';
    succeededAt = new Date().toISOString();
  } else if (pi.status === 'canceled') {
    next = 'cancelled';
    cancelledAt = new Date().toISOString();
  } else if (pi.last_payment_error) {
    next = 'failed';
    failureReason = pi.last_payment_error.message ?? 'Payment failed';
  }

  if (next) {
    // Mirror onto lng_terminal_payments first.
    const tpUpdate: Record<string, unknown> = {};
    if (succeededAt && !(tp as { succeeded_at: string | null }).succeeded_at) {
      tpUpdate.succeeded_at = succeededAt;
    }
    if (Object.keys(tpUpdate).length > 0) {
      await supabase
        .from('lng_terminal_payments')
        .update(tpUpdate)
        .eq('stripe_payment_intent_id', piId);
    }

    // Then the parent lng_payments row. Idempotent: if local is already
    // at the same status, the UPDATE is a no-op (no realtime spam).
    const { data: cur } = await supabase
      .from('lng_payments')
      .select('id, status, cart_id')
      .eq('id', body.payment_id)
      .maybeSingle();
    if (cur && (cur as { status: string }).status !== next) {
      const pUpdate: Record<string, unknown> = { status: next };
      if (succeededAt) pUpdate.succeeded_at = succeededAt;
      if (cancelledAt) pUpdate.cancelled_at = cancelledAt;
      if (failureReason) pUpdate.failure_reason = failureReason;
      await supabase.from('lng_payments').update(pUpdate).eq('id', body.payment_id);
    }

    if (next === 'succeeded' && cur) {
      await maybeFlipCartPaid(supabase, (cur as { cart_id: string }).cart_id);
    }
  }

  return j(200, {
    payment_id: body.payment_id,
    stripe_status: pi.status,
    local_status: next,
    amount: pi.amount,
  });
});

async function maybeFlipCartPaid(
  supabase: ReturnType<typeof createClient>,
  cartId: string,
) {
  const { data: cart } = await supabase
    .from('lng_carts')
    .select('total_pence, status, visit_id')
    .eq('id', cartId)
    .maybeSingle();
  if (!cart) return;
  const c = cart as { total_pence: number | null; status: string; visit_id: string };
  if (c.status === 'paid' || c.status === 'voided') return;
  if (c.total_pence == null || c.total_pence <= 0) return;

  const { data: rows } = await supabase
    .from('lng_payments')
    .select('amount_pence')
    .eq('cart_id', cartId)
    .eq('status', 'succeeded');
  const succeeded = ((rows ?? []) as { amount_pence: number }[]).reduce(
    (s, r) => s + r.amount_pence,
    0,
  );

  // Add the appointment deposit (when paid) to the comparison so a
  // partial till payment topping up over the deposit still flips the
  // cart.
  let depositPaid = 0;
  const { data: visit } = await supabase
    .from('lng_visits')
    .select('appointment_id')
    .eq('id', c.visit_id)
    .maybeSingle();
  const v = visit as { appointment_id: string | null } | null;
  if (v?.appointment_id) {
    const { data: appt } = await supabase
      .from('lng_appointments')
      .select('deposit_pence, deposit_status')
      .eq('id', v.appointment_id)
      .maybeSingle();
    const a = appt as { deposit_pence: number | null; deposit_status: string | null } | null;
    if (a?.deposit_status === 'paid' && typeof a.deposit_pence === 'number') {
      depositPaid = a.deposit_pence;
    }
  }

  if (succeeded + depositPaid < c.total_pence) return;

  await supabase
    .from('lng_carts')
    .update({ status: 'paid', closed_at: new Date().toISOString() })
    .eq('id', cartId);
}

function j(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
