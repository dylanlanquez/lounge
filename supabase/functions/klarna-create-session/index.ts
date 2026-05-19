// klarna-create-session
//
// POST { visit_id, amount_pence, attempt_id? }
//
// Creates a native Klarna In-Store payment session via Klarna's
// own API (POST /payments/v1/sessions with acquiring_channel=
// 'in_store') and retrieves the QR + payment_link by calling the
// distribution.result_url Klarna gives back.
//
// Inserts lng_payments (method='klarna') + lng_klarna_sessions
// rows in the same transaction so the till's realtime subscription
// can pick the session up the moment we return.
//
// Idempotency:
//   • idempotency_key is `cart_{cart_id}_klarna_{attempt_id|count}`
//     and is sent to Klarna in the Klarna-Idempotency-Key header.
//     A retry of the same gesture hits the same Klarna session
//     and the unique-constraint pre-check + on-conflict catch
//     return the existing row rather than minting a duplicate
//     (mirrors terminal-start-payment's two-stage idempotency).
//
// Auth:
//   • Bearer JWT required (caller is a Lounge staff member taking
//     payment on the till). We resolve their account_id for
//     taken_by attribution. The Klarna credentials live in env vars
//     and are NEVER returned to the client.
//
// Env vars (set in Vercel / Supabase Edge Function secrets):
//   • KLARNA_API_USERNAME       — merchant UID
//   • KLARNA_API_PASSWORD       — secret API key (LIVE)
//   • KLARNA_API_BASE_URL       — defaults to https://api.klarna.com
//   • LOUNGE_PUBLIC_BASE_URL    — used to build the callback URL
//                                  for status_update webhooks
//                                  (e.g. https://lounge.venneir.com)
//
// Failure logging: every Klarna-side error lands on
// lng_system_failures with severity=error and the raw response
// body, so a flaky run can be debugged after the fact.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const KLARNA_API_USERNAME = Deno.env.get('KLARNA_API_USERNAME') ?? '';
const KLARNA_API_PASSWORD = Deno.env.get('KLARNA_API_PASSWORD') ?? '';
const KLARNA_API_BASE_URL = (Deno.env.get('KLARNA_API_BASE_URL') ?? 'https://api.klarna.com').replace(/\/$/, '');
const LOUNGE_PUBLIC_BASE_URL = (Deno.env.get('LOUNGE_PUBLIC_BASE_URL') ?? 'https://lounge.venneir.com').replace(/\/$/, '');

