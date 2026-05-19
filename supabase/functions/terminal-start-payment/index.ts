// terminal-start-payment
//
// POST { visit_id, amount_pence, reader_id, payment_journey? }
//
// Creates a Stripe PaymentIntent, sends it to the reader, inserts
// lng_payments + lng_terminal_payments rows, returns { payment_id }.
//
// Per `01-architecture-decision.md §3.5` and brief §5.5.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_EXPECTED_ACCOUNT_ID = Deno.env.get('STRIPE_EXPECTED_ACCOUNT_ID') ?? '';

const STRIPE_BASE = 'https://api.stripe.com/v1';

interface StartPaymentBody {
  visit_id: string;
  amount_pence: number;
  reader_id: string;
  payment_journey?: 'standard' | 'klarna' | 'clearpay';
  // Client-supplied UUID that stays stable across HTTP retries of
  // the same user gesture. Anchors the Stripe idempotency key so a
  // network flake that retries the request lands on the SAME
  // PaymentIntent (Stripe returns the cached PI on matching key)
  // and the SAME lng_terminal_payments row (unique constraint on
  // idempotency_key short-circuits the duplicate insert).
  //
  // The previous shape derived the idem key from `count(*)`, which
  // two parallel requests both read as the same value — fine on
  // the way out (Stripe dedupes) but a SUBSEQUENT retry would read
  // count+1 and mint a fresh PI, double-charging the patient. With
  // a client-stable attempt_id that path is closed.
  //
  // Optional for backwards compatibility — callers that omit it
  // fall back to the legacy count-based key (still safer than
  // nothing thanks to the unique constraint on idempotency_key,
  // just open to the retry-double-charge edge case above).
  attempt_id?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors();
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (!STRIPE_SECRET_KEY) {
    await logFailure('stripe_secret_key_missing', {});
    return jsonError(500, 'STRIPE_SECRET_KEY not set');
  }

  // Auth: must have a user JWT.
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return jsonError(401, 'Missing token');

