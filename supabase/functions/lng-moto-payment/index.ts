// lng-moto-payment
//
// POST { visit_id, amount_pence, payment_method_id, attempt_id? }
//
// Confirms a card-not-present (MOTO, telephone) charge. The card is collected
// on the tablet with Stripe Elements; the client creates a PaymentMethod and
// sends only its pm_ id here. This function creates AND confirms a
// PaymentIntent in one call with payment_method_options[card][moto]=true, then
// records the outcome to lng_payments + lng_moto_payments, flips the cart and
// emits the patient event inline (synchronous; no webhook dependency).
//
// Auth + Stripe access mirror the existing payment functions exactly:
//   - Bearer JWT required; the caller's account is resolved via auth_account_id
//     and stamped on lng_payments.taken_by.
//   - The Stripe secret is resolved from lng_settings.stripe.mode (test/live)
//     the same way widget-create-payment-intent does, so a test-mode backend
//     uses the test key.
//
// It deliberately does NOT set metadata.cart_id (it uses lng_cart_id), so the
// account-level terminal-webhook is a guaranteed no-op for MOTO PaymentIntents
// and this function stays the single writer of MOTO outcomes. The in-person
// terminal flow is untouched.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const STRIPE_SECRET_KEY_LEGACY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_SECRET_KEY_LIVE = Deno.env.get('STRIPE_SECRET_KEY_LIVE') ?? STRIPE_SECRET_KEY_LEGACY;
const STRIPE_SECRET_KEY_TEST = Deno.env.get('STRIPE_SECRET_KEY_TEST') ?? '';
const STRIPE_BASE = 'https://api.stripe.com/v1';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

interface Body {
  visit_id: string;
  amount_pence: number;
  payment_method_id: string;
  attempt_id?: string;
}

