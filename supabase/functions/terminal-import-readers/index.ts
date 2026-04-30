// terminal-import-readers
//
// POST { location_id }
//
// Pulls every reader Stripe knows about for the account and
// inserts the ones that aren't already in lng_terminal_readers.
// Used when staff has paired an S700 directly via Stripe Dashboard
// and just needs Lounge to learn about it (rather than re-pairing
// through Lounge's Register reader form, which would invalidate
// the existing pairing).
//
// Response:
//   { ok: true, imported: [{ id, stripe_reader_id, friendly_name }],
//     already_present: number }

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

  if (!STRIPE_SECRET_KEY) return jsonError(500, 'STRIPE_SECRET_KEY not set');

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return jsonError(401, 'Missing token');

  let body: { location_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Bad JSON');
  }
  if (!body.location_id || !body.location_id.trim()) {
    return jsonError(400, 'location_id (Lounge clinic UUID) required');
  }
  const loungeLocationId = body.location_id.trim();

  // 1. List every reader Stripe knows about. limit=100 covers any
  //    realistic single-account setup; pagination can land if a
  //    franchise ever exceeds it.
  const stripeRes = await fetch(`${STRIPE_BASE}/terminal/readers?limit=100`, {
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2024-10-28.acacia',
    },
  });
  const stripeBody = (await stripeRes.json().catch(() => ({}))) as {
    data?: Array<{
      id: string;
      label: string | null;
      location: string | null;
      device_type?: string | null;
      status?: string | null;
    }>;
    error?: { message?: string };
  };
  if (!stripeRes.ok) {
    return jsonError(502, stripeBody.error?.message ?? `Stripe error (HTTP ${stripeRes.status})`);
  }
  const stripeReaders = stripeBody.data ?? [];

  // 2. Read existing rows so we don't double-insert.
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: existing, error: existErr } = await supabase
    .from('lng_terminal_readers')
    .select('stripe_reader_id');
  if (existErr) return jsonError(500, existErr.message);
  const existingIds = new Set(((existing ?? []) as { stripe_reader_id: string }[]).map((r) => r.stripe_reader_id));

  // 3. Insert the new ones. Reader's `label` becomes friendly_name;
  //    Stripe's `location` becomes stripe_location_id; the caller's
  //    Lounge clinic id is used for location_id.
  const toInsert = stripeReaders
    .filter((r) => !existingIds.has(r.id) && r.location)
    .map((r) => ({
      friendly_name: r.label ?? r.id,
      stripe_reader_id: r.id,
      stripe_location_id: r.location!,
      location_id: loungeLocationId,
      // Stripe gives 'online' / 'offline' for the live state; map
      // anything else to 'unknown' so the local enum stays clean.
      status: r.status === 'online' ? 'online' : r.status === 'offline' ? 'offline' : 'unknown',
    }));

  let imported: Array<{ id: string; stripe_reader_id: string; friendly_name: string }> = [];
  if (toInsert.length > 0) {
    const { data: rows, error: insErr } = await supabase
      .from('lng_terminal_readers')
      .insert(toInsert)
      .select('id, stripe_reader_id, friendly_name');
    if (insErr) return jsonError(500, insErr.message);
    imported = (rows ?? []) as typeof imported;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      imported,
      already_present: stripeReaders.length - toInsert.length,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
  );
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
