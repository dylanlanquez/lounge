import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

export type CronJobStatus = 'healthy' | 'pending' | 'stale' | 'missing' | 'disabled';

export interface CronHealthRow {
  jobname: string;
  description: string;
  enabled: boolean;
  job_exists: boolean;
  last_success: string | null;
  // Postgres interval rendered as text, e.g. "02:30:00" or "30:00:00".
  max_staleness: string;
  status: CronJobStatus;
}

export interface CronHealth {
  rows: CronHealthRow[];
  loading: boolean;
  error: string | null;
}

// Reads the per-job health summary exposed by the lng_cron_health() RPC.
// The RPC is SECURITY DEFINER because the cron schema is not directly
// readable by the authenticated role. Returns no patient data.
export function useCronHealth(): CronHealth & { refresh: () => void } {
  const [state, setState] = useState<CronHealth>({ rows: [], loading: true, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc('lng_cron_health');
      if (cancelled) return;
      if (error) {
        setState({ rows: [], loading: false, error: error.message });
        return;
      }
      setState({ rows: (data ?? []) as CronHealthRow[], loading: false, error: null });
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { ...state, refresh: () => setTick((t) => t + 1) };
}