// The supabase-functions host for the webhook URL. Klarna calls
// this directly; we don't proxy through the app domain because
// Klarna requires HTTPS and a stable URL that doesn't churn with
// each preview deploy.
const SUPABASE_FUNCTIONS_BASE = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1`;

interface CreateSessionBody {
  visit_id: string;
  amount_pence: number;
  // Stable across HTTP retries of the same user gesture so a
  // network flake lands on the SAME Klarna session row.
  attempt_id?: string;
}

interface KlarnaCreateSessionResponse {
  session_id: string;
  expires_at?: string;
  distribution?: {
    result_url?: string;
  };
}

interface KlarnaResultResponse {
  status?: string;
  qr_code?: string;
  payment_link?: string;
  retry_url?: string;
  error?: { message?: string };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors();
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (!KLARNA_API_USERNAME || !KLARNA_API_PASSWORD) {
    await logFailure('klarna_credentials_missing', {}, 'critical');
    return jsonError(500, 'Klarna credentials not configured');
  }

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return jsonError(401, 'Missing token');

  let body: CreateSessionBody;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Bad JSON');
  }
  if (!body.visit_id || !Number.isFinite(body.amount_pence) || body.amount_pence <= 0) {
    return jsonError(400, 'visit_id, amount_pence (positive int) required');
  }

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });

  const { data: meRow } = await userClient.rpc('auth_account_id');
  const taken_by = (meRow as string | null) ?? null;

  // Cart + outstanding-balance check, same shape as
  // terminal-start-payment so a part-paid cart's Klarna leg is
  // correctly bounded.
  const { data: cart, error: cartErr } = await supabase
    .from('lng_carts')
    .select('id, total_pence, status, visit_id')
    .eq('visit_id', body.visit_id)
    .maybeSingle();
  if (cartErr || !cart) return jsonError(404, 'Cart not found');
  if (cart.status !== 'open') return jsonError(409, `Cart status ${cart.status} not open`);
  if (cart.total_pence == null || cart.total_pence <= 0) {
    return jsonError(409, 'Cart has no total to charge');
  }

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
  if (body.amount_pence > outstanding) {
    return jsonError(
      409,
      `Amount ${body.amount_pence} exceeds outstanding balance ${outstanding}`
    );
  }

  // Idempotency key derivation. attempt_id (client-stable) is
  // preferred so a network retry lands on the same Klarna session.
  let idemKey: string;
  if (body.attempt_id && /^[0-9a-fA-F-]{8,64}$/.test(body.attempt_id)) {
    idemKey = `cart_${cart.id}_klarna_${body.attempt_id}`;
  } else {
    const { count: attemptCount } = await supabase
      .from('lng_klarna_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('cart_id', cart.id);
    idemKey = `cart_${cart.id}_klarna_attempt_${(attemptCount ?? 0) + 1}`;
  }

  // Pre-check: an existing session under this idem key means the
  // client is retrying. Return its current state rather than
  // creating a parallel Klarna session.
  {
    const { data: existing } = await supabase
      .from('lng_klarna_sessions')
      .select('id, payment_id, klarna_session_id, status, qr_code_url, payment_link_url, expires_at')
      .eq('idempotency_key', idemKey)
      .maybeSingle();
    const ex = existing as {
      id: string;
      payment_id: string;
      klarna_session_id: string | null;
      status: string;
      qr_code_url: string | null;
      payment_link_url: string | null;
      expires_at: string | null;
    } | null;
    if (ex && ex.klarna_session_id) {
      return jsonOk({
        session_row_id: ex.id,
        payment_id: ex.payment_id,
        klarna_session_id: ex.klarna_session_id,
        qr_code_url: ex.qr_code_url,
        payment_link_url: ex.payment_link_url,
        expires_at: ex.expires_at,
        status: ex.status,
      });
    }
  }

  // Cart line snapshot for Klarna's order_lines. Active lines only
  // — Klarna validates that order_amount equals the sum of line
  // totals, so we mirror what's actually in front of the patient.
  const { data: lines, error: linesErr } = await supabase
    .from('lng_cart_items')
    .select('name, quantity, unit_price_pence, line_total_pence')
    .eq('cart_id', cart.id)
    .is('removed_at', null);
  if (linesErr) {
    await logFailure('cart_items_read_failed', { cart_id: cart.id, error: linesErr.message });
    return jsonError(500, 'Could not read cart');
  }
  const cartLines = (lines ?? []) as Array<{
    name: string;
    quantity: number;
    unit_price_pence: number;
    line_total_pence: number;
  }>;

  // Sum from active lines. If it doesn't match the outstanding,
  // we fall back to a single synthetic line for the requested
  // amount — split payments mean amount_pence may be less than the
  // cart total, and Klarna doesn't allow partial-line amounts.
  const cartLinesSum = cartLines.reduce((s, l) => s + l.line_total_pence, 0);
  const useSynthLine =
    cartLines.length === 0 ||
    body.amount_pence !== cartLinesSum;

  const orderLines = useSynthLine
    ? [{
        type: 'physical',
        name: `Lounge visit ${body.visit_id.slice(0, 8)}`,
        quantity: 1,
        unit_price: body.amount_pence,
        total_amount: body.amount_pence,
        tax_rate: 0,
        total_tax_amount: 0,
      }]
    : cartLines.map((l) => ({
        type: 'physical',
        name: l.name,
        quantity: l.quantity,
        unit_price: l.unit_price_pence,
        total_amount: l.line_total_pence,
        tax_rate: 0,
        total_tax_amount: 0,
      }));

  // Webhook token + callback URL. Klarna doesn't sign webhooks, so
  // the token IS the trust anchor. UUIDv4-shaped, unique per row.
  const webhookToken = crypto.randomUUID();
  const callbackUrl =
    `${SUPABASE_FUNCTIONS_BASE}/klarna-webhook?token=${encodeURIComponent(webhookToken)}`;

  // Build the Klarna create-session request.
  const klarnaRequest = {
    acquiring_channel: 'in_store',
    purchase_country: 'GB',
    purchase_currency: 'GBP',
    locale: 'en-GB',
    merchant_reference1: `cart_${cart.id}`,
    merchant_reference2: `visit_${body.visit_id}`,
    order_amount: body.amount_pence,
    order_tax_amount: 0,
    order_lines: orderLines,
    distribution: {
      method: 'one_qr',
      callback_urls: {
        status_update: callbackUrl,
      },
    },
  };

  // Insert the placeholder rows BEFORE the Klarna API call so a
  // crash mid-flight leaves an auditable trail. We'll fill in
  // klarna_session_id + result_url after Klarna responds.
  const { data: payment, error: payErr } = await supabase
    .from('lng_payments')
    .insert({
      cart_id: cart.id,
      method: 'klarna',
      payment_journey: 'klarna',
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

  const { data: sessionRow, error: sesErr } = await supabase
    .from('lng_klarna_sessions')
    .insert({
      payment_id: payment.id,
      cart_id: cart.id,
      visit_id: body.visit_id,
      flow: 'one_qr',
      amount_pence: body.amount_pence,
      currency: 'gbp',
      status: 'pending',
      webhook_token: webhookToken,
      merchant_reference1: `cart_${cart.id}`,
      idempotency_key: idemKey,
      raw_create_request: klarnaRequest,
      taken_by,
    })
    .select('id')
    .single();
  if (sesErr || !sessionRow) {
    // Unique-violation on idempotency_key means a concurrent
    // request beat us to the row. Roll back our payment row and
    // return the winner's session state.
    if ((sesErr as { code?: string } | null)?.code === '23505') {
      await supabase.from('lng_payments').delete().eq('id', payment.id);
      const { data: winner } = await supabase
        .from('lng_klarna_sessions')
        .select('id, payment_id, klarna_session_id, status, qr_code_url, payment_link_url, expires_at')
        .eq('idempotency_key', idemKey)
        .maybeSingle();
      if (winner) {
        const w = winner as {
          id: string;
          payment_id: string;
          klarna_session_id: string | null;
          status: string;
          qr_code_url: string | null;
          payment_link_url: string | null;
          expires_at: string | null;
        };
        return jsonOk({
          session_row_id: w.id,
          payment_id: w.payment_id,
          klarna_session_id: w.klarna_session_id,
          qr_code_url: w.qr_code_url,
          payment_link_url: w.payment_link_url,
          expires_at: w.expires_at,
          status: w.status,
        });
      }
    }
    await supabase.from('lng_payments').delete().eq('id', payment.id);
    await logFailure('lng_klarna_sessions_insert_failed', { error: sesErr?.message });
    return jsonError(500, 'DB write failed');
  }

  // Create the Klarna session.
  const klarnaRes = await klarnaFetch(
    'POST',
    '/payments/v1/sessions',
    klarnaRequest,
    idemKey,
  );
  if (!klarnaRes.ok) {
    await supabase
      .from('lng_klarna_sessions')
      .update({
        status: 'failed',
        failed_at: new Date().toISOString(),
        raw_create_response: klarnaRes.body,
      })
      .eq('id', sessionRow.id);
    await supabase
      .from('lng_payments')
      .update({ status: 'failed', failure_reason: 'klarna_create_session_failed' })
      .eq('id', payment.id);
    await logFailure('klarna_create_session_failed', {
      session_row_id: sessionRow.id,
      status: klarnaRes.status,
      error: klarnaRes.body,
    });
    return jsonError(502, 'Klarna could not start the session');
  }

  const created = klarnaRes.body as KlarnaCreateSessionResponse;
  if (!created.session_id || !created.distribution?.result_url) {
    await supabase
      .from('lng_klarna_sessions')
      .update({
        status: 'failed',
        failed_at: new Date().toISOString(),
        raw_create_response: klarnaRes.body,
      })
      .eq('id', sessionRow.id);
    await supabase
      .from('lng_payments')
      .update({ status: 'failed', failure_reason: 'klarna_session_response_invalid' })
      .eq('id', payment.id);
    await logFailure('klarna_create_session_invalid_response', { body: klarnaRes.body });
    return jsonError(502, 'Klarna session response invalid');
  }

  // Pull the QR + payment_link. Klarna's result endpoint accepts
  // GET with no body — POST returns
  //   { error_code: 'BAD_REQUEST', error_messages: ["Request
  //     method 'POST' is not supported"] }
  // (earlier docs read described it as "send an empty body", which
  // we interpreted as POST. It's actually GET with no body.)
  const resultRes = await klarnaFetch('GET', stripBase(created.distribution.result_url));
  if (!resultRes.ok) {
    await supabase
      .from('lng_klarna_sessions')
      .update({
        klarna_session_id: created.session_id,
        result_url: created.distribution.result_url,
        expires_at: created.expires_at ?? null,
        raw_create_response: klarnaRes.body,
        raw_result_response: resultRes.body,
        status: 'failed',
        failed_at: new Date().toISOString(),
      })
      .eq('id', sessionRow.id);
    await supabase
      .from('lng_payments')
      .update({ status: 'failed', failure_reason: 'klarna_result_failed' })
      .eq('id', payment.id);
    await logFailure('klarna_result_fetch_failed', { error: resultRes.body });
    return jsonError(502, 'Klarna QR distribution failed');
  }

  const result = resultRes.body as KlarnaResultResponse;
  const qrUrl = result.qr_code ?? null;
  const paymentLink = result.payment_link ?? null;

  await supabase
    .from('lng_klarna_sessions')
    .update({
      klarna_session_id: created.session_id,
      result_url: created.distribution.result_url,
      qr_code_url: qrUrl,
      payment_link_url: paymentLink,
      expires_at: created.expires_at ?? null,
      status: 'awaiting_customer',
      raw_create_response: klarnaRes.body,
      raw_result_response: resultRes.body,
    })
    .eq('id', sessionRow.id);

  return jsonOk({
    session_row_id: sessionRow.id,
    payment_id: payment.id,
    klarna_session_id: created.session_id,
    qr_code_url: qrUrl,
    payment_link_url: paymentLink,
    expires_at: created.expires_at ?? null,
    status: 'awaiting_customer',
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

function jsonOk(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Strip the base URL from a fully-qualified Klarna URL so
// klarnaFetch (which prepends the base) doesn't double it up. The
// result_url Klarna returns is absolute.
function stripBase(absoluteUrl: string): string {
  try {
    const u = new URL(absoluteUrl);
    return u.pathname + u.search;
  } catch {
    return absoluteUrl;
  }
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
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown = {};
  const text = await r.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
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
      source: 'klarna-create-session',
      severity,
      message,
      context,
    });
  } catch {
    // best-effort
  }
}
