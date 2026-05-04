import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';

// Lounge per-product upgrades. Each catalogue row owns its own upgrade
// rows — name, code, display position, single-arch price, both-arches
// price. Replaces the old registry + link table model: shared "Scalloped"
// rows that linked to many products got collapsed into one row per
// product so the admin UI is per-product (cleaner, no irrelevant
// upgrades showing under products they don't apply to) and uniqueness
// is scoped to (catalogue_id, code).

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
// Unknown upgrades (no live row, e.g. an upgrade whose product was
// later deleted) fall back to after_device. Lookup is by upgrade_id
// snapshot on the cart_item_upgrade row.
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
  catalogue_id: string;
  code: string;
  name: string;
  description: string | null;
  display_position: UpgradeDisplayPosition;
  sort_order: number;
  active: boolean;
  // Pounds. Applied when the cart line is single-arch or non-arch.
  price: number;
  // Pounds. Applied when the parent line is bought as both arches.
  // NULL on products without arch options.
  both_arches_price: number | null;
  created_at: string;
  updated_at: string;
}

const UPGRADE_COLUMNS =
  'id, catalogue_id, code, name, description, display_position, sort_order, active, price, both_arches_price, created_at, updated_at';

interface UpgradesResult {
  rows: UpgradeRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Picker + LWO position lookup: every active upgrade row across the
// catalogue. The picker filters per-row in memory; the LWO uses it to
// build an id → display_position map. One small fetch keeps the bottom
// sheet responsive when an admin opens many product rows in a row.
export function useAllActiveUpgrades(): UpgradesResult {
  const [rows, setRows] = useState<UpgradeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading('upg-all-active');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('lng_catalogue_upgrades')
        .select(UPGRADE_COLUMNS)
        .eq('active', true)
        .order('sort_order', { ascending: true });
      if (cancelled) return;
      if (err) {
        // Pre-migration shadow envs may be missing the table; treat as
        // empty rather than crash.
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
  }, [tick, settle]);

  return { rows, loading, error, refresh };
}

// Admin row editor: load every upgrade row for one catalogue row,
// active or not, so the editor can show inactive entries with a
// reactivate affordance.
export function useUpgradesForCatalogue(catalogueId: string | null): UpgradesResult {
  const [rows, setRows] = useState<UpgradeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading(catalogueId);

  useEffect(() => {
    if (!catalogueId) {
      setRows([]);
      settle();
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('lng_catalogue_upgrades')
        .select(UPGRADE_COLUMNS)
        .eq('catalogue_id', catalogueId)
        .order('sort_order', { ascending: true });
      if (cancelled) return;
      if (err) {
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
  }, [catalogueId, tick, settle]);

  return { rows, loading, error, refresh };
}

export interface UpgradeDraft {
  id?: string;
  catalogue_id: string;
  code: string;
  name: string;
  description: string | null;
  display_position: UpgradeDisplayPosition;
  sort_order: number;
  active: boolean;
  price: number;
  both_arches_price: number | null;
}

export async function upsertUpgrade(draft: UpgradeDraft): Promise<UpgradeRow> {
  const payload = {
    catalogue_id: draft.catalogue_id,
    code: draft.code,
    name: draft.name,
    description: draft.description,
    display_position: draft.display_position,
    sort_order: draft.sort_order,
    active: draft.active,
    price: draft.price,
    both_arches_price: draft.both_arches_price,
  };
  if (draft.id) {
    const { data, error } = await supabase
      .from('lng_catalogue_upgrades')
      .update(payload)
      .eq('id', draft.id)
      .select(UPGRADE_COLUMNS)
      .single();
    if (error || !data) throw new Error(error?.message ?? 'Update failed');
    return data as UpgradeRow;
  }
  const { data, error } = await supabase
    .from('lng_catalogue_upgrades')
    .insert(payload)
    .select(UPGRADE_COLUMNS)
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Insert failed');
  return data as UpgradeRow;
}

export async function setUpgradeActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('lng_catalogue_upgrades').update({ active }).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteUpgrade(id: string): Promise<void> {
  const { error } = await supabase.from('lng_catalogue_upgrades').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