  let body: StartPaymentBody;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Bad JSON');
  }
  if (!body.visit_id || !body.reader_id || !Number.isFinite(body.amount_pence) || body.amount_pence <= 0) {
    return jsonError(400, 'visit_id, reader_id, amount_pence (positive int) required');
  }

  // Account ID assertion.
  const account = await stripeFetch('GET', '/account');
  if (!account.ok) {
    await logFailure('stripe_account_fetch_failed', { error: account.body });
    return jsonError(502, 'Stripe account fetch failed');
  }
  const accountId = (account.body as { id?: string }).id;
  if (STRIPE_EXPECTED_ACCOUNT_ID && accountId !== STRIPE_EXPECTED_ACCOUNT_ID) {
    await logFailure('stripe_account_mismatch', { expected: STRIPE_EXPECTED_ACCOUNT_ID, actual: accountId }, 'critical');
    return jsonError(500, 'Wrong Stripe account');
  }

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });

  // Fetch the receptionist's account_id (for taken_by attribution)
  const { data: meRow } = await userClient.rpc('auth_account_id');
  const taken_by = (meRow as string | null) ?? null;

  // Look up the cart for the visit
  const { data: cart, error: cartErr } = await supabase
    .from('lng_carts')
    .select('id, total_pence, status')
    .eq('visit_id', body.visit_id)
    .maybeSingle();
  if (cartErr || !cart) return jsonError(404, 'Cart not found');
  if (cart.status !== 'open') return jsonError(409, `Cart status ${cart.status} not open`);
  if (cart.total_pence == null || cart.total_pence <= 0) {
    return jsonError(409, 'Cart has no total to charge');
  }
  // Sum succeeded payments so far so split payments work: a £100
  // bill could already have £40 cash on it; this card amount must
  // be ≤ the £60 outstanding, not == the £100 cart total.
  const { data: priorRows } = await supabase
    .from('lng_payments')
    .select('amount_pence')
    .eq('cart_id', cart.id)
    .eq('status', 'succeeded');
  const succeededSoFar = ((priorRows ?? []) as { amount_pence: number }[]).reduce(
    (s, r) => s + r.amount_pence,
    0
  );
  const outstanding = cart.total_pence - succeededSoFar;
  if (body.amount_pence <= 0) {
    return jsonError(409, `Amount ${body.amount_pence} must be positive`);
  }
  if (body.amount_pence > outstanding) {
    return jsonError(
      409,
      `Amount ${body.amount_pence} exceeds outstanding balance ${outstanding}`
    );
  }

  // Look up reader
  const { data: reader, error: readerErr } = await supabase
    .from('lng_terminal_readers')
    .select('stripe_reader_id, stripe_location_id, status')
    .eq('id', body.reader_id)
    .maybeSingle();
  if (readerErr || !reader) return jsonError(404, 'Reader not found');

  const journey = body.payment_journey ?? 'standard';

  // Idempotency key: prefer client-supplied attempt_id (UUID stable
  // across retries of the same user gesture); fall back to the legacy
  // attempt-count scheme for callers that haven't been updated yet.
  // Client-supplied IDs are normalised to a UUID-like shape so a
  // hostile body can't craft a collision against another cart.
  let idemKey: string;
  if (body.attempt_id && /^[0-9a-fA-F-]{8,64}$/.test(body.attempt_id)) {
    idemKey = `cart_${cart.id}_${body.attempt_id}`;
  } else {
    const { count: attemptCount } = await supabase
      .from('lng_payments')
      .select('*', { count: 'exact', head: true })
      .eq('cart_id', cart.id);
    idemKey = `cart_${cart.id}_attempt_${(attemptCount ?? 0) + 1}`;
  }

  // Pre-check: if a terminal payment with this idempotency_key
  // already exists, this is a retry of an in-flight request and we
  // should return the existing payment + PI rather than minting a
  // new one. lng_terminal_payments.idempotency_key has a UNIQUE
  // constraint so the catch path below is the absolute safety net;
  // this pre-check just lets the client see a 200 instead of a 500
  // on a clean retry.
  {
    const { data: existing } = await supabase
      .from('lng_terminal_payments')
      .select('payment_id, stripe_payment_intent_id')
      .eq('idempotency_key', idemKey)
      .maybeSingle();
    const ex = existing as { payment_id: string; stripe_payment_intent_id: string } | null;
    if (ex) {
      return new Response(
        JSON.stringify({ payment_id: ex.payment_id, payment_intent_id: ex.stripe_payment_intent_id }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
      );
    }
  }

  // Create PaymentIntent. payment_method_types branches on journey:
  //
  //   • klarna → 'klarna'. Stripe's Klarna+Terminal integration
  //     (changelog 2026-04-22) returns a klarna_display_qr_code
  //     next_action and the S700 reader displays the QR for the
  //     customer to scan. Confirmation flows through the same
  //     payment_intent.succeeded webhook as card payments.
  //
  //   • standard / clearpay → 'card_present'. Card taps and
  //     Clearpay's virtual Visa both ride the card_present rail.
  //
  // Reader stage (process_payment_intent) below stays the same —
  // Stripe routes the PI to the reader regardless of method.
  const paymentMethodType = journey === 'klarna' ? 'klarna' : 'card_present';
  const piRes = await stripeFetch('POST', '/payment_intents', {
    amount: String(body.amount_pence),
    currency: 'gbp',
    'payment_method_types[]': paymentMethodType,
    capture_method: 'automatic',
    'metadata[visit_id]': body.visit_id,
    'metadata[cart_id]': cart.id,
    'metadata[payment_journey]': journey,
  }, idemKey);
  if (!piRes.ok) {
    await logFailure('payment_intent_create_failed', { error: piRes.body });
    return jsonError(502, 'PaymentIntent failed');
  }
  const pi = piRes.body as { id: string };

  // Insert lng_payments + lng_terminal_payments
  const { data: payment, error: payErr } = await supabase
    .from('lng_payments')
    .insert({
      cart_id: cart.id,
      method: 'card_terminal',
      payment_journey: journey,
      amount_pence: body.amount_pence,
      status: 'processing',
      taken_by,
    })
    .select('id')
    .single();
  if (payErr || !payment) {
    await logFailure('lng_payments_insert_failed', { error: payErr?.message });
    return jsonError(500, 'DB write failed');
  }

  const { error: tpErr } = await supabase.from('lng_terminal_payments').insert({
    payment_id: payment.id,
    stripe_payment_intent_id: pi.id,
    stripe_reader_id: reader.stripe_reader_id,
    stripe_location_id: reader.stripe_location_id,
    idempotency_key: idemKey,
  });
  if (tpErr) {
    // Most likely a unique-constraint hit on idempotency_key — two
    // concurrent requests with the same attempt_id raced past the
    // pre-check above. Re-read the winner's row and return it; the
    // PI created above is a duplicate of the winner's PI (Stripe
    // dedupes on the same idem key) so the patient is not double-
    // charged.
    if ((tpErr as { code?: string }).code === '23505') {
      const { data: winner } = await supabase
        .from('lng_terminal_payments')
        .select('payment_id, stripe_payment_intent_id')
        .eq('idempotency_key', idemKey)
        .maybeSingle();
      const w = winner as { payment_id: string; stripe_payment_intent_id: string } | null;
      if (w) {
        // Roll back our own losing lng_payments row so a second row
        // doesn't pollute the cart's payment list.
        await supabase.from('lng_payments').delete().eq('id', payment.id);
        return new Response(
          JSON.stringify({ payment_id: w.payment_id, payment_intent_id: w.stripe_payment_intent_id }),
          { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
        );
      }
    }
    await logFailure('lng_terminal_payments_insert_failed', { error: tpErr.message });
    return jsonError(500, 'DB write failed');
  }

  // Tell the reader to process this PaymentIntent.
  const procRes = await stripeFetch(
    'POST',
    `/terminal/readers/${reader.stripe_reader_id}/process_payment_intent`,
    { payment_intent: pi.id }
  );
  if (!procRes.ok) {
    // Mark payment as failed and bubble up
    await supabase
      .from('lng_payments')
      .update({ status: 'failed', failure_reason: 'reader_could_not_process' })
      .eq('id', payment.id);
    await logFailure('reader_process_failed', { error: procRes.body });
    return jsonError(502, 'Reader could not process');
  }

  return new Response(JSON.stringify({ payment_id: payment.id, payment_intent_id: pi.id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
});

// ---------- helpers ----------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function cors(): Response {
  return new Response('ok', { headers: CORS_HEADERS });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function stripeFetch(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, string>,
  idempotencyKey?: string
): Promise<{ ok: boolean; body: unknown }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
    'Stripe-Version': '2024-10-28.acacia',
  };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const r = await fetch(`${STRIPE_BASE}${path}`, {
    method,
    headers,
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  let parsed: unknown = {};
  try {
    parsed = await r.json();
  } catch {
    parsed = {};
  }
  return { ok: r.ok, body: parsed };
}

async function logFailure(
  message: string,
  context: Record<string, unknown>,
  severity: 'info' | 'warning' | 'error' | 'critical' = 'error'
) {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from('lng_system_failures').insert({
      source: 'terminal-start-payment',
      severity,
      message,
      context,
    });
  } catch {
    // best-effort
  }
}
