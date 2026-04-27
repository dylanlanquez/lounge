import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

export interface CurrentLocationRow {
  id: string;
  name: string;
  type: string;
  city: string | null;
}

interface Result {
  data: CurrentLocationRow | null;
  loading: boolean;
  error: string | null;
}

// The receptionist's current location, derived via auth_location_id() RLS.
// We just SELECT * FROM locations and RLS narrows to the row we are scoped to.

export function useCurrentLocation(): Result {
  const [data, setData] = useState<CurrentLocationRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // The receptionist sees only their own location via RLS; pick the first.
      const { data: rows, error: err } = await supabase
        .from('locations')
        .select('id, name, type, city')
        .limit(1);
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      setData((rows && rows[0]) as CurrentLocationRow | null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}