type Outcome = 'succeeded' | 'requires_fallback' | 'failed';
type NextAction = 'done' | 'retry' | 'fallback' | 'retry_or_fallback';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse(405, { ok: false, status: 'failed', message: 'Method not allowed', next_action: 'retry' });

  // Auth: must have a user JWT (same gate as terminal-start-payment).
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) {
    return jsonResponse(401, { ok: false, status: 'failed', message: 'You are signed out. Sign in and try again.', next_action: 'retry' });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResponse(400, { ok: false, status: 'failed', message: 'The request was malformed. Try again.', next_action: 'retry' });
  }
  if (
    !body.visit_id ||
    !body.payment_method_id ||
    !/^pm_[A-Za-z0-9]+$/.test(body.payment_method_id) ||
    !Number.isFinite(body.amount_pence) ||
    body.amount_pence <= 0
  ) {
    return jsonResponse(400, { ok: false, status: 'failed', message: 'The payment details were incomplete. Try again.', next_action: 'retry' });
  }

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });

  const stripeSecret = await resolveStripeSecret(supabase);
  if (!stripeSecret) {
    await logFailure(supabase, 'stripe_secret_key_missing', {});
    return jsonResponse(500, { ok: false, status: 'failed', message: 'Card payments are not set up. Tell support.', next_action: 'retry' });
  }

  // Caller account for taken_by attribution.
  const { data: meRow } = await userClient.rpc('auth_account_id');
  const taken_by = (meRow as string | null) ?? null;

  // Resolve + validate the cart, matching terminal-start-payment exactly so
  // split payments and overcharge protection behave identically.
  const { data: cart, error: cartErr } = await supabase
    .from('lng_carts')
    .select('id, total_pence, status')
    .eq('visit_id', body.visit_id)
    .maybeSingle();
  if (cartErr || !cart) {
    return jsonResponse(404, { ok: false, status: 'failed', message: 'This bill could not be found. Refresh and try again.', next_action: 'retry' });
  }
  if (cart.status !== 'open') {
    return jsonResponse(409, { ok: false, status: 'failed', message: 'This bill is already closed. Refresh to see its status.', next_action: 'retry' });
  }
  if (cart.total_pence == null || cart.total_pence <= 0) {
    return jsonResponse(409, { ok: false, status: 'failed', message: 'There is nothing to charge on this bill.', next_action: 'retry' });
  }

  const { data: priorRows } = await supabase
    .from('lng_payments')
    .select('amount_pence')
    .eq('cart_id', cart.id)
    .eq('status', 'succeeded');
  const succeededSoFar = ((priorRows ?? []) as { amount_pence: number }[]).reduce((s, r) => s + r.amount_pence, 0);
  const outstanding = cart.total_pence - succeededSoFar;
  if (body.amount_pence > outstanding) {
    return jsonResponse(409, { ok: false, status: 'failed', message: 'That amount is more than is left to pay on this bill.', next_action: 'retry' });
  }

  // Idempotency key, same scheme as terminal-start-payment.
  const idemKey =
    body.attempt_id && /^[0-9a-fA-F-]{8,64}$/.test(body.attempt_id)
      ? `moto_cart_${cart.id}_${body.attempt_id}`
      : `moto_cart_${cart.id}_${crypto.randomUUID()}`;

  // Retry of an in-flight attempt: return the recorded outcome rather than
  // confirming again (Stripe also dedupes on the idem key).
  const { data: existing } = await supabase
    .from('lng_moto_payments')
    .select('payment_id, stripe_payment_intent_id, decline_code, lng_payments(status, failure_reason)')
    .eq('idempotency_key', idemKey)
    .maybeSingle();
  if (existing) {
    const ex = existing as unknown as {
      payment_id: string;
      stripe_payment_intent_id: string;
      decline_code: string | null;
      lng_payments: { status: string; failure_reason: string | null } | null;
    };
    const settled = ex.lng_payments?.status === 'succeeded';
    const mapped = settled
      ? { status: 'succeeded' as Outcome, message: 'Payment taken.', next_action: 'done' as NextAction }
      : mapOutcome(ex.decline_code ?? undefined, ex.decline_code ?? undefined);
    return jsonResponse(200, {
      ok: settled,
      status: mapped.status,
      payment_id: ex.payment_id,
      payment_intent_id: ex.stripe_payment_intent_id,
      stripe_code: ex.decline_code,
      decline_code: ex.decline_code,
      message: mapped.message,
      next_action: mapped.next_action,
    });
  }

  // Create + confirm in one call. moto=true claims the MOTO exemption;
  // error_on_requires_action=true means a refused exemption comes back as a
  // clean error (handled as a fallback) instead of an open SCA redirect.
  const piRes = await stripeFetch(stripeSecret, 'POST', '/payment_intents', {
    amount: String(body.amount_pence),
    currency: 'gbp',
    confirm: 'true',
    payment_method: body.payment_method_id,
    'payment_method_types[]': 'card',
    'payment_method_options[card][moto]': 'true',
    error_on_requires_action: 'true',
    'metadata[visit_id]': body.visit_id,
    // NB: lng_cart_id, NOT cart_id. The terminal-webhook keys on
    // metadata.cart_id; omitting it keeps that webhook a no-op for MOTO.
    'metadata[lng_cart_id]': cart.id,
    'metadata[payment_journey]': 'moto',
    'metadata[source]': 'lounge_moto',
  }, idemKey);

  const succeeded = piRes.ok && (piRes.body as { status?: string }).status === 'succeeded';

  if (succeeded) {
    const pi = piRes.body as { id: string; charges?: { data?: Array<{ payment_method_details?: { card?: { brand?: string; last4?: string } } }> } };
    const card = pi.charges?.data?.[0]?.payment_method_details?.card ?? null;

    const { data: payment, error: payErr } = await supabase
      .from('lng_payments')
      .insert({
        cart_id: cart.id,
        method: 'card_moto',
        payment_journey: 'standard',
        amount_pence: body.amount_pence,
        status: 'succeeded',
        succeeded_at: new Date().toISOString(),
        taken_by,
        card_brand: card?.brand ?? null,
        card_last4: card?.last4 ?? null,
      })
      .select('id')
      .single();
    if (payErr || !payment) {
      // Money was taken but the ledger write failed. Loud failure so it is
      // reconciled by hand; never silently drop a successful charge.
      await logFailure(supabase, 'moto_payment_ledger_write_failed', { error: payErr?.message, pi: pi.id }, 'critical');
      return jsonResponse(500, {
        ok: false,
        status: 'failed',
        payment_intent_id: pi.id,
        message: 'The payment went through but did not save. Do not retry. Tell support with the reference below.',
        next_action: 'retry',
        stripe_code: 'ledger_write_failed',
      });
    }

    await supabase.from('lng_moto_payments').insert({
      payment_id: payment.id,
      stripe_payment_intent_id: pi.id,
      idempotency_key: idemKey,
      succeeded_at: new Date().toISOString(),
      raw_result: piRes.body,
    });

    await flipCartPaid(supabase, cart.id);
    await emitPatientEvent(supabase, cart.id, pi.id, 'payment_succeeded');

    return jsonResponse(200, {
      ok: true,
      status: 'succeeded',
      payment_id: payment.id,
      payment_intent_id: pi.id,
      message: 'Payment taken.',
      next_action: 'done',
    });
  }

  // Failure path. Stripe returns 402 with an error object on a decline; the
  // PaymentIntent id (if one was created) is embedded in error.payment_intent.
  const err = (piRes.body as { error?: { code?: string; decline_code?: string; message?: string; payment_intent?: { id?: string } } }).error ?? {};
  const code = err.code ?? null;
  const declineCode = err.decline_code ?? null;
  const piId = err.payment_intent?.id ?? null;
  const mapped = mapOutcome(code ?? undefined, declineCode ?? undefined);

  // Record the attempt for audit + idempotency. A failed charge leaves a
  // 'failed' lng_payments row, same as the terminal flow does via webhook.
  const { data: failRow } = await supabase
    .from('lng_payments')
    .insert({
      cart_id: cart.id,
      method: 'card_moto',
      payment_journey: 'standard',
      amount_pence: body.amount_pence,
      status: 'failed',
      failure_reason: err.message ?? code ?? 'declined',
      taken_by,
    })
    .select('id')
    .single();

  if (failRow && piId) {
    await supabase.from('lng_moto_payments').insert({
      payment_id: (failRow as { id: string }).id,
      stripe_payment_intent_id: piId,
      idempotency_key: idemKey,
      decline_code: declineCode ?? code,
      raw_result: piRes.body,
    });
  }

  if (mapped.status === 'failed' || mapped.status === 'requires_fallback') {
    await emitPatientEvent(supabase, cart.id, piId, 'payment_failed');
  }

  return jsonResponse(200, {
    ok: false,
    status: mapped.status,
    payment_id: failRow ? (failRow as { id: string }).id : null,
    payment_intent_id: piId,
    stripe_code: declineCode ?? code,
    decline_code: declineCode,
    message: mapped.message,
    next_action: mapped.next_action,
  });
});

