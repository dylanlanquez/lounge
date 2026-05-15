import { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase.ts';

// useUpgradeCatalogueIds — given a list of lng_widget_upgrades.id
// values, returns a Map keyed by upgrade id whose value is the
// catalogue row (lwo_catalogue.id) the upgrade is linked to, plus a
// `loading` flag the caller can wait on before reading the map.
//
// Used by the Arrival staging pre-population path so widget upgrades
// can be staged as catalogue lines without forcing every caller to
// run their own join. Empty Map when the input list is empty (no
// network call needed; loading is FALSE immediately) or when the
// lookup fails (lookup failure surfaces in the console; staging
// silently skips upgrades that didn't resolve so the receptionist
// still gets the rest of the basket).
//
// loading=true means "we haven't yet completed the lookup for the
// current input list". Callers race-prone in their initial-mount
// effect (Arrival.tsx) MUST gate on this — otherwise they prefill
// the cart from an empty map and the upgrades silently never attach.
//
// The mapping is the catalogue_id column on lng_widget_upgrades
// (added when the upgrades catalogue was first populated). Every row
// has a non-null catalogue_id by construction; the helper only
// surfaces non-null values to keep the staging code simple.

export interface UpgradeCatalogueIdsResult {
  map: Map<string, string>;
  loading: boolean;
}

export function useUpgradeCatalogueIds(
  upgradeIds: ReadonlyArray<string>,
): UpgradeCatalogueIdsResult {
  const [map, setMap] = useState<Map<string, string>>(() => new Map());
  // Stable join-key for the dependency array so an array literal in
  // the parent doesn't refire on every render.
  const cacheKey = upgradeIds.length === 0 ? '' : upgradeIds.slice().sort().join('|');
  // The most recent cacheKey we've successfully (or unsuccessfully)
  // settled. We derive `loading` synchronously per render by
  // comparing this against the current cacheKey — that way the
  // moment the parent re-renders with a NEW input list, loading
  // reads as true on the SAME render, before the effect that
  // actually kicks off the fetch has had a chance to run. Using
  // useState for the loading flag instead would lag by one render
  // and a parent racing its own initial-mount effect (Arrival.tsx's
  // prefill) could see loading=false with stale data and commit
  // the prefill before the upgrades resolve.
  const lastSettledKey = useRef<string>(SENTINEL_UNSETTLED);
  const loading =
    upgradeIds.length > 0 && lastSettledKey.current !== cacheKey;

  useEffect(() => {
    if (upgradeIds.length === 0) {
      setMap(new Map());
      lastSettledKey.current = '';
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
        // skips unresolved upgrades. Still mark settled so the
        // caller can proceed with whatever it has rather than
        // waiting forever.
        console.error('[useUpgradeCatalogueIds] query failed', error);
        setMap(new Map());
        lastSettledKey.current = cacheKey;
        return;
      }
      const next = new Map<string, string>();
      for (const r of (data ?? []) as Array<{ id: string; catalogue_id: string | null }>) {
        if (r.catalogue_id) next.set(r.id, r.catalogue_id);
      }
      lastSettledKey.current = cacheKey;
      setMap(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { map, loading };
}

// Distinct from any real cacheKey value (which is either '' for an
// empty input or a sorted | -joined list of UUIDs). Used as the
// initial value of lastSettledKey so the first render with a
// non-empty input correctly reports loading=true.
const SENTINEL_UNSETTLED = '__lng_unsettled__';
