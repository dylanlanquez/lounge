import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

export interface CalendlyTypeMapRow {
  id: string;
  label: string;
  catalogue_id: string;
  created_at: string;
  catalogue_name: string;
  catalogue_category: string;
}

interface RawRow {
  id: string;
  label: string;
  catalogue_id: string;
  created_at: string;
  catalogue: { name: string; category: string } | { name: string; category: string }[] | null;
}

export function useCalendlyTypeMap(): {
  rows: CalendlyTypeMapRow[];
  // Map keyed by lower-cased trimmed label for O(1) lookup in Arrival.tsx.
  byLabel: Map<string, CalendlyTypeMapRow>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [rows, setRows] = useState<CalendlyTypeMapRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error: err } = await supabase
        .from('lng_calendly_type_map')
        .select('id, label, catalogue_id, created_at, catalogue:lwo_catalogue ( name, category )')
        .order('label');
      if (cancelled) return;
      if (err) {
        if (err.code === 'PGRST200' || err.code === '42P01') {
          setRows([]);
          setError(null);
        } else {
          setError(err.message);
        }
        setLoading(false);
        return;
      }
      const mapped = (data ?? []).map((r) => {
        const raw = r as unknown as RawRow;
        const cat = Array.isArray(raw.catalogue) ? raw.catalogue[0] : raw.catalogue;
        return {
          id: raw.id,
          label: raw.label,
          catalogue_id: raw.catalogue_id,
          created_at: raw.created_at,
          catalogue_name: cat?.name ?? '',
          catalogue_category: cat?.category ?? '',
        };
      });
      setRows(mapped);
      setError(null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const byLabel = new Map(rows.map((r) => [r.label.toLowerCase().trim(), r]));

  return { rows, byLabel, loading, error, refresh };
}

export async function addCalendlyTypeMap(
  label: string,
  catalogue_id: string
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('lng_calendly_type_map')
    .insert({ label: label.trim(), catalogue_id });
  return { error: error?.message ?? null };
}

export async function deleteCalendlyTypeMap(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from('lng_calendly_type_map').delete().eq('id', id);
  return { error: error?.message ?? null };
}