// ---------- decline mapping (staff-facing copy; no dashes) ----------

function mapOutcome(code?: string, declineCode?: string): { status: Outcome; message: string; next_action: NextAction } {
  const key = declineCode || code || '';
  switch (key) {
    case 'insufficient_funds':
      return { status: 'failed', message: 'The card was declined for insufficient funds. Ask the patient to try another card.', next_action: 'retry_or_fallback' };
    case 'incorrect_cvc':
    case 'invalid_cvc':
      return { status: 'failed', message: 'The security code was not accepted. Re check the three digits on the back of the card and try again.', next_action: 'retry' };
    case 'expired_card':
      return { status: 'failed', message: 'This card has expired. Ask the patient for a card that is in date.', next_action: 'retry' };
    case 'incorrect_number':
    case 'invalid_number':
      return { status: 'failed', message: 'The card number was not accepted. Re read the long card number and try again.', next_action: 'retry' };
    case 'authentication_required':
      return { status: 'requires_fallback', message: 'This card needs the patient to approve the payment themselves. Use Send payment link so they can confirm.', next_action: 'fallback' };
    case 'processing_error':
      return { status: 'failed', message: 'Something went wrong on the card network, not your end. Wait a moment and try again.', next_action: 'retry' };
    case 'card_declined':
    case 'generic_decline':
    case 'do_not_honor':
    case 'transaction_not_allowed':
      return { status: 'failed', message: 'The card was declined by the bank. Ask the patient to try a different card or call their bank.', next_action: 'retry_or_fallback' };
    default:
      return { status: 'failed', message: 'The payment could not be completed. Try again or use Send payment link.', next_action: 'retry_or_fallback' };
  }
}

