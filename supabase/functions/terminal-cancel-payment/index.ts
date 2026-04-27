// terminal-cancel-payment
//
// POST { payment_id }
// Cancels an in-progress reader action mid-transaction.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
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
  if (!auth.startsWith('Bearer ')) return j(401, 'Missing token');

  let body: { payment_id?: string };
  try {
    body = await req.json();
  } catch {
    return j(400, 'Bad JSON');
  }
  if (!body.payment_id) return j(400, 'payment_id required');

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: tp } = await supabase
    .from('lng_terminal_payments')
    .select('stripe_reader_id, stripe_payment_intent_id')
    .eq('payment_id', body.payment_id)
    .maybeSingle();
  if (!tp) return j(404, 'Terminal payment not found');

  // Cancel the reader action
  const cancelRes = await fetch(
    `https://api.stripe.com/v1/terminal/readers/${(tp as { stripe_reader_id: string }).stripe_reader_id}/cancel_action`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Stripe-Version': '2024-10-28.acacia',
      },
    }
  );
  if (!cancelRes.ok) {
    return j(502, 'Stripe cancel_action failed');
  }

  // Optimistically mark cancelled. The webhook will confirm.
  await supabase
    .from('lng_payments')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', body.payment_id);

  return j(200, 'ok');
});

function j(status: number, msg: string) {
  return new Response(JSON.stringify({ ok: status === 200, message: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
