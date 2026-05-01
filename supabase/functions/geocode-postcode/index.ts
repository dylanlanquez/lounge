// geocode-postcode
//
// POST { outwards: string[] }
// Returns { results: { outward: string; lat: number; lng: number }[] }
//
// Resolves UK outward postcodes (e.g. "SW1A", "M1", "EH3") to their
// approximate lat/lng centroid via the Google Geocoding API. Hits
// the lng_postcode_geocodes cache first; only outwards that aren't
// already cached fire a network request, and the results are
// upserted on the way back.
//
// Why a server-side function rather than a direct browser call:
//
//   • Keeps the geocoding API key in a Supabase secret —
//     GOOGLE_GEOCODING_API_KEY — separate from the client-side
//     Maps key. Different IP/referrer restrictions, different
//     billing visibility.
//
//   • The cache write happens with the service role so the table
//     stays insert-locked at the RLS layer (only this function can
//     populate it).
//
// Auth: Bearer JWT, any signed-in user. The cache is operationally
// public to authenticated users (the Reports map needs it).
// Rate-limit shape: at most 50 outwards per call so a runaway client
// can't burn through the free Geocoding tier.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GOOGLE_GEOCODING_API_KEY = Deno.env.get('GOOGLE_GEOCODING_API_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const MAX_BATCH = 50;

interface GeocodeResult {
  outward: string;
  lat: number;
  lng: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return j(405, { error: 'Method not allowed' });

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return j(401, { error: 'Missing token' });

  let body: { outwards?: string[] };
  try {
    body = await req.json();
  } catch {
    return j(400, { error: 'Bad JSON' });
  }
  const outwards = Array.isArray(body.outwards) ? body.outwards : [];
  if (outwards.length === 0) return j(200, { results: [] });
  if (outwards.length > MAX_BATCH) {
    return j(400, { error: `Batch size ${outwards.length} exceeds max ${MAX_BATCH}` });
  }

  // Normalise: trim, uppercase, deduplicate, drop anything that
  // doesn't shape like an outward code.
  const normalised = Array.from(
    new Set(
      outwards
        .map((o) => (typeof o === 'string' ? o.trim().toUpperCase().replace(/\s+/g, '') : ''))
        .filter((o) => /^[A-Z]{1,2}\d[A-Z\d]?$/.test(o)),
    ),
  );
  if (normalised.length === 0) return j(200, { results: [] });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Cache lookup.
  const cacheRes = await supabase
    .from('lng_postcode_geocodes')
    .select('outward, lat, lng')
    .in('outward', normalised);
  if (cacheRes.error) return j(500, { error: `cache: ${cacheRes.error.message}` });
  const cached = (cacheRes.data ?? []) as Array<{ outward: string; lat: number; lng: number }>;
  const cachedSet = new Set(cached.map((c) => c.outward));

  const misses = normalised.filter((o) => !cachedSet.has(o));

  // 2. Geocode misses serially. Parallelism would hammer Google's
  //    rate limits and the per-call latency is fine for the Reports
  //    page (initial cohort of outwards is small after the first
  //    visit; later opens are nearly all cache hits).
  const fresh: GeocodeResult[] = [];
  if (misses.length > 0) {
    if (!GOOGLE_GEOCODING_API_KEY) {
      return j(500, { error: 'GOOGLE_GEOCODING_API_KEY not configured' });
    }
    for (const outward of misses) {
      try {
        const result = await geocodeOutward(outward, GOOGLE_GEOCODING_API_KEY);
        if (result) fresh.push(result);
      } catch (e) {
        // Don't abort the whole batch on a single failure — log and
        // move on. The caller still gets cached + remaining results.
        console.error(`[geocode-postcode] ${outward}:`, e);
      }
    }
    if (fresh.length > 0) {
      const upsert = await supabase
        .from('lng_postcode_geocodes')
        .upsert(
          fresh.map((f) => ({ outward: f.outward, lat: f.lat, lng: f.lng, source: 'google_geocoding' })),
          { onConflict: 'outward' },
        );
      if (upsert.error) {
        // Cache write failure is non-fatal — return the fresh
        // values to the caller, but log the failure so the operator
        // sees it.
        console.error('[geocode-postcode] cache upsert failed:', upsert.error);
      }
    }
  }

  return j(200, { results: [...cached, ...fresh] });
});

async function geocodeOutward(outward: string, apiKey: string): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({
    address: outward,
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
      geometry?: { location?: { lat: number; lng: number } };
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
  return { outward, lat: loc.lat, lng: loc.lng };
}

function j(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
