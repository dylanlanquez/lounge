import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

export interface TerminalReaderRow {
  id: string;
  friendly_name: string;
  stripe_reader_id: string;
  stripe_location_id: string;
  status: 'online' | 'offline' | 'unknown';
  last_seen_at: string | null;
}

interface Result {
  data: TerminalReaderRow[];
  loading: boolean;
  error: string | null;
}

// Returns readers visible to the receptionist (RLS scopes to their location).
export function useTerminalReaders(): Result {
  const [data, setData] = useState<TerminalReaderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('lng_terminal_readers')
        .select('id, friendly_name, stripe_reader_id, stripe_location_id, status, last_seen_at')
        .order('friendly_name', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      setData((rows ?? []) as TerminalReaderRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}
