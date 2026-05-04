import { useCallback, useEffect, useState } from 'react';
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

// ─────────────────────────────────────────────────────────────────────────────
// Editable location — extra columns the admin can write back
// ─────────────────────────────────────────────────────────────────────────────
//
// The `locations` table is shared with Meridian; RLS is disabled on
// it (per Meridian's 20260413_01 migration), so Lounge can update
// the same row Meridian's admin edits. Edits made here show up in
// Meridian and vice versa — the "one source of truth" the user
// asked for.

export interface EditableLocationRow {
  id: string;
  name: string;
  type: string;
  city: string | null;
  address: string | null;
  phone: string | null;
}

interface EditableResult {
  data: EditableLocationRow | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useEditableLocation(): EditableResult {
  const [data, setData] = useState<EditableLocationRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: rows, error: err } = await supabase
        .from('locations')
        .select('id, name, type, city, address, phone')
        .limit(1);
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      setData((rows && rows[0]) as EditableLocationRow | null);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refresh };
}

/** Save name / city / address / phone back to the shared `locations`
 *  row. `id` is required so we don't accidentally update every row. */
export async function saveLocation(input: {
  id: string;
  name: string;
  city: string | null;
  address: string | null;
  phone: string | null;
}): Promise<void> {
  const { error } = await supabase
    .from('locations')
    .update({
      name: input.name,
      city: input.city,
      address: input.address,
      phone: input.phone,
    })
    .eq('id', input.id);
  if (error) throw new Error(`Couldn't save location: ${error.message}`);
}
