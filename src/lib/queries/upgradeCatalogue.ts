import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// useUpgradeCatalogueIds — given a list of lng_widget_upgrades.id
// values, returns a Map keyed by upgrade id whose value is the
// catalogue row (lwo_catalogue.id) the upgrade is linked to.
//
// Used by the Arrival staging pre-population path so widget upgrades
// can be staged as catalogue lines without forcing every caller to
// run their own join. Empty Map when the input list is empty (no
// network call) or when the lookup fails (lookup failure surfaces in
// the console; staging silently skips upgrades that didn't resolve so
// the receptionist still gets the rest of the basket).
//
// The mapping is the catalogue_id column on lng_widget_upgrades
// (added when the upgrades catalogue was first populated). Every row
// has a non-null catalogue_id by construction; the helper only
// surfaces non-null values to keep the staging code simple.

export function useUpgradeCatalogueIds(
  upgradeIds: ReadonlyArray<string>,
): Map<string, string> {
  const [map, setMap] = useState<Map<string, string>>(() => new Map());
  // Stable join-key for the dependency array so an array literal in
  // the parent doesn't refire on every render.
  const cacheKey = upgradeIds.length === 0 ? '' : upgradeIds.slice().sort().join('|');

  useEffect(() => {
    if (upgradeIds.length === 0) {
      setMap(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('lng_widget_upgrades')
        .select('id, catalogue_id')
        .in('id', upgradeIds);
      if (cancelled) return;
      if (error) {
        // Surface but don't crash — Arrival's pre-fill path silently
        // skips unresolved upgrades.
        console.error('[useUpgradeCatalogueIds] query failed', error);
        setMap(new Map());
        return;
      }
      const next = new Map<string, string>();
      for (const r of (data ?? []) as Array<{ id: string; catalogue_id: string | null }>) {
        if (r.catalogue_id) next.set(r.id, r.catalogue_id);
      }
      setMap(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return map;
}