// ---------- shared helpers (mirrors of the webhook's logic) ----------

async function flipCartPaid(supabase: SupabaseClient, cartId: string): Promise<void> {
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
  const succeeded = ((rows ?? []) as { amount_pence: number }[]).reduce((s, r) => s + r.amount_pence, 0);

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
    if (a?.deposit_status === 'paid' && typeof a.deposit_pence === 'number') depositPaid = a.deposit_pence;
  }

  if (succeeded + depositPaid < c.total_pence) return;

  await supabase
    .from('lng_carts')
    .update({ status: 'paid', closed_at: new Date().toISOString() })
    .eq('id', cartId);
}

async function emitPatientEvent(
  supabase: SupabaseClient,
  cartId: string,
  piId: string | null,
  eventType: 'payment_succeeded' | 'payment_failed',
): Promise<void> {
  const { data: cart } = await supabase.from('lng_carts').select('visit_id').eq('id', cartId).maybeSingle();
  if (!cart) return;
  const { data: visit } = await supabase
    .from('lng_visits')
    .select('patient_id')
    .eq('id', (cart as { visit_id: string }).visit_id)
    .maybeSingle();
  if (!visit) return;
  await supabase.from('patient_events').insert({
    patient_id: (visit as { patient_id: string }).patient_id,
    event_type: eventType,
    payload: { payment_intent_id: piId, payment_journey: 'moto' },
  });
}

// ---------- low-level helpers (copied from the existing payment fns) ----------

async function resolveStripeSecret(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase
    .from('lng_settings')
    .select('value')
    .eq('key', 'stripe.mode')
    .is('location_id', null)
    .maybeSingle();
  const mode = (data?.value as string | undefined) === 'test' ? 'test' : 'live';
  return mode === 'test' ? STRIPE_SECRET_KEY_TEST : STRIPE_SECRET_KEY_LIVE;
}

async function stripeFetch(
  stripeSecret: string,
  method: 'GET' | 'POST',
  path: string,
  reqBody?: Record<string, string>,
  idempotencyKey?: string,
): Promise<{ ok: boolean; body: unknown }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${stripeSecret}`,
    'Stripe-Version': '2024-10-28.acacia',
  };
  if (reqBody) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const r = await fetch(`${STRIPE_BASE}${path}`, {
    method,
    headers,
    body: reqBody ? new URLSearchParams(reqBody).toString() : undefined,
  });
  let parsed: unknown = {};
  try {
    parsed = await r.json();
  } catch {
    parsed = {};
  }
  return { ok: r.ok, body: parsed };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function logFailure(
  supabase: SupabaseClient,
  message: string,
  context: Record<string, unknown>,
  severity: 'info' | 'warning' | 'error' | 'critical' = 'error',
): Promise<void> {
  try {
    await supabase.from('lng_system_failures').insert({ source: 'lng-moto-payment', severity, message, context });
  } catch {
    // best-effort
  }
}
