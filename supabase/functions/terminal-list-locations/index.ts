// terminal-list-locations
//
// GET → returns the Stripe Terminal Locations available on the
// account, shaped for the Admin Devices reader-registration form.
// Locations are configured in the Stripe Dashboard (Terminal →
// Locations); a reader must be registered against one. Most clinics
// will have a single location, but the dropdown supports multi-site
// setups too.
//
// Response: { ok: true, locations: [{ id, display_name, address }] }
//          or { ok: false, error: '…' }

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_BASE = 'https://api.stripe.com/v1';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'GET') return jsonError(405, 'Method not allowed');

  if (!STRIPE_SECRET_KEY) return jsonError(500, 'STRIPE_SECRET_KEY not set');

  // Auth: any signed-in staff member can list locations. The
  // Admin route is itself behind staff auth so this is just a
  // belt-and-braces check.
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return jsonError(401, 'Missing token');

  const r = await fetch(`${STRIPE_BASE}/terminal/locations?limit=100`, {
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2024-10-28.acacia',
    },
  });
  const body = (await r.json().catch(() => ({}))) as {
    data?: Array<{
      id: string;
      display_name: string | null;
      address?: {
        line1?: string | null;
        city?: string | null;
        postal_code?: string | null;
        country?: string | null;
      } | null;
    }>;
    error?: { message?: string };
  };
  if (!r.ok) {
    return jsonError(502, body.error?.message ?? `Stripe error (HTTP ${r.status})`);
  }

  const locations = (body.data ?? []).map((l) => ({
    id: l.id,
    display_name: l.display_name ?? '(unnamed)',
    address: l.address
      ? [l.address.line1, l.address.city, l.address.postal_code, l.address.country]
          .filter((s): s is string => !!s)
          .join(', ')
      : null,
  }));

  return new Response(JSON.stringify({ ok: true, locations }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
