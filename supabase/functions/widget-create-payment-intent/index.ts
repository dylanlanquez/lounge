// widget-create-payment-intent
//
// Customer-facing booking widget — Stripe PaymentIntent creation
// for the deposit step. Anon-callable; the patient is unauth'd.
//
// Order of operations:
//
//   1. Validate the body (locationId, serviceType, axes, email).
//   2. Resolve the location (UUID or stub fallback to default
//      Venneir lab — same fallback widget-create-appointment uses).
//   3. Resolve the booking type config server-side and pull the
//      widget_deposit_pence. The client never gets to dictate the
//      amount.
//   4. Reject if there's no deposit configured for this service.
//   5. Create a Stripe PaymentIntent:
//        amount       — server-resolved deposit
//        currency     — gbp
//        receipt_email — so Stripe auto-emails the receipt and we
//                        avoid a custom receipt template for v1
//        metadata     — source=widget + service/axes/location for
//                       webhook reconciliation
//        idempotency_key — hash of (email + start_at + service +
//                          axes) so duplicate invocations during the
//                          same booking flow re-use the same PI
//                          rather than charging twice.
//   6. Return clientSecret + depositPence so the widget Payment
//      step can confirm via Stripe Elements.
//
// Phase 4 follow-up: a stripe-webhook function that listens for
// payment_intent.succeeded and reconciles orphan payments (PIs
// that succeeded but the client never made it to widget-create-
// appointment). For v1 the happy path is sufficient — staff can
// reconcile manually via the Stripe dashboard if needed.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_BASE = 'https://api.stripe.com/v1';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

interface Body {
  locationId: string;
  serviceType: string;
  startAt: string;
  email: string;
  repairVariant?: string | null;
  productKey?: string | null;
  arch?: 'upper' | 'lower' | 'both' | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });

  if (!STRIPE_SECRET_KEY) {
    await logFailure('stripe_secret_key_missing', {});
    return jsonResponse(500, { error: 'stripe_not_configured' });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch (e) {
    return jsonResponse(400, { error: 'bad_json', detail: String(e) });
  }
  const v = validate(body);
  if (v) return jsonResponse(400, { error: 'invalid', detail: v });

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const resolvedLocationId = await resolveLocationId(supabase, body.locationId);
  if (!resolvedLocationId) {
    return jsonResponse(400, { error: 'no_location_resolved' });
  }

  // Server-resolved deposit: never trust the client. Reads from
  // lng_booking_type_config via the resolver, which honours per-axis
  // overrides (a "Whitening tray, Upper arch" deposit can differ
  // from the parent service default).
  const { data: cfgRaw, error: cfgErr } = await supabase.rpc('lng_booking_type_resolve', {
    p_service_type: body.serviceType,
    p_repair_variant: body.repairVariant ?? null,
    p_product_key: body.productKey ?? null,
    p_arch: body.arch ?? null,
  });
  if (cfgErr) {
    await logFailure('booking_type_resolve_failed', { error: cfgErr.message, body });
    return jsonResponse(500, { error: 'resolve_failed' });
  }
  const cfg = (Array.isArray(cfgRaw) ? cfgRaw[0] : null) as {
    widget_deposit_pence?: number | null;
  } | null;
  const depositPence = cfg?.widget_deposit_pence ?? 0;
  if (depositPence <= 0) {
    return jsonResponse(400, { error: 'no_deposit_configured' });
  }

  // Idempotency: same (patient, slot, service, axes) within Stripe's
  // 24h window returns the same PaymentIntent. Avoids accidental
  // double-charges if the client retries the call.
  const idemKey = await sha256Hex(
    [
      body.email.toLowerCase().trim(),
      body.startAt,
      body.serviceType,
      body.repairVariant ?? '',
      body.productKey ?? '',
      body.arch ?? '',
    ].join('|'),
  );

  const piRes = await stripeFetch(
    'POST',
    '/payment_intents',
    {
      amount: String(depositPence),
      currency: 'gbp',
      'automatic_payment_methods[enabled]': 'true',
      receipt_email: body.email,
      'metadata[source]': 'widget',
      'metadata[service_type]': body.serviceType,
      'metadata[start_at]': body.startAt,
      'metadata[location_id]': resolvedLocationId,
      'metadata[repair_variant]': body.repairVariant ?? '',
      'metadata[product_key]': body.productKey ?? '',
      'metadata[arch]': body.arch ?? '',
    },
    idemKey,
  );
  if (!piRes.ok) {
    await logFailure('payment_intent_create_failed', { error: piRes.body, body });
    return jsonResponse(502, { error: 'payment_intent_failed' });
  }
  const pi = piRes.body as {
    id: string;
    client_secret: string;
    amount: number;
    currency: string;
  };

  return jsonResponse(200, {
    clientSecret: pi.client_secret,
    paymentIntentId: pi.id,
    depositPence: pi.amount,
    currency: pi.currency,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function validate(body: Body): string | null {
  if (!body || typeof body !== 'object') return 'body_not_object';
  if (typeof body.locationId !== 'string' || !body.locationId) return 'locationId_missing';
  if (typeof body.serviceType !== 'string' || !body.serviceType) return 'serviceType_missing';
  if (typeof body.startAt !== 'string' || !body.startAt) return 'startAt_missing';
  if (typeof body.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) {
    return 'email_invalid';
  }
  if (body.arch && !['upper', 'lower', 'both'].includes(body.arch)) return 'arch_invalid';
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveLocationId(
  supabase: SupabaseClient,
  candidate: string,
): Promise<string | null> {
  // Mirror of widget-create-appointment's resolver — when the client
  // sends a real UUID, take it; otherwise resolve to the single
  // Venneir Lounge default. Phase 6 multi-location flips the client
  // to live reads.
  if (UUID_RE.test(candidate)) {
    const { data } = await supabase
      .from('locations')
      .select('id')
      .eq('id', candidate)
      .maybeSingle();
    if (data) return (data as { id: string }).id;
  }
  const { data: fallback } = await supabase
    .from('locations')
    .select('id')
    .eq('type', 'lab')
    .eq('is_venneir', true)
    .order('name', { ascending: true })
    .limit(1)
    .maybeSingle();
  return fallback ? (fallback as { id: string }).id : null;
}

async function stripeFetch(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, string>,
  idempotencyKey?: string,
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

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function logFailure(
  message: string,
  context: Record<string, unknown>,
  severity: 'info' | 'warning' | 'error' | 'critical' = 'error',
) {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from('lng_system_failures').insert({
      source: 'widget-create-payment-intent',
      severity,
      message,
      context,
    });
  } catch {
    // best-effort
  }
}
