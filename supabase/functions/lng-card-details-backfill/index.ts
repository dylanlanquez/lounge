// lng-card-details-backfill
//
// Lazy backfill of card_brand + card_last4 for sources that pre-date
// the webhook-side capture. Called by the RefundSheet on open so the
// "Going back to" row can render "Visa ending in 4242" for historical
// deposits/payments instead of the generic "Card used at booking".
//
// POST { sources: [{ kind: 'payment'|'deposit', id, payment_intent_id }] }
// Returns { results: [{ id, brand, last4 } | null] } in the same order.
//
// Auth: anon key as Bearer. Staff-scope only (auth_is_lng_staff).
// Stripe key resolved from lng_settings.stripe.mode (live/test) with a
// 404-only fallback to the other key — mirrors terminal-refund.
//
// Idempotent: if the row already has brand + last4, returns them
// without hitting Stripe. If Stripe doesn't carry card details (e.g.
// the PI is on a different account or was paid via a non-card method
// in the legacy path), returns null for that source — caller falls
// back to the channel-level label.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const STRIPE_SECRET_KEY_LEGACY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_SECRET_KEY_LIVE =
  Deno.env.get('STRIPE_SECRET_KEY_LIVE') ?? STRIPE_SECRET_KEY_LEGACY;
const STRIPE_SECRET_KEY_TEST = Deno.env.get('STRIPE_SECRET_KEY_TEST') ?? '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

interface SourceRef {
  kind: 'payment' | 'deposit';
  id: string;
  payment_intent_id: string;
}

interface CardDetails {
  brand: string | null;
  last4: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return j(401, { error: 'Missing token' });

  let body: { sources?: unknown };
  try {
    body = await req.json();
  } catch {
    return j(400, { error: 'Bad JSON' });
  }
  if (!Array.isArray(body.sources)) {
    return j(400, { error: 'sources array required' });
  }
  const sources: SourceRef[] = [];
  for (const raw of body.sources) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (r.kind !== 'payment' && r.kind !== 'deposit') continue;
    if (typeof r.id !== 'string' || typeof r.payment_intent_id !== 'string') continue;
    sources.push({ kind: r.kind, id: r.id, payment_intent_id: r.payment_intent_id });
  }
  if (sources.length === 0) return j(200, { results: [] });

  // Staff check via the caller's JWT — service-role does the writes.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });
  const { data: staffCheck } = await userClient.rpc('auth_is_lng_staff');
  if (staffCheck !== true) return j(403, { error: 'Not staff' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Resolve Stripe mode once for the whole batch.
  const { data: modeRow } = await supabase
    .from('lng_settings')
    .select('value')
    .eq('key', 'stripe.mode')
    .is('location_id', null)
    .maybeSingle();
  const mode = (modeRow?.value as string | undefined) === 'test' ? 'test' : 'live';
  const primary = mode === 'test' ? STRIPE_SECRET_KEY_TEST : STRIPE_SECRET_KEY_LIVE;
  const fallback = mode === 'test' ? STRIPE_SECRET_KEY_LIVE : STRIPE_SECRET_KEY_TEST;

  const results: Array<CardDetails | null> = [];
  for (const s of sources) {
    // Skip if the row already has both columns.
    const table = s.kind === 'payment' ? 'lng_payments' : 'lng_appointments';
    const { data: existing } = await supabase
      .from(table)
      .select('card_brand, card_last4')
      .eq('id', s.id)
      .maybeSingle();
    const e = existing as { card_brand: string | null; card_last4: string | null } | null;
    if (e?.card_brand && e?.card_last4) {
      results.push({ brand: e.card_brand, last4: e.card_last4 });
      continue;
    }
    // Fetch from Stripe. Try primary mode; on 404 fall back.
    let card = await fetchPiCard(primary, s.payment_intent_id);
    if (!card.ok && card.status === 404 && fallback && fallback !== primary) {
      card = await fetchPiCard(fallback, s.payment_intent_id);
    }
    if (!card.ok || (!card.brand && !card.last4)) {
      results.push(null);
      continue;
    }
    // Persist whatever Stripe gave us so the next open is instant.
    const patch: Record<string, unknown> = {};
    if (card.brand && !e?.card_brand) patch.card_brand = card.brand;
    if (card.last4 && !e?.card_last4) patch.card_last4 = card.last4;
    if (Object.keys(patch).length > 0) {
      await supabase.from(table).update(patch).eq('id', s.id);
    }
    results.push({ brand: card.brand, last4: card.last4 });
  }

  return j(200, { results });
});

async function fetchPiCard(
  key: string,
  piId: string,
): Promise<{ ok: true; brand: string | null; last4: string | null } | { ok: false; status: number }> {
  if (!key) return { ok: false, status: 500 };
  try {
    const r = await fetch(
      `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(piId)}?expand[]=latest_charge`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    if (!r.ok) return { ok: false, status: r.status };
    const body = (await r.json()) as {
      latest_charge?: {
        payment_method_details?: {
          card?: { brand?: string | null; last4?: string | null };
          card_present?: { brand?: string | null; last4?: string | null };
        };
      };
    };
    const card =
      body.latest_charge?.payment_method_details?.card ??
      body.latest_charge?.payment_method_details?.card_present ??
      null;
    if (!card) return { ok: true, brand: null, last4: null };
    const brand = typeof card.brand === 'string' ? card.brand : null;
    const last4 = typeof card.last4 === 'string' && /^\d{4}$/.test(card.last4) ? card.last4 : null;
    return { ok: true, brand, last4 };
  } catch {
    return { ok: false, status: 0 };
  }
}

function j(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
