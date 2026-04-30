// terminal-cancel-payment
//
// POST { payment_id }
// Cancels an in-progress reader action mid-transaction.
//
// SAFETY: Before flipping the local row to 'cancelled' we GET the
// PaymentIntent at Stripe. If it's already 'succeeded' or
// 'requires_capture' the customer has actually paid — we mirror
// that into local state instead of cancelling, and return a 409 so
// the UI can show the success path. Without this guard a stuck
// modal + a "Cancel payment" tap could overwrite a captured
// payment as cancelled, and Lounge would think there's still a
// balance to collect — risk of double-charging the patient.

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
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return j(401, { ok: false, message: 'Missing token' });

  let body: { payment_id?: string };
  try {
    body = await req.json();
  } catch {
    return j(400, { ok: false, message: 'Bad JSON' });
  }
  if (!body.payment_id) return j(400, { ok: false, message: 'payment_id required' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: tp } = await supabase
    .from('lng_terminal_payments')
    .select('stripe_reader_id, stripe_payment_intent_id, payment_id, succeeded_at')
    .eq('payment_id', body.payment_id)
    .maybeSingle();
  if (!tp) return j(404, { ok: false, message: 'Terminal payment not found' });

  const piId = (tp as { stripe_payment_intent_id: string }).stripe_payment_intent_id;

  // 1. Pre-flight: ask Stripe what happened to this PI before we do
  //    anything destructive locally. If the PI already succeeded the
  //    customer has paid — we MUST NOT cancel the local row. Reconcile
  //    instead so the UI flips to the success state.
  if (STRIPE_SECRET_KEY) {
    const piRes = await fetch(`https://api.stripe.com/v1/payment_intents/${piId}`, {
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Stripe-Version': '2024-10-28.acacia',
      },
    });
    if (piRes.ok) {
      const pi = (await piRes.json()) as StripePaymentIntent;
      if (pi.status === 'succeeded' || pi.status === 'requires_capture') {
        const succeededAt = new Date().toISOString();
        if (!(tp as { succeeded_at: string | null }).succeeded_at) {
          await supabase
            .from('lng_terminal_payments')
            .update({ succeeded_at: succeededAt })
            .eq('stripe_payment_intent_id', piId);
        }
        const { data: cur } = await supabase
          .from('lng_payments')
          .select('id, status, cart_id')
          .eq('id', body.payment_id)
          .maybeSingle();
        if (cur && (cur as { status: string }).status !== 'succeeded') {
          await supabase
            .from('lng_payments')
            .update({ status: 'succeeded', succeeded_at: succeededAt })
            .eq('id', body.payment_id);
        }
        if (cur) {
          await maybeFlipCartPaid(supabase, (cur as { cart_id: string }).cart_id);
        }
        return j(409, {
          ok: false,
          already_succeeded: true,
          message: 'Payment already captured at Stripe; reconciled to succeeded.',
        });
      }
    }
    // If the lookup failed we fall through to the cancel attempt — the
    // safer default is to surface a cancel error than to silently
    // claim success on a Stripe-side anomaly.
  }

  // 2. Cancel the reader action. Idempotent on Stripe's side.
  const cancelRes = await fetch(
    `https://api.stripe.com/v1/terminal/readers/${(tp as { stripe_reader_id: string }).stripe_reader_id}/cancel_action`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Stripe-Version': '2024-10-28.acacia',
      },
    },
  );
  // Reader may not have an active action (already finished). Treat
  // 4xx other than auth/server errors as soft-failures — we still want
  // to mark the local row cancelled so the till isn't stuck.
  if (cancelRes.status >= 500) {
    return j(502, { ok: false, message: 'Stripe cancel_action failed' });
  }

  await supabase
    .from('lng_payments')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', body.payment_id);

  return j(200, { ok: true });
});

async function maybeFlipCartPaid(
  supabase: ReturnType<typeof createClient>,
  cartId: string,
) {
  const { data: cart } = await supabase
    .from('lng_carts')
    .select('total_pence, status')
    .eq('id', cartId)
    .maybeSingle();
  if (!cart) return;
  const c = cart as { total_pence: number | null; status: string };
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
  if (succeeded < c.total_pence) return;

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
