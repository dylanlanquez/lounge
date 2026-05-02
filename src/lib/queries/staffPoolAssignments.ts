import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// Staff ⇄ staff-role pool assignments. Backed by the
// lng_staff_pool_assignments table seeded in the
// 20260502000006 migration. The pool's capacity is recomputed by a
// DB trigger on every insert/delete here AND on every staff
// status flip — so the UI never has to compute capacity itself.
//
// All writes flow through public.lng_set_staff_pool_assignments(),
// an RPC that diffs the desired final set against the current rows
// in a single transaction. The "Manage staff" modal collects the
// final set and calls this once on Save; no per-checkbox round-trip.

export interface StaffPoolAssignmentRow {
  staff_member_id: string;
  pool_id: string;
  assigned_at: string;
  assigned_by: string | null;
}

interface UseAssignmentsResult {
  /** Just the staff_member_ids assigned to the pool, sorted by assigned_at desc. */
  staffMemberIds: string[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Reads the current assignments for a single pool. Used by the
// "Manage staff" modal to seed initial checkbox state and by the
// PoolRow chip list to show "Sarah, Tom · 2 assigned".
export function useStaffPoolAssignments(poolId: string | null): UseAssignmentsResult {
  const [staffMemberIds, setStaffMemberIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!poolId) {
      setStaffMemberIds([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const { data, error: err } = await supabase
        .from('lng_staff_pool_assignments')
        .select('staff_member_id, assigned_at')
        .eq('pool_id', poolId)
        .order('assigned_at', { ascending: false });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setStaffMemberIds([]);
      } else {
        setStaffMemberIds(
          ((data ?? []) as { staff_member_id: string }[]).map((r) => r.staff_member_id),
        );
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [poolId, tick]);

  return { staffMemberIds, loading, error, refresh };
}

// Returns the union of all staff↔pool assignments grouped by pool —
// keyed by pool_id. Lets the PoolGroup render every pool's assigned
// staff list without one query per pool.
export function useAllStaffPoolAssignments(): {
  byPoolId: Record<string, string[]>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [byPoolId, setByPoolId] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const { data, error: err } = await supabase
        .from('lng_staff_pool_assignments')
        .select('staff_member_id, pool_id, assigned_at')
        .order('assigned_at', { ascending: false });
      if (cancelled) return;
      if (err) {
        // Pre-migration safety: 42P01 = relation doesn't exist. Fail
        // soft with empty map so the Conflicts tab still renders.
        if (err.code === '42P01') {
          setByPoolId({});
        } else {
          setError(err.message);
          setByPoolId({});
        }
      } else {
        const next: Record<string, string[]> = {};
        for (const row of (data ?? []) as StaffPoolAssignmentRow[]) {
          const list = next[row.pool_id] ?? [];
          list.push(row.staff_member_id);
          next[row.pool_id] = list;
        }
        setByPoolId(next);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { byPoolId, loading, error, refresh };
}

// Atomically replace the staff set for a pool. Calls the
// lng_set_staff_pool_assignments RPC, which:
//   1. Verifies the caller is a Lounge admin or super-admin.
//   2. Verifies the pool exists and is kind=staff_role.
//   3. Deletes any current assignment not in the new set.
//   4. Inserts any in the new set that aren't already there.
// The recompute trigger fires per row, leaving the pool's capacity
// at exactly count(active staff in the new set).
export async function setStaffPoolAssignments(
  poolId: string,
  staffMemberIds: string[],
): Promise<void> {
  const { error } = await supabase.rpc('lng_set_staff_pool_assignments', {
    p_pool_id: poolId,
    p_staff_ids: staffMemberIds,
  });
  if (error) throw new Error(error.message);
}
