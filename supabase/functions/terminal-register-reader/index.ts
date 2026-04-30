// terminal-register-reader
//
// POST { registration_code, friendly_name, stripe_location_id, location_id }
//
// Pairs a Stripe Terminal reader (S700, simulated WisePOS E, etc.)
// with the Stripe account, then inserts the resulting reader id +
// metadata into lng_terminal_readers so the Pay flow can find it.
//
// The registration_code is the 3-word string the device shows on
// its screen (Stripe call it "the pairing code"). location_id is
// the Lounge-internal UUID of the clinic site; stripe_location_id
// is the Stripe Terminal Location id (tml_…) the reader gets
// registered against.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_BASE = 'https://api.stripe.com/v1';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

interface Body {
  registration_code?: string;
  friendly_name?: string;
  stripe_location_id?: string;
  location_id?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

  if (!STRIPE_SECRET_KEY) return jsonError(500, 'STRIPE_SECRET_KEY not set');

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return jsonError(401, 'Missing token');

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError(400, 'Bad JSON');
  }
  if (!body.registration_code || !body.registration_code.trim()) {
    return jsonError(400, 'registration_code required');
  }
  if (!body.friendly_name || !body.friendly_name.trim()) {
    return jsonError(400, 'friendly_name required');
  }
  if (!body.stripe_location_id || !body.stripe_location_id.trim()) {
    return jsonError(400, 'stripe_location_id required');
  }
  if (!body.location_id || !body.location_id.trim()) {
    return jsonError(400, 'location_id required');
  }

  const code = body.registration_code.trim();
  const label = body.friendly_name.trim();
  const stripeLocationId = body.stripe_location_id.trim();
  const locationId = body.location_id.trim();

  // 1. Pair the device with Stripe.
  const params = new URLSearchParams({
    registration_code: code,
    location: stripeLocationId,
    label,
  });
  const stripeRes = await fetch(`${STRIPE_BASE}/terminal/readers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2024-10-28.acacia',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const stripeBody = (await stripeRes.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string };
  };
  if (!stripeRes.ok || !stripeBody.id) {
    // Common case: invalid / already-used code. Surface Stripe's
    // own message so the receptionist sees the real reason.
    return jsonError(
      stripeRes.status === 400 ? 400 : 502,
      stripeBody.error?.message ?? `Stripe error (HTTP ${stripeRes.status})`
    );
  }

  // 2. Insert into lng_terminal_readers. Service-role client; RLS
  //    on the table doesn't apply when running with the service
  //    key, so we trust the caller-validated inputs above.
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: row, error } = await supabase
    .from('lng_terminal_readers')
    .insert({
      friendly_name: label,
      stripe_reader_id: stripeBody.id,
      stripe_location_id: stripeLocationId,
      location_id: locationId,
      status: 'idle',
    })
    .select('id')
    .single();
  if (error || !row) {
    // The Stripe reader is now paired; if the DB insert failed,
    // the registration would be orphaned. Surface the error so
    // staff can clean up via Stripe Dashboard if needed.
    return jsonError(500, `Reader paired with Stripe but DB insert failed: ${error?.message ?? 'unknown'}`);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      id: (row as { id: string }).id,
      stripe_reader_id: stripeBody.id,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    }
  );
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
