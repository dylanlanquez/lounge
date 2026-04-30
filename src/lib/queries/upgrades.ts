import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';

// Lounge upgrades catalogue. Pure registry of upgrade names (e.g.
// "Scalloped"). Per-product pricing lives on lng_catalogue_upgrade_links
// so a single upgrade can cost different amounts depending on which
// product it's applied to (Dylan's "Option 2" — fully flexible).

export interface UpgradeRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  sort_order: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UpgradeLinkRow {
  catalogue_id: string;
  upgrade_id: string;
  // Pounds. Price applied when the cart line is single-arch or non-arch.
  price: number;
  // Pounds. Price applied when the parent line is bought as both arches.
  // NULL on products that don't expose arch options.
  both_arches_price: number | null;
  created_at: string;
  updated_at: string;
}

interface UpgradesResult {
  rows: UpgradeRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useUpgradesAll(): UpgradesResult {
  return useUpgradesQuery({ activeOnly: false });
}

export function useUpgradesActive(): UpgradesResult {
  return useUpgradesQuery({ activeOnly: true });
}

function useUpgradesQuery({ activeOnly }: { activeOnly: boolean }): UpgradesResult {
  const [rows, setRows] = useState<UpgradeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading(activeOnly ? 'upg-active' : 'upg-all');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let q = supabase
        .from('lng_catalogue_upgrades')
        .select('id, code, name, description, sort_order, active, created_at, updated_at')
        .order('sort_order', { ascending: true });
      if (activeOnly) q = q.eq('active', true);
      const { data, error: err } = await q;
      if (cancelled) return;
      if (err) {
        // Pre-migration shadow envs may be missing the table; treat as
        // empty rather than crash the admin page.
        if (err.code === '42P01') {
          setRows([]);
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        return;
      }
      setRows((data ?? []) as UpgradeRow[]);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [activeOnly, tick, settle]);

  return { rows, loading, error, refresh };
}

export async function upsertUpgrade(
  draft: Omit<UpgradeRow, 'id' | 'created_at' | 'updated_at'> & { id?: string }
): Promise<UpgradeRow> {
  const payload = {
    code: draft.code,
    name: draft.name,
    description: draft.description,
    sort_order: draft.sort_order,
    active: draft.active,
  };
  if (draft.id) {
    const { data, error } = await supabase
      .from('lng_catalogue_upgrades')
      .update(payload)
      .eq('id', draft.id)
      .select('*')
      .single();
    if (error || !data) throw new Error(error?.message ?? 'Update failed');
    return data as UpgradeRow;
  }
  const { data, error } = await supabase
    .from('lng_catalogue_upgrades')
    .insert(payload)
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Insert failed');
  return data as UpgradeRow;
}

export async function setUpgradeActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('lng_catalogue_upgrades').update({ active }).eq('id', id);
  if (error) throw new Error(error.message);
}

// ─── Links: which upgrades a given catalogue row offers, with prices ───────

interface UpgradeLinksResult {
  links: UpgradeLinkRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// All links across the catalogue. Picker loads this once at open so each
// expanded ProductRow can render its upgrade checklist without spawning
// a fresh query — the link table is small (rows × upgrades).
export function useAllUpgradeLinks(): UpgradeLinksResult {
  const [links, setLinks] = useState<UpgradeLinkRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading('upgrade-links-all');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('lng_catalogue_upgrade_links')
        .select('catalogue_id, upgrade_id, price, both_arches_price, created_at, updated_at');
      if (cancelled) return;
      if (err) {
        if (err.code === '42P01') {
          setLinks([]);
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        return;
      }
      setLinks((data ?? []) as UpgradeLinkRow[]);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [tick, settle]);

  return { links, loading, error, refresh };
}

export function useUpgradeLinksForCatalogue(catalogueId: string | null): UpgradeLinksResult {
  const [links, setLinks] = useState<UpgradeLinkRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading(catalogueId);

  useEffect(() => {
    if (!catalogueId) {
      setLinks([]);
      settle();
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('lng_catalogue_upgrade_links')
        .select('catalogue_id, upgrade_id, price, both_arches_price, created_at, updated_at')
        .eq('catalogue_id', catalogueId);
      if (cancelled) return;
      if (err) {
        if (err.code === '42P01') {
          setLinks([]);
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        return;
      }
      setLinks((data ?? []) as UpgradeLinkRow[]);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [catalogueId, tick, settle]);

  return { links, loading, error, refresh };
}

export async function setUpgradeLink(
  catalogueId: string,
  upgradeId: string,
  price: number,
  bothArchesPrice: number | null
): Promise<void> {
  const payload = {
    catalogue_id: catalogueId,
    upgrade_id: upgradeId,
    price,
    both_arches_price: bothArchesPrice,
  };
  // Postgres upsert by composite primary key.
  const { error } = await supabase
    .from('lng_catalogue_upgrade_links')
    .upsert(payload, { onConflict: 'catalogue_id,upgrade_id' });
  if (error) throw new Error(error.message);
}

export async function removeUpgradeLink(catalogueId: string, upgradeId: string): Promise<void> {
  const { error } = await supabase
    .from('lng_catalogue_upgrade_links')
    .delete()
    .eq('catalogue_id', catalogueId)
    .eq('upgrade_id', upgradeId);
  if (error) throw new Error(error.message);
}
