import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';

// Lounge upgrades catalogue. Pure registry of upgrade names (e.g.
// "Scalloped"). Per-product pricing lives on lng_catalogue_upgrade_links
// so a single upgrade can cost different amounts depending on which
// product it's applied to (Dylan's "Option 2" — fully flexible).

// Where the upgrade renders next to the device name in LWO / product
// tables / cart copy. before_device prefixes ("Scalloped Denture"),
// after_device suffixes ("Denture, scalloped" — the default), own_line
// renders as a separate row in surfaces that allow it.
export type UpgradeDisplayPosition = 'before_device' | 'after_device' | 'own_line';

// Compose a line's display label given the device name and the
// upgrades attached to it. Result splits into:
//
//   title       — prefixed with any before_device upgrades, suffixed
//                 with any after_device upgrades joined by commas.
//   ownLines    — names of upgrades whose position is own_line; each
//                 one wants its own visual row in surfaces that
//                 support it (cart subtitle bullets, LWO extra rows).
//   afterParts  — same after_device names returned separately so a
//                 caller that prefers them in a subtitle (rather than
//                 the title) can pull them out without re-parsing.
//
// Unknown upgrades (no row in the registry) fall back to after_device.
// Display_position lookup is by upgrade_id (cart_item_upgrades carry
// the id snapshot) — when an upgrade has been deleted from the
// registry, the row's upgrade_id is null and we treat it as after.
export interface ComposedUpgradeLabel {
  title: string;
  afterParts: string[];
  ownLines: string[];
}

export function composeUpgradeLabel(
  deviceName: string,
  upgrades: Array<{ upgrade_id: string | null; upgrade_name: string }>,
  positionByUpgradeId: Map<string, UpgradeDisplayPosition>
): ComposedUpgradeLabel {
  const before: string[] = [];
  const after: string[] = [];
  const ownLines: string[] = [];
  for (const u of upgrades) {
    const pos = u.upgrade_id ? positionByUpgradeId.get(u.upgrade_id) ?? 'after_device' : 'after_device';
    if (pos === 'before_device') before.push(u.upgrade_name);
    else if (pos === 'own_line') ownLines.push(u.upgrade_name);
    else after.push(u.upgrade_name);
  }
  const prefix = before.length > 0 ? before.join(' ') + ' ' : '';
  const suffix = after.length > 0 ? ', ' + after.join(', ') : '';
  return {
    title: prefix + deviceName + suffix,
    afterParts: after,
    ownLines,
  };
}

export interface UpgradeRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  display_position: UpgradeDisplayPosition;
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
        .select('id, code, name, description, display_position, sort_order, active, created_at, updated_at')
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
    display_position: draft.display_position,
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
