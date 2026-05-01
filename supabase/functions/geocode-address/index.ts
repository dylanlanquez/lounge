// geocode-address
//
// POST { addresses: { line1: string; postcode: string; city?: string }[] }
// Returns {
//   results: { line1_norm: string; postcode_norm: string; lat: number; lng: number }[],
//   partial_failures: { line1: string; postcode: string; reason: string }[]
// }
//
// Address-level companion to geocode-postcode. Resolves precise UK
// addresses (line1 + postcode) to lat/lng for the admin-only address
// heatmap in Reports → Demographics. Hits lng_address_geocodes first;
// only addresses that aren't cached fire a Google call, and the
// fresh results are upserted on the way back.
//
// Why a server-side function rather than a direct browser call:
//
//   • The cache table holds personal data and is read-restricted to
//     Lounge admins / super admin via RLS. Centralising every read
//     here means we can also enforce the admin check on writes —
//     non-admins calling the function get a 403 before any Google
//     call fires (cost containment + abuse prevention).
//
//   • Keeps the geocoding API key in a Supabase secret —
//     GOOGLE_GEOCODING_API_KEY — separate from the client-side
//     Maps key. Different IP/referrer restrictions, different
//     billing visibility.
//
// Auth: Bearer JWT, caller must be Lounge admin or super admin.
// Rate-limit shape: at most 50 addresses per call to bound a
// single bad client.
//
// ── Normalisation contract ────────────────────────────────────────
// Both this function AND the front-end hook MUST normalise addresses
// identically before cache lookup or upsert. The contract:
//
//   • line1_norm    = trim, collapse internal whitespace to single
//                     spaces, lowercase. (e.g. " 10  Acacia Avenue "
//                     → "10 acacia avenue")
//   • postcode_norm = trim, remove ALL whitespace, uppercase.
//                     (e.g. " g71 8ph " → "G718PH")
//
// If the contract drifts, cache hits stop matching and we'll re-bill
// Google for already-geocoded addresses.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const GOOGLE_GEOCODING_API_KEY = Deno.env.get('GOOGLE_GEOCODING_API_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const MAX_BATCH = 50;

// UK outward shape regex — same as geocode-postcode. Used after
// normalisation to discard malformed postcodes before geocoding.
const UK_POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/;

interface AddressInput {
  line1: string;
  postcode: string;
  city?: string;
}

interface NormalisedAddress {
  raw: AddressInput;
  line1_norm: string;
  postcode_norm: string;
}

interface CachedGeocode {
  line1_norm: string;
  postcode_norm: string;
  lat: number;
  lng: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return j(405, { error: 'Method not allowed' });

  // --- 1. Auth + admin gate ----------------------------------------------
  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return j(401, { error: 'Missing token' });

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  // Both checks: explicit Lounge admin OR the super-admin override.
  // Either is sufficient.
  const [{ data: isLngAdmin, error: lngErr }, { data: isSuper, error: superErr }] =
    await Promise.all([
      userClient.rpc('auth_is_lng_admin'),
      userClient.rpc('auth_is_super_admin'),
    ]);
  if (lngErr || superErr) {
    // Don't leak the underlying error to the caller — but log it for ops.
    console.error('[geocode-address] admin RPC failed:', lngErr ?? superErr);
    return j(500, { error: 'Could not verify admin status' });
  }
  if (isLngAdmin !== true && isSuper !== true) {
    return j(403, { error: 'Admin only' });
  }

  // --- 2. Body parse + normalisation -------------------------------------
  let body: { addresses?: AddressInput[] };
  try {
    body = await req.json();
  } catch {
    return j(400, { error: 'Bad JSON' });
  }
  const raw = Array.isArray(body.addresses) ? body.addresses : [];
  if (raw.length === 0) return j(200, { results: [], partial_failures: [] });
  if (raw.length > MAX_BATCH) {
    return j(400, { error: `Batch size ${raw.length} exceeds max ${MAX_BATCH}` });
  }

  // Normalise + drop entries that can't form a valid cache key.
  const normalised: NormalisedAddress[] = [];
  const skipped: { line1: string; postcode: string; reason: string }[] = [];
  for (const a of raw) {
    if (!a || typeof a.line1 !== 'string' || typeof a.postcode !== 'string') {
      skipped.push({ line1: String(a?.line1 ?? ''), postcode: String(a?.postcode ?? ''), reason: 'invalid input' });
      continue;
    }
    const line1_norm = a.line1.trim().replace(/\s+/g, ' ').toLowerCase();
    const postcode_norm = a.postcode.replace(/\s+/g, '').toUpperCase();
    if (!line1_norm) {
      skipped.push({ line1: a.line1, postcode: a.postcode, reason: 'line1 empty after normalisation' });
      continue;
    }
    if (!UK_POSTCODE_RE.test(postcode_norm)) {
      skipped.push({ line1: a.line1, postcode: a.postcode, reason: 'postcode not in UK shape' });
      continue;
    }
    normalised.push({ raw: a, line1_norm, postcode_norm });
  }
  if (normalised.length === 0) {
    return j(200, { results: [], partial_failures: skipped });
  }

