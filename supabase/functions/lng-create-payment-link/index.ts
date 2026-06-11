// lng-create-payment-link
//
// POST { visit_id, amount_pence }
//
// Decline fallback for the "Over the phone" flow. When a MOTO charge is
// declined or the bank refuses the MOTO exemption, staff can generate a
// Stripe Payment Link for the same amount so the patient completes the
// payment themselves (read out on the call, or sent by text/email).
//
// Returns a Stripe-hosted URL. The patient pays on Stripe's page, which shows
// Stripe's own confirmation, so no app return URL is needed.
//
// NB on reconciliation: a patient-completed Payment Link settles
// asynchronously. v1 returns a working, payable link; recording that later
// payment back onto the cart needs a dedicated webhook and is a flagged
// follow-up. The PaymentIntent carries lng_cart_id + visit_id metadata so a
// future reconciler can match it. Same auth + Stripe-mode resolution as
// lng-moto-payment.

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
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse(405, { ok: false, error: 'Method not allowed' });

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return jsonResponse(401, { ok: false, error: 'You are signed out. Sign in and try again.' });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResponse(400, { ok: false, error: 'The request was malformed.' });
  }
  if (!body.visit_id || !Number.isFinite(body.amount_pence) || body.amount_pence <= 0) {
    return jsonResponse(400, { ok: false, error: 'A visit and a positive amount are required.' });
  }

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const stripeSecret = await resolveStripeSecret(supabase);
  if (!stripeSecret) {
    await logFailure(supabase, 'stripe_secret_key_missing', {});
    return jsonResponse(500, { ok: false, error: 'Card payments are not set up. Tell support.' });
  }

  // Validate the cart the same way the charge path does so a link can never
  // be raised for more than is outstanding.
  const { data: cart } = await supabase
    .from('lng_carts')
    .select('id, total_pence, status')
    .eq('visit_id', body.visit_id)
    .maybeSingle();
  if (!cart) return jsonResponse(404, { ok: false, error: 'This bill could not be found.' });
  if (cart.status !== 'open') return jsonResponse(409, { ok: false, error: 'This bill is already closed.' });

  const { data: priorRows } = await supabase
    .from('lng_payments')
    .select('amount_pence')
    .eq('cart_id', cart.id)
    .eq('status', 'succeeded');
  const succeededSoFar = ((priorRows ?? []) as { amount_pence: number }[]).reduce((s, r) => s + r.amount_pence, 0);
  const outstanding = (cart.total_pence ?? 0) - succeededSoFar;
  if (body.amount_pence > outstanding) {
    return jsonResponse(409, { ok: false, error: 'That amount is more than is left to pay on this bill.' });
  }

  // 1. One-off Price with an inline ad-hoc product.
  const priceRes = await stripeFetch(stripeSecret, 'POST', '/prices', {
    currency: 'gbp',
    unit_amount: String(body.amount_pence),
    'product_data[name]': 'Treatment payment',
  });
  if (!priceRes.ok) {
    await logFailure(supabase, 'payment_link_price_failed', { error: priceRes.body });
    return jsonResponse(502, { ok: false, error: 'The payment link could not be created. Try again.' });
  }
  const price = priceRes.body as { id: string };

  // 2. Payment Link for that price. Metadata (cart + visit) is set on both the
  // link and the resulting PaymentIntent so a future reconciler can match it.
  const linkRes = await stripeFetch(stripeSecret, 'POST', '/payment_links', {
    'line_items[0][price]': price.id,
    'line_items[0][quantity]': '1',
    'metadata[lng_cart_id]': cart.id,
    'metadata[visit_id]': body.visit_id,
    'metadata[source]': 'lounge_moto_fallback',
    'payment_intent_data[metadata][lng_cart_id]': cart.id,
    'payment_intent_data[metadata][visit_id]': body.visit_id,
    'payment_intent_data[metadata][source]': 'lounge_moto_fallback',
  });
  if (!linkRes.ok) {
    await logFailure(supabase, 'payment_link_create_failed', { error: linkRes.body });
    return jsonResponse(502, { ok: false, error: 'The payment link could not be created. Try again.' });
  }
  const link = linkRes.body as { id: string; url: string };

  // Best-effort audit; never block returning the link on a log write.
  try {
    await supabase.from('lng_event_log').insert({
      source: 'lng-create-payment-link',
      event_type: 'payment_link_created',
      payload: { visit_id: body.visit_id, cart_id: cart.id, amount_pence: body.amount_pence, payment_link_id: link.id },
    });
  } catch {
    // best-effort
  }

  return jsonResponse(200, { ok: true, url: link.url, payment_link_id: link.id });
});

// ---------- helpers ----------

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
): Promise<{ ok: boolean; body: unknown }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${stripeSecret}`,
    'Stripe-Version': '2024-10-28.acacia',
  };
  if (reqBody) headers['Content-Type'] = 'application/x-www-form-urlencoded';
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
    await supabase.from('lng_system_failures').insert({ source: 'lng-create-payment-link', severity, message, context });
  } catch {
    // best-effort
  }
}
