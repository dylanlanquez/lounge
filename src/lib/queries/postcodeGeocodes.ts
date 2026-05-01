import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { logFailure } from '../failureLog.ts';

// Geocode read-side hook for the visitor heatmap.
//
// Two-step flow per call:
//   1. SELECT cached entries from lng_postcode_geocodes for the
//      given outwards (instant, no network if everything's cached).
//   2. For any cache misses, POST to the geocode-postcode edge
//      function which fans out to Google Geocoding, upserts into
//      the cache, and returns the fresh entries.
//
// Both steps are loud about failures: anything unexpected throws
// into the hook's error state AND lands a row in
// lng_system_failures via logFailure.

export interface PostcodeGeocode {
  outward: string;
  lat: number;
  lng: number;
}

interface Result {
  data: PostcodeGeocode[];
  loading: boolean;
  error: string | null;
}

const BATCH_SIZE = 50;

export function usePostcodeGeocodes(outwards: string[]): Result {
  const [data, setData] = useState<PostcodeGeocode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Stable key so repeated identical inputs don't refetch.
  const sortedKey = [...outwards]
    .map((o) => o.toUpperCase())
    .filter((o) => o !== 'UNKNOWN' && o.length > 0)
    .sort()
    .join(',');

  useEffect(() => {
    if (!sortedKey) {
      setData([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const targets = sortedKey.split(',');

    (async () => {
      try {
        // 1. Cache hit pass.
        const cacheRes = await supabase
          .from('lng_postcode_geocodes')
          .select('outward, lat, lng')
          .in('outward', targets);
        if (cancelled) return;
        if (cacheRes.error) throw new Error(`cache: ${cacheRes.error.message}`);
        const cached = (cacheRes.data ?? []) as PostcodeGeocode[];
        const cachedSet = new Set(cached.map((c) => c.outward));
        const misses = targets.filter((o) => !cachedSet.has(o));

        // 2. Edge function for misses, batched.
        const fresh: PostcodeGeocode[] = [];
        if (misses.length > 0) {
          const { data: sessionData } = await supabase.auth.getSession();
          const token = sessionData.session?.access_token;
          if (!token) throw new Error('Not signed in');
          const ref = supabaseProjectRef();
          for (let i = 0; i < misses.length; i += BATCH_SIZE) {
            const chunk = misses.slice(i, i + BATCH_SIZE);
            const r = await fetch(
              `https://${ref}.functions.supabase.co/geocode-postcode`,
              {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ outwards: chunk }),
              },
            );
            const body = (await r.json()) as { results?: PostcodeGeocode[]; error?: string };
            if (!r.ok) throw new Error(body.error ?? `Geocode batch failed (${r.status})`);
            if (Array.isArray(body.results)) {
              for (const g of body.results) {
                if (typeof g.lat === 'number' && typeof g.lng === 'number') {
                  fresh.push({ outward: g.outward, lat: g.lat, lng: g.lng });
                }
              }
            }
          }
        }

        if (cancelled) return;
        setData([...cached, ...fresh]);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load geocodes';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'reports.postcode_geocodes',
          severity: 'error',
          message,
          context: { count: targets.length },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sortedKey]);

  return { data, loading, error };
}

function supabaseProjectRef(): string {
  const url = new URL(import.meta.env.VITE_SUPABASE_URL);
  return url.hostname.split('.')[0]!;
}
