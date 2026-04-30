import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// Staff = any accounts row that has a login_email set. Powers the
// Admin > Staff tab where managers can be toggled (sets
// accounts.is_manager). Listed alphabetically by display name so
// the table is stable across edits.

export interface StaffRow {
  id: string;
  display_name: string;
  login_email: string;
  is_manager: boolean;
}

interface Result {
  data: StaffRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useStaff(): Result {
  const [data, setData] = useState<StaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('accounts')
        .select('id, first_name, last_name, name, login_email, is_manager')
        .not('login_email', 'is', null);
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const mapped: StaffRow[] = ((rows ?? []) as Array<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        name: string | null;
        login_email: string | null;
        is_manager: boolean | null;
      }>)
        .map((r) => {
          const fn = r.first_name?.trim();
          const ln = r.last_name?.trim();
          const display = fn && ln ? `${fn} ${ln}` : fn ?? ln ?? r.name?.trim() ?? r.login_email ?? r.id;
          return {
            id: r.id,
            display_name: display,
            login_email: r.login_email ?? '',
            is_manager: r.is_manager === true,
          };
        })
        .sort((a, b) => a.display_name.localeCompare(b.display_name));
      setData(mapped);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { data, loading, error, refresh };
}

export async function setIsManager(accountId: string, isManager: boolean): Promise<void> {
  const { error } = await supabase
    .from('accounts')
    .update({ is_manager: isManager })
    .eq('id', accountId);
  if (error) throw new Error(error.message);
}
