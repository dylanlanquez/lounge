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
import {
  resolveWidgetFullPricePence,
  serialiseRepairItemsForHash,
} from '../_shared/widgetFullPrice.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Legacy un-suffixed key used as the live-mode fallback so
// deployments configured before the stripe.mode toggle landed
// keep working without a secrets rename.
const STRIPE_SECRET_KEY_LEGACY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_SECRET_KEY_LIVE = Deno.env.get('STRIPE_SECRET_KEY_LIVE') ?? STRIPE_SECRET_KEY_LEGACY;
const STRIPE_SECRET_KEY_TEST = Deno.env.get('STRIPE_SECRET_KEY_TEST') ?? '';
const STRIPE_BASE = 'https://api.stripe.com/v1';

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
  /** Widget upgrade ids the customer ticked. Server-resolved against
   *  lng_widget_upgrades (the anon-readable filtered view of
   *  lng_catalogue_upgrades) and added to the PI amount. Empty when
   *  the service has no selected upgrades. Defended against tampering:
   *  every id must (a) resolve to an active, widget-visible row, and
   *  (b) belong to the catalogue row that matches this booking's
   *  axes — anything that doesn't is silently dropped from the
   *  total. The widget client passes the same list to
   *  widget-create-appointment at commit time so the verification
   *  step recomputes an identical amount. */
  upgradeIds?: string[];
  /** Denture-repair cart. Required for service_type='denture_repair'
   *  on paymentMode='full' — the full price is the sum of every
   *  cart line's catalogue price, not a single resolved row. Empty
   *  / absent for every other service. Re-priced server-side
   *  against lwo_catalogue; client-supplied unit_price values are
   *  ignored. */
  repairItems?: Array<{
    catalogueId: string;
    arch: 'upper' | 'lower' | 'both';
    quantity: number;
  }>;
  /** 'full' charges the resolved catalogue price (unit_price or
   *  both_arches_price) PLUS the applicable upgrade pence.
   *  'deposit' is the legacy path — charges the widget_deposit_pence
   *  configured on lng_widget_booking_types and ignores upgrades
   *  (the till collects the balance later). Defaults to 'deposit'
   *  so any older client that hasn't been redeployed yet keeps
   *  working. */
  paymentMode?: 'full' | 'deposit';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch (e) {
    return jsonResponse(400, { error: 'bad_json', detail: String(e) });
  }
  const v = validate(body);
  if (v) return jsonResponse(400, { error: 'invalid', detail: v });

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const stripeSecret = await resolveStripeSecret(supabase);
  if (!stripeSecret) {
    await logFailure('stripe_secret_key_missing', {});
    return jsonResponse(500, { error: 'stripe_not_configured' });
  }

  const resolvedLocationId = await resolveLocationId(supabase, body.locationId);
  if (!resolvedLocationId) {
    return jsonResponse(400, { error: 'no_location_resolved' });
  }

  // Server-resolved amount: never trust the client. Two paths:
  //
  //   • paymentMode 'full' (new default for redeployed widget) —
  //     charge the resolved catalogue price the same way the client
  //     computes it: filter lwo_catalogue by (service_type, optional
  //     product_key, optional repair_variant, active=true), take the
  //     first row, use unit_price OR both_arches_price when the
  //     patient picked arch='both' on a single-arch row.
  //
  //   • paymentMode 'deposit' (legacy) — fall back to
  //     widget_deposit_pence on lng_widget_booking_types. Kept so an
  //     in-cache older bundle on a partner page doesn't break mid
  //     deploy.
  const paymentMode: 'full' | 'deposit' = body.paymentMode === 'full' ? 'full' : 'deposit';
  let amountPence = 0;
  if (paymentMode === 'full') {
    const fullPrice = await resolveWidgetFullPricePence(supabase, {
      serviceType: body.serviceType,
      productKey: body.productKey ?? null,
      repairVariant: body.repairVariant ?? null,
      arch: body.arch ?? null,
      upgradeIds: body.upgradeIds ?? [],
      repairItems: body.repairItems ?? [],
    });
    if (!fullPrice.ok) {
      return jsonResponse(400, { error: fullPrice.code });
    }
    amountPence = fullPrice.pence;
  } else {
    const { data: depositRow, error: depositErr } = await supabase
      .from('lng_widget_booking_types')
      .select('deposit_pence')
      .eq('service_type', body.serviceType)
      .maybeSingle();
    if (depositErr) {
      await logFailure('deposit_lookup_failed', { error: depositErr.message, body });
      return jsonResponse(500, { error: 'resolve_failed' });
    }
    amountPence =
      (depositRow as { deposit_pence: number } | null)?.deposit_pence ?? 0;
    if (amountPence <= 0) {
      return jsonResponse(400, { error: 'no_deposit_configured' });
    }
  }

  // Idempotency: same (patient, slot, service, axes, upgrades, cart,
  // mode) within Stripe's 24h window returns the same PaymentIntent.
  // A different upgrade selection OR a different denture-repair cart
  // must produce a different PI; otherwise re-entering the flow with
  // a new shape would reuse a stale PI at the old amount. paymentMode
  // is also in the hash so a customer who clicks Pay-now, backs out,
  // and switches to Pay-deposit correctly gets a fresh PI.
  const upgradeIdsForHash = (body.upgradeIds ?? []).slice().sort().join(',');
  const repairItemsForHash = serialiseRepairItemsForHash(body.repairItems ?? []);
  const idemKey = await sha256Hex(
    [
      body.email.toLowerCase().trim(),
      body.startAt,
      body.serviceType,
      body.repairVariant ?? '',
      body.productKey ?? '',
      body.arch ?? '',
      upgradeIdsForHash,
      repairItemsForHash,
      paymentMode,
    ].join('|'),
  );

  // Restrict to card-based methods only. Two reasons:
  //
  //   1. Redirect-based methods (Klarna, Amazon Pay, Revolut Pay)
  //      bounce the patient out to a third-party site and return
  //      via the return_url — but the widget is a single-page app
  //      with no URL state, so on return we'd have lost the
  //      booking inputs and never call widget-create-appointment.
  //      Money taken, no booking. To support these we'd need to
  //      persist the booking inputs in localStorage on submit and
  //      a "resume" flow on mount. Out of scope for v1.
  //
  //   2. Klarna is BNPL. Per the project working agreement BNPL
  //      is never suggested, never advised, never quoted. Showing
  //      it as a deposit option is a direct violation.
  //
  // 'card' implicitly includes Apple Pay / Google Pay (the
  // PaymentElement surfaces them inside the card tab on supported
  // devices), so we don't lose the in-page wallet flows.
  const piRes = await stripeFetch(
    stripeSecret,
    'POST',
    '/payment_intents',
    {
      amount: String(amountPence),
      currency: 'gbp',
      'payment_method_types[]': 'card',
      receipt_email: body.email,
      'metadata[source]': 'widget',
      'metadata[service_type]': body.serviceType,
      'metadata[start_at]': body.startAt,
      'metadata[location_id]': resolvedLocationId,
      'metadata[repair_variant]': body.repairVariant ?? '',
      'metadata[product_key]': body.productKey ?? '',
      'metadata[arch]': body.arch ?? '',
      'metadata[payment_mode]': paymentMode,
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
    // New canonical key. Legacy clients read depositPence, so keep
    // that alias populated even when paymentMode === 'full' so an
    // older cached bundle on a partner page doesn't blow up trying
    // to read undefined.amount.
    amountPence: pi.amount,
    depositPence: pi.amount,
    currency: pi.currency,
    paymentMode,
  });
});

// Full-price resolution lives in _shared/widgetFullPrice.ts so this
// endpoint and widget-create-appointment compute the amount the
// same way. Two paths inside the helper:
//   • denture_repair  — sum the cart's per-line catalogue prices.
//   • everything else — resolve one catalogue row by axis pins.
// The PI amount must be authoritative — the client composes a
// display price for the customer, but the server resolves
// independently and creates the PI for the server's number so a
// tampered client body can never claim £0 on a £179 booking.

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
  stripeSecret: string,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, string>,
  idempotencyKey?: string,
): Promise<{ ok: boolean; body: unknown }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${stripeSecret}`,
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
