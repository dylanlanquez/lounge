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

// The receptionist's current location, derived from THEIR OWN
// accounts.location_id row.
//
// The earlier shape (`select * from locations limit 1` and trust RLS
// to narrow to a single row) silently fell over the moment a staff
// member had visibility over more than one location: Postgres returns
// whichever row it surfaces first, with no guarantee it matches the
// staff member's home clinic. In production that meant a New Booking
// for a Dylan-Lane session sometimes resolved to the Glasgow lab and
// sometimes to the Glasgow practice; every booking the form created
// silently went to whichever location won that coin flip, and the
// conflict checker (which is per-location) correctly said "free" for
// whichever chair the form had picked, even when the OTHER chair was
// fully booked. Receptionist saw bookings stacking on the schedule
// while the system was happily creating new ones at the second
// chair they couldn't tell was there.
//
// Fix: resolve the staff member's account row (via auth_account_id())
// and use ITS `location_id` directly. Deterministic, tied to who is
// logged in, won't drift if the user gains access to another
// location via RLS later.
export function useCurrentLocation(): Result {
  const [data, setData] = useState<CurrentLocationRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Resolve the staff member's account id from auth.uid() (same
      // helper every other Lounge surface uses to stamp actor rows).
      const { data: accountIdRaw, error: accErr } = await supabase.rpc(
        'auth_account_id',
      );
      if (cancelled) return;
      const accountId = (accountIdRaw as string | null) ?? null;
      if (accErr || !accountId) {
        setError(accErr?.message ?? 'No staff account for this session');
        setLoading(false);
        return;
      }
      // Read THIS account's location pointer. Single row by primary key.
      const { data: accountRow, error: accountErr } = await supabase
        .from('accounts')
        .select('location_id')
        .eq('id', accountId)
        .maybeSingle();
      if (cancelled) return;
      if (accountErr) {
        setError(accountErr.message);
        setLoading(false);
        return;
      }
      const locId = (accountRow as { location_id: string | null } | null)?.location_id ?? null;
      if (!locId) {
        setError(
          'Your account is not bound to a location. Admin → Staff to fix.',
        );
        setLoading(false);
        return;
      }
      // Finally, hydrate the location row. By id, no LIMIT, no
      // ambiguity.
      const { data: locRow, error: locErr } = await supabase
        .from('locations')
        .select('id, name, type, city')
        .eq('id', locId)
        .maybeSingle();
      if (cancelled) return;
      if (locErr) {
        setError(locErr.message);
        setLoading(false);
        return;
      }
      setData((locRow as CurrentLocationRow | null) ?? null);
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
  postcode: string | null;
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
      // Only flag `loading` on the very first fetch. Refresh()
      // calls after a save keep existing data on screen so the
      // admin tab doesn't collapse to a Skeleton briefly — that
      // layout shift was bumping the user's scroll back to the
      // top after every save.
      if (tick === 0) setLoading(true);
      const { data: rows, error: err } = await supabase
        .from('locations')
        .select('id, name, type, city, address, postcode, phone')
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

// ─────────────────────────────────────────────────────────────────────────────
// All visible locations — for cross-location reports (Reports → Cash drawer).
// RLS narrows the result set for staff who only see their own location; admins
// / financial managers with broader RLS see every location they can read.
// Used by the location filter dropdown so the same component works whether
// the viewer sees one location or many.
// ─────────────────────────────────────────────────────────────────────────────

export interface LocationOption {
  id: string;
  name: string;
  // Type ('lab' | 'practice' | ...) and city carried so callers
  // that render a richer label ("The Venneir Clinic, lab · Glasgow")
  // can do so without a second query. Older call sites that only
  // read id + name keep working — the extra fields are optional on
  // the type and tolerated by every consumer touched.
  type?: string | null;
  city?: string | null;
}

interface LocationsResult {
  data: LocationOption[] | null;
  loading: boolean;
  error: string | null;
}

export function useLocations(): LocationsResult {
  const [data, setData] = useState<LocationOption[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('locations')
        .select('id, name, type, city')
        .order('name', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      setData((rows ?? []) as LocationOption[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}

/** Save name / city / address / phone back to the shared `locations`
 *  row. `id` is required so we don't accidentally update every row. */
export async function saveLocation(input: {
  id: string;
  name: string;
  city: string | null;
  address: string | null;
  postcode: string | null;
  phone: string | null;
}): Promise<void> {
  const { error } = await supabase
    .from('locations')
    .update({
      name: input.name,
      city: input.city,
      address: input.address,
      postcode: input.postcode,
      phone: input.phone,
    })
    .eq('id', input.id);
  if (error) throw new Error(`Couldn't save location: ${error.message}`);
}
