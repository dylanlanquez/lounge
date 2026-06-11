import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';
import type { CatalogueRow } from './catalogue.ts';

// Per-product cart suggestions. Each row says "when trigger_catalogue_id
// is in the basket, suggest suggested_catalogue_id". The picker resolves
// the live basket against these rows to drive the "Suggested for this
// booking" carousel; the admin catalogue editor writes them per product
// (mirrors the per-product upgrades model).

export interface SuggestionRow {
  id: string;
  trigger_catalogue_id: string;
  suggested_catalogue_id: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const SUGGESTION_COLUMNS =
  'id, trigger_catalogue_id, suggested_catalogue_id, sort_order, created_at, updated_at';

interface SuggestionsResult {
  rows: SuggestionRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Every suggestion row, ordered by trigger then position. The picker
// pulls all of them once and resolves against the basket in memory —
// one small fetch keeps the bottom sheet responsive as the receptionist
// adds items and re-opens the picker.
export function useAllSuggestions(): SuggestionsResult {
  const [rows, setRows] = useState<SuggestionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading('sug-all');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('lng_catalogue_suggestions')
        .select(SUGGESTION_COLUMNS)
        .order('trigger_catalogue_id', { ascending: true })
        .order('sort_order', { ascending: true });
      if (cancelled) return;
      if (err) {
        // Pre-migration shadow envs may be missing the table; treat as
        // empty rather than crash (matches the upgrades query).
        if (err.code === '42P01') {
          setRows([]);
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        return;
      }
      setRows((data ?? []) as SuggestionRow[]);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [tick, settle]);

  return { rows, loading, error, refresh };
}

// Admin editor: every companion configured for one trigger product,
// in display order.
export function useSuggestionsForCatalogue(catalogueId: string | null): SuggestionsResult {
  const [rows, setRows] = useState<SuggestionRow[]>([]);
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
        .from('lng_catalogue_suggestions')
        .select(SUGGESTION_COLUMNS)
        .eq('trigger_catalogue_id', catalogueId)
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
      setRows((data ?? []) as SuggestionRow[]);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [catalogueId, tick, settle]);

  return { rows, loading, error, refresh };
}

// Add a companion to a trigger product. sort_order defaults to the end
// of the current set. Unique (trigger, suggested) makes a duplicate add
// an upsert no-op rather than an error.
export async function addSuggestion(
  triggerId: string,
  suggestedId: string,
  sortOrder: number,
): Promise<void> {
  const { error } = await supabase
    .from('lng_catalogue_suggestions')
    .upsert(
      {
        trigger_catalogue_id: triggerId,
        suggested_catalogue_id: suggestedId,
        sort_order: sortOrder,
      },
      { onConflict: 'trigger_catalogue_id,suggested_catalogue_id' },
    );
  if (error) throw new Error(error.message);
}

export async function removeSuggestion(id: string): Promise<void> {
  const { error } = await supabase.from('lng_catalogue_suggestions').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// Persist a reordered companion set. Each id gets sort_order = its new
// index (compact 0..n-1; the set is small so no spacing needed).
export async function reorderSuggestions(orderedIds: string[]): Promise<void> {
  await Promise.all(
    orderedIds.map((id, index) =>
      supabase
        .from('lng_catalogue_suggestions')
        .update({ sort_order: index })
        .eq('id', id)
        .then(({ error }) => {
          if (error) throw new Error(error.message);
        }),
    ),
  );
}

// Pure resolver: given every active catalogue row, every suggestion
// rule, and the catalogue ids currently in the basket, return the rows
// to show in the picker's "Suggested" carousel.
//
//   - Empty basket  → every active row (the brief's "show them all").
//   - Non-empty     → the union of each basket item's configured
//                     companions, in basket order then per-trigger sort
//                     order, deduped, with rows already in the basket and
//                     inactive/missing rows filtered out. May be empty,
//                     in which case the caller hides the carousel.
export function resolveCartSuggestions(
  activeRows: CatalogueRow[],
  suggestions: SuggestionRow[],
  cartCatalogueIds: readonly string[],
): CatalogueRow[] {
  if (cartCatalogueIds.length === 0) return activeRows;

  const rowById = new Map(activeRows.map((r) => [r.id, r]));
  const cartIds = new Set(cartCatalogueIds);

  // Group rules by trigger, then sort each group by sort_order so the
  // companion order is correct regardless of how the rules arrived
  // (no hidden coupling to the query's ORDER BY).
  const byTrigger = new Map<string, SuggestionRow[]>();
  for (const s of suggestions) {
    const list = byTrigger.get(s.trigger_catalogue_id) ?? [];
    list.push(s);
    byTrigger.set(s.trigger_catalogue_id, list);
  }
  for (const list of byTrigger.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order);
  }

  const seen = new Set<string>();
  const out: CatalogueRow[] = [];
  // Walk basket items in the order they were added so the most
  // recently relevant companions surface first per trigger.
  for (const cartId of cartCatalogueIds) {
    const rules = byTrigger.get(cartId);
    if (!rules) continue;
    for (const rule of rules) {
      const suggestedId = rule.suggested_catalogue_id;
      if (seen.has(suggestedId)) continue;
      if (cartIds.has(suggestedId)) continue; // already in the basket
      const row = rowById.get(suggestedId);
      if (!row) continue; // inactive or deleted
      seen.add(suggestedId);
      out.push(row);
    }
  }
  return out;
}
