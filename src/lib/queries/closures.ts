import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// Clinic closures / blocked dates per booking type (lng_closures,
// migration 20260610000004). A closure is whole-day. service_type null
// = whole clinic (all in-person types, NOT virtual impressions, which
// run off a separate team); a value blocks just that type.
//
// reason is ADMIN-ONLY and must never reach a customer surface.
//
// Reads go direct (RLS select for authenticated); writes go through the
// is_admin-gated RPCs lng_add_closure / lng_delete_closure.

// service_type null is represented to callers as the 'whole_clinic'
// sentinel so option lists / keys stay total; mapped to null at the RPC.
export type ClosureScope =
  | 'whole_clinic'
  | 'denture_repair'
  | 'click_in_veneers'
  | 'same_day_appliance'
  | 'impression_appointment'
  | 'virtual_impression_appointment'
  | 'other';

export interface Closure {
  id: string;
  closed_date: string; // 'YYYY-MM-DD'
  scope: ClosureScope;
  reason: string | null;
}

const toScope = (serviceType: string | null): ClosureScope =>
  serviceType === null ? 'whole_clinic' : (serviceType as ClosureScope);

const toServiceType = (scope: ClosureScope): string | null =>
  scope === 'whole_clinic' ? null : scope;

export async function fetchClosures(): Promise<Closure[]> {
  const { data, error } = await supabase
    .from('lng_closures')
    .select('id, closed_date, service_type, reason')
    .order('closed_date', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    closed_date: r.closed_date as string,
    scope: toScope((r.service_type as string | null) ?? null),
    reason: (r.reason as string | null) ?? null,
  }));
}

export async function addClosure(args: {
  date: string; // 'YYYY-MM-DD'
  scope: ClosureScope;
  reason?: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc('lng_add_closure', {
    p_closed_date: args.date,
    p_service_type: toServiceType(args.scope),
    p_reason: args.reason ?? null,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function deleteClosure(id: string): Promise<void> {
  const { error } = await supabase.rpc('lng_delete_closure', { p_id: id });
  if (error) throw new Error(error.message);
}

// Upsert a closure for every date in [from, to] (inclusive) for one
// scope, in a single atomic call. Single day = from === to.
export async function addClosureRange(args: {
  from: string; // 'YYYY-MM-DD'
  to: string; // 'YYYY-MM-DD'
  scope: ClosureScope;
  reason?: string | null;
}): Promise<number> {
  const { data, error } = await supabase.rpc('lng_add_closure_range', {
    p_from: args.from,
    p_to: args.to,
    p_service_type: toServiceType(args.scope),
    p_reason: args.reason ?? null,
  });
  if (error) throw new Error(error.message);
  return (data as number) ?? 0;
}

// Clear several closure rows at once (used to remove a whole range).
export async function deleteClosures(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase.rpc('lng_delete_closures', { p_ids: ids });
  if (error) throw new Error(error.message);
}

// Loads the full closure list with a manual refetch for after writes.
export function useClosures(): {
  closures: Closure[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [closures, setClosures] = useState<Closure[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const rows = await fetchClosures();
        if (cancelled) return;
        setClosures(rows);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load closures');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { closures, loading, error, reload };
}
