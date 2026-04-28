import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// Mirror of the lwo_catalogue table that Checkpoint already manages. Lounge
// reads + writes the same rows so prices and SKUs never drift between the
// two surfaces. When Checkpoint's appointments retire, this catalogue
// becomes Lounge-owned without a migration.
//
// Prices are stored as numeric(10,2) pounds in Postgres, NOT pence. We keep
// pounds in the JS layer for everything that touches the catalogue
// directly, and only convert to pence (× 100, rounded) when copying a row
// into lng_cart_items at picker time.

export type ArchMatch = 'any' | 'single' | 'both';

export interface CatalogueRow {
  id: string;
  code: string;
  category: string;
  name: string;
  description: string | null;
  unit_price: number; // pounds
  extra_unit_price: number | null; // pounds; null → no volume discount
  unit_label: string | null;
  service_type: string | null;
  product_key: string | null;
  repair_variant: string | null;
  arch_match: ArchMatch;
  sort_order: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

interface CatalogueResult {
  rows: CatalogueRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Read every row (active + inactive). For the Admin Catalogue tab.
export function useCatalogueAll(): CatalogueResult {
  return useCatalogueQuery({ activeOnly: false });
}

// Read only active rows. For the picker on the visit / arrival flow.
export function useCatalogueActive(): CatalogueResult {
  return useCatalogueQuery({ activeOnly: true });
}

function useCatalogueQuery({ activeOnly }: { activeOnly: boolean }): CatalogueResult {
  const [rows, setRows] = useState<CatalogueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let q = supabase
        .from('lwo_catalogue')
        .select(
          'id, code, category, name, description, unit_price, extra_unit_price, unit_label, service_type, product_key, repair_variant, arch_match, sort_order, active, created_at, updated_at'
        )
        .order('category', { ascending: true })
        .order('sort_order', { ascending: true });
      if (activeOnly) q = q.eq('active', true);
      const { data, error: err } = await q;
      if (cancelled) return;
      if (err) {
        // 42P01 (relation not found) shouldn't happen in production —
        // lwo_catalogue is a Checkpoint table that pre-dates Lounge — but
        // treat it as empty rather than crash so a misconfigured shadow
        // env doesn't blank the admin page.
        if (err.code === '42P01') {
          setRows([]);
          setError(null);
        } else {
          setError(err.message);
        }
        setLoading(false);
        return;
      }
      setRows((data ?? []) as CatalogueRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeOnly, tick]);

  return { rows, loading, error, refresh };
}

// Persist a draft catalogue row. Insert when id is missing, otherwise
// update. Returns the saved row.
export async function upsertCatalogueRow(
  draft: Omit<CatalogueRow, 'id' | 'created_at' | 'updated_at'> & { id?: string }
): Promise<CatalogueRow> {
  const payload = {
    code: draft.code,
    category: draft.category,
    name: draft.name,
    description: draft.description,
    unit_price: draft.unit_price,
    extra_unit_price: draft.extra_unit_price,
    unit_label: draft.unit_label,
    service_type: draft.service_type,
    product_key: draft.product_key,
    repair_variant: draft.repair_variant,
    arch_match: draft.arch_match,
    sort_order: draft.sort_order,
    active: draft.active,
  };
  if (draft.id) {
    const { data, error } = await supabase
      .from('lwo_catalogue')
      .update(payload)
      .eq('id', draft.id)
      .select('*')
      .single();
    if (error || !data) throw new Error(error?.message ?? 'Update failed');
    return data as CatalogueRow;
  }
  const { data, error } = await supabase
    .from('lwo_catalogue')
    .insert(payload)
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Insert failed');
  return data as CatalogueRow;
}

// Soft delete via the active flag — never hard-delete because line items
// reference catalogue rows by id, and Checkpoint's locked walk-ins would
// lose their SKU history. Matches Checkpoint's deactivation pattern.
export async function setCatalogueActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('lwo_catalogue').update({ active }).eq('id', id);
  if (error) throw new Error(error.message);
}