  // --- 3. Cache lookup ---------------------------------------------------
  // Service-role client bypasses RLS for the cache read/upsert. The admin
  // gate above is the auth check; RLS on the table is defense-in-depth
  // for any other access path.
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Postgrest's `.in('postcode_norm', […])` narrows the candidate set
  // by postcode (single-column index). The composite line1+postcode
  // match is then done in JS on the returned rows. Cardinality per
  // postcode is small (< 20 in practice) so this is efficient.
  const postcodes = Array.from(new Set(normalised.map((n) => n.postcode_norm)));
  const cacheRes = await supabase
    .from('lng_address_geocodes')
    .select('line1_norm, postcode_norm, lat, lng')
    .in('postcode_norm', postcodes);
  if (cacheRes.error) {
    return j(500, { error: `cache: ${cacheRes.error.message}` });
  }
  const cached = (cacheRes.data ?? []) as CachedGeocode[];
  const cachedKey = (l: string, p: string) => `${l}|${p}`;
  const cachedMap = new Map<string, CachedGeocode>();
  for (const c of cached) cachedMap.set(cachedKey(c.line1_norm, c.postcode_norm), c);

  const hits: CachedGeocode[] = [];
  const misses: NormalisedAddress[] = [];
  for (const n of normalised) {
    const found = cachedMap.get(cachedKey(n.line1_norm, n.postcode_norm));
    if (found) hits.push(found);
    else misses.push(n);
  }

  // --- 4. Geocode misses (serial, like geocode-postcode) -----------------
  // Loud-failure rule: if every miss fails AND we have no cache hits to
  // fall back on, surface a 502 with the first error message rather than
  // a silent empty list. A blank map with no signal is the trap.
  const fresh: CachedGeocode[] = [];
  const failures: { line1: string; postcode: string; reason: string }[] = [...skipped];
  if (misses.length > 0) {
    if (!GOOGLE_GEOCODING_API_KEY) {
      await logFailure(supabase, 'critical', 'GOOGLE_GEOCODING_API_KEY not configured', {
        miss_count: misses.length,
      });
      return j(500, { error: 'GOOGLE_GEOCODING_API_KEY not configured' });
    }
    for (const miss of misses) {
      try {
        const result = await geocodeAddress(miss, GOOGLE_GEOCODING_API_KEY);
        if (result) fresh.push(result);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        failures.push({ line1: miss.raw.line1, postcode: miss.raw.postcode, reason });
        console.error(`[geocode-address] ${miss.line1_norm} ${miss.postcode_norm}:`, reason);
      }
    }
    if (fresh.length > 0) {
      const upsert = await supabase.from('lng_address_geocodes').upsert(
        fresh.map((f) => ({
          line1_norm: f.line1_norm,
          postcode_norm: f.postcode_norm,
          lat: f.lat,
          lng: f.lng,
          source: 'google_geocoding',
        })),
        { onConflict: 'line1_norm,postcode_norm' },
      );
      if (upsert.error) {
        // Cache write failure is non-fatal for this request — return the
        // fresh values, but log so the operator sees it.
        console.error('[geocode-address] cache upsert failed:', upsert.error);
        await logFailure(supabase, 'error', `Address geocode cache upsert failed: ${upsert.error.message}`, {
          fresh_count: fresh.length,
        });
      }
    }
    // Hard error path: every Google call failed AND nothing was cached.
    if (fresh.length === 0 && hits.length === 0 && misses.length > 0) {
      await logFailure(
        supabase,
        'critical',
        `Geocoding rejected every address: ${failures[0]?.reason ?? 'unknown'}`,
        { failures },
      );
      return j(502, {
        error: `Geocoding API rejected the request: ${failures[0]?.reason ?? 'unknown'}`,
        partial_failures: failures,
      });
    }
    if (failures.length > 0) {
      await logFailure(
        supabase,
        'warning',
        `Geocoding rejected ${failures.length}/${misses.length + skipped.length} addresses`,
        { failures },
      );
    }
  }

  return j(200, { results: [...hits, ...fresh], partial_failures: failures });
});

async function logFailure(
  supabase: ReturnType<typeof createClient>,
  severity: 'info' | 'warning' | 'error' | 'critical',
  message: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await supabase.from('lng_system_failures').insert({
      source: 'geocode-address',
      severity,
      message,
      context,
    });
  } catch (e) {
    console.error('[geocode-address] failure log insert failed:', e);
  }
}

async function geocodeAddress(
  addr: NormalisedAddress,
  apiKey: string,
): Promise<CachedGeocode | null> {
  // Compose a Google-friendly query string. We submit the *raw* line1
  // (not the normalised form) because Google handles capitalisation
  // and abbreviations better than its lowercased equivalent. City is
  // optional — if present it disambiguates streets that share names
  // across UK regions.
  const cityPart = addr.raw.city ? `, ${addr.raw.city.trim()}` : '';
  const query = `${addr.raw.line1.trim()}${cityPart}, ${addr.postcode_norm}`;
  const params = new URLSearchParams({
    address: query,
    components: 'country:GB',
    key: apiKey,
  });
  const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}`);
  }
  const body = (await r.json()) as {
    status: string;
    error_message?: string;
    results?: Array<{
      geometry?: {
        location?: { lat: number; lng: number };
        location_type?: string;
      };
    }>;
  };
  if (body.status !== 'OK' && body.status !== 'ZERO_RESULTS') {
    throw new Error(`Google: ${body.status} ${body.error_message ?? ''}`);
  }
  if (body.status === 'ZERO_RESULTS' || !body.results || body.results.length === 0) {
    return null;
  }
  const loc = body.results[0]?.geometry?.location;
  if (!loc) return null;
  return {
    line1_norm: addr.line1_norm,
    postcode_norm: addr.postcode_norm,
    lat: loc.lat,
    lng: loc.lng,
  };
}

function j(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
