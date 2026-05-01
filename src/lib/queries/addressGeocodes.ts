import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { logFailure } from '../failureLog.ts';

// Address-level geocode hook — companion to usePostcodeGeocodes for
// the admin-only address heatmap in Reports → Demographics.
//
// Unlike the postcode hook, this one does NOT read the cache table
// directly. The lng_address_geocodes table holds personal data and
// access is centralised through the geocode-address edge function,
// which:
//
//   • Verifies the caller is a Lounge admin or super admin (RLS on
//     the cache is defence-in-depth, the function is the gate).
//   • Looks up cached entries with the service-role client.
//   • Geocodes any misses via Google.
//   • Upserts misses into the cache.
//
// Net effect: one POST per render with a stable input set, no second
// round-trip to PostgREST. Non-admins receive 403 from the function
// and surface that as the hook's error state.
//
// Normalisation contract — must match the edge function exactly:
//
//   • line1_norm    = trim, collapse internal whitespace, lowercase.
//   • postcode_norm = trim, remove ALL whitespace, uppercase.
//
// The hook keys its sortedKey on the normalised pairs so identical
// inputs in different surface forms ("10 Acacia Avenue" vs " 10
// acacia avenue ") are treated as one and the effect doesn't refetch.

export interface AddressInput {
  line1: string;
  postcode: string;
  city?: string;
}

export interface AddressGeocode {
  line1_norm: string;
  postcode_norm: string;
  lat: number;
  lng: number;
}

interface Result {
  data: AddressGeocode[];
  loading: boolean;
  error: string | null;
}

const BATCH_SIZE = 50;

function normaliseLine1(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalisePostcode(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

export function useAddressGeocodes(addresses: AddressInput[]): Result {
  const [data, setData] = useState<AddressGeocode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Stable cache key built from the normalised pairs. Sorted so the
  // same set in different orders doesn't refetch.
  const sortedKey = addresses
    .map((a) => `${normaliseLine1(a.line1)}|${normalisePostcode(a.postcode)}`)
    .filter((s) => {
      const [l, p] = s.split('|');
      return !!l && !!p;
    })
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

    (async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) throw new Error('Not signed in');
        const ref = supabaseProjectRef();

        const collected: AddressGeocode[] = [];
        for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
          const chunk = addresses.slice(i, i + BATCH_SIZE);
          if (chunk.length === 0) continue;
          const r = await fetch(
            `https://${ref}.functions.supabase.co/geocode-address`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ addresses: chunk }),
            },
          );
          const body = (await r.json()) as {
            results?: AddressGeocode[];
            error?: string;
          };
          if (!r.ok) {
            throw new Error(body.error ?? `Address geocode batch failed (${r.status})`);
          }
          if (Array.isArray(body.results)) {
            for (const g of body.results) {
              if (typeof g.lat === 'number' && typeof g.lng === 'number') {
                collected.push(g);
              }
            }
          }
        }

        if (cancelled) return;
        setData(collected);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load address geocodes';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'reports.address_geocodes',
          severity: 'error',
          message,
          context: { count: addresses.length },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // sortedKey covers content; the addresses array reference change
    // alone shouldn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedKey]);

  return { data, loading, error };
}

function supabaseProjectRef(): string {
  const url = new URL(import.meta.env.VITE_SUPABASE_URL);
  return url.hostname.split('.')[0]!;
}
