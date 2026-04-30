// terminal-list-payments
//
// GET ?limit=50&starting_after=pi_xxx
//
// Pulls the most-recent PaymentIntents off Stripe for the connected
// account and zips each one against its Lounge counterpart in
// lng_payments + lng_terminal_payments. Used by the Admin > Payments
// log so staff can verify what Stripe captured against what Lounge
// recorded — important when a webhook drop or a stuck Cancel has
// caused drift, which is the exact failure mode that nearly produced
// a double-charge tonight.
//
// Each result row carries:
//   • stripe — id, amount, currency, status, created, last_payment_error
//   • local  — payment_id, status, succeeded_at, cancelled_at, cart_id,
//              visit_id, patient name + lap_ref (joined for display)
//   • drift  — derived flag indicating Stripe and Lounge disagree, or
//              the row exists on Stripe but not in Lounge (orphan PI),
//              or vice versa (rare — local payment with no Stripe PI;
//              shouldn't happen for card_terminal but we surface it).
//
// Auth: Bearer JWT, admin-only. The list of every payment the
// connected Stripe account has ever taken is sensitive; receptionists
// shouldn't see it. is_admin() check before any data work happens.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

interface StripePI {
  id: string;
  amount: number;
  currency: string;
  status: string;
  created: number;
  metadata?: Record<string, string>;
  last_payment_error?: { message?: string };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET') return j(405, { error: 'Method not allowed' });

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return j(401, { error: 'Missing token' });
  const token = auth.slice('Bearer '.length);
  if (!STRIPE_SECRET_KEY) return j(500, { error: 'STRIPE_SECRET_KEY missing' });

  // Admin-only — Stripe-wide payment list is sensitive.
  const userClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: isAdminRow } = await userClient.rpc('is_admin');
  if (!isAdminRow) return j(403, { error: 'Admin only' });

  const url = new URL(req.url);
  const limit = clampInt(url.searchParams.get('limit'), 1, 100, 50);
  const startingAfter = url.searchParams.get('starting_after');

  const params = new URLSearchParams({ limit: String(limit) });
  if (startingAfter) params.set('starting_after', startingAfter);

  const stripeRes = await fetch(`https://api.stripe.com/v1/payment_intents?${params}`, {
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2024-10-28.acacia',
    },
  });
  const stripeBody = await stripeRes.json();
  if (!stripeRes.ok) {
    return j(502, { error: stripeBody?.error?.message ?? 'Stripe list failed' });
  }
  const intents = (stripeBody.data ?? []) as StripePI[];
  const hasMore = !!stripeBody.has_more;

  if (intents.length === 0) {
    return j(200, { rows: [], has_more: false, ending_before: null });
  }

  // Match in one round-trip via stripe_payment_intent_id.
  const piIds = intents.map((pi) => pi.id);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: tpRows } = await supabase
    .from('lng_terminal_payments')
    .select(
      'stripe_payment_intent_id, payment_id, succeeded_at, payment:lng_payments(id, status, amount_pence, succeeded_at, cancelled_at, failure_reason, cart_id, taken_by, payment_journey, cart:lng_carts(visit_id, status, total_pence, visit:lng_visits(id, patient_id, opened_at, appointment:lng_appointments(appointment_ref))))',
    )
    .in('stripe_payment_intent_id', piIds);

  const byPi = new Map<string, TerminalRow>();
  for (const row of (tpRows ?? []) as unknown as TerminalRow[]) {
    byPi.set(row.stripe_payment_intent_id, row);
  }

  // Patient names — separate batch since the FK chain doesn't reach
  // patients via the join above. Cheap one-shot lookup keyed by id.
  const patientIds = Array.from(
    new Set(
      Array.from(byPi.values())
        .map((r) => r.payment?.cart?.visit?.patient_id ?? null)
        .filter((id): id is string => !!id),
    ),
  );
  const namesById = new Map<string, string>();
  if (patientIds.length > 0) {
    const { data: ps } = await supabase
      .from('patients')
      .select('id, first_name, last_name, name')
      .in('id', patientIds);
    for (const p of (ps ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      name: string | null;
    }>) {
      const fn = p.first_name?.trim();
      const ln = p.last_name?.trim();
      const nm = p.name?.trim();
      const display = fn && ln ? `${fn} ${ln}` : fn ?? ln ?? nm ?? null;
      if (display) namesById.set(p.id, display);
    }
  }

  const rows = intents.map((pi) => {
    const tp = byPi.get(pi.id) ?? null;
    const localStatus = tp?.payment?.status ?? null;
    const expected = mapStripeToLocal(pi.status);
    const orphan = !tp;
    const drift = !orphan && expected !== null && localStatus !== null && localStatus !== expected;
    const cart = tp?.payment?.cart ?? null;
    const visit = cart?.visit ?? null;
    const appointment = visit?.appointment ?? null;
    return {
      stripe: {
        id: pi.id,
        amount_pence: pi.amount,
        currency: pi.currency,
        status: pi.status,
        created: pi.created,
        last_payment_error: pi.last_payment_error?.message ?? null,
      },
      local: tp
        ? {
            payment_id: tp.payment?.id ?? null,
            status: tp.payment?.status ?? null,
            succeeded_at: tp.payment?.succeeded_at ?? null,
            cancelled_at: tp.payment?.cancelled_at ?? null,
            failure_reason: tp.payment?.failure_reason ?? null,
            amount_pence: tp.payment?.amount_pence ?? null,
            payment_journey: tp.payment?.payment_journey ?? null,
            cart_id: tp.payment?.cart_id ?? null,
            cart_status: cart?.status ?? null,
            cart_total_pence: cart?.total_pence ?? null,
            visit_id: visit?.id ?? null,
            patient_id: visit?.patient_id ?? null,
            patient_name: visit?.patient_id ? namesById.get(visit.patient_id) ?? null : null,
            appointment_ref: appointment?.appointment_ref ?? null,
            taken_by: tp.payment?.taken_by ?? null,
          }
        : null,
      drift,
      orphan,
      expected_local_status: expected,
    };
  });

  return j(200, {
    rows,
    has_more: hasMore,
    ending_before: intents[intents.length - 1]?.id ?? null,
  });
});

interface TerminalRow {
  stripe_payment_intent_id: string;
  payment_id: string;
  succeeded_at: string | null;
  payment: {
    id: string;
    status: string;
    amount_pence: number;
    succeeded_at: string | null;
    cancelled_at: string | null;
    failure_reason: string | null;
    cart_id: string;
    taken_by: string | null;
    payment_journey: string | null;
    cart: {
      visit_id: string;
      status: string;
      total_pence: number | null;
      visit: {
        id: string;
        patient_id: string;
        opened_at: string;
        appointment: {
          appointment_ref: string | null;
        } | null;
      } | null;
    } | null;
  } | null;
}

function mapStripeToLocal(stripeStatus: string): string | null {
  switch (stripeStatus) {
    case 'succeeded':
    case 'requires_capture':
      return 'succeeded';
    case 'canceled':
      return 'cancelled';
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
    case 'processing':
      return null; // in-flight; no expectation either way
    default:
      return null;
  }
}

function clampInt(s: string | null, min: number, max: number, def: number): number {
  if (!s) return def;
  const n = Number(s);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function j(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
