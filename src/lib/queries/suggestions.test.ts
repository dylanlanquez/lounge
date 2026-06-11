import { describe, expect, it } from 'vitest';
import { resolveCartSuggestions, type SuggestionRow } from './suggestions.ts';
import type { CatalogueRow } from './catalogue.ts';

// Minimal catalogue row factory — resolveCartSuggestions only reads id
// (and relies on the row being present in the active list), so the rest
// is filler kept type-complete.
const row = (id: string, over: Partial<CatalogueRow> = {}): CatalogueRow => ({
  id,
  code: id,
  category: 'Test',
  name: id,
  description: null,
  unit_price: 10,
  extra_unit_price: null,
  both_arches_price: null,
  unit_label: null,
  image_url: null,
  service_type: null,
  product_key: null,
  repair_variant: null,
  arch_match: 'any',
  is_service: false,
  quantity_enabled: true,
  sla_enabled: false,
  sla_target_minutes: null,
  include_on_lwo: true,
  allocate_job_box: true,
  is_virtual: false,
  meeting_platform: null,
  fulfilment_required: true,
  sold_on_shopify: false,
  shopify_product_id: null,
  shopify_variant_id: null,
  sort_order: 0,
  active: true,
  created_at: '2026-06-11T00:00:00Z',
  updated_at: '2026-06-11T00:00:00Z',
  ...over,
});

const rule = (
  trigger: string,
  suggested: string,
  sort_order = 0,
): SuggestionRow => ({
  id: `${trigger}->${suggested}`,
  trigger_catalogue_id: trigger,
  suggested_catalogue_id: suggested,
  sort_order,
  created_at: '2026-06-11T00:00:00Z',
  updated_at: '2026-06-11T00:00:00Z',
});

describe('resolveCartSuggestions', () => {
  const active = [row('retainer'), row('case'), row('tablets'), row('whitening')];

  it('returns every active row when the basket is empty', () => {
    const out = resolveCartSuggestions(active, [], []);
    expect(out).toBe(active); // identity passthrough, no copy
  });

  it('returns a trigger product\'s companions in sort order', () => {
    const rules = [rule('retainer', 'tablets', 1), rule('retainer', 'case', 0)];
    const out = resolveCartSuggestions(active, rules, ['retainer']);
    expect(out.map((r) => r.id)).toEqual(['case', 'tablets']);
  });

  it('excludes rows already in the basket', () => {
    const rules = [rule('retainer', 'case'), rule('retainer', 'tablets')];
    const out = resolveCartSuggestions(active, rules, ['retainer', 'case']);
    expect(out.map((r) => r.id)).toEqual(['tablets']);
  });

  it('dedupes a companion suggested by two basket items', () => {
    const rules = [rule('retainer', 'whitening'), rule('case', 'whitening')];
    const out = resolveCartSuggestions(active, rules, ['retainer', 'case']);
    expect(out.map((r) => r.id)).toEqual(['whitening']);
  });

  it('drops companions that are inactive / missing from the active list', () => {
    const rules = [rule('retainer', 'discontinued'), rule('retainer', 'case')];
    const out = resolveCartSuggestions(active, rules, ['retainer']);
    expect(out.map((r) => r.id)).toEqual(['case']);
  });

  it('walks basket items in order, then per-trigger sort order', () => {
    const rules = [rule('case', 'whitening'), rule('retainer', 'tablets')];
    // retainer added first, so its companions surface before case's.
    const out = resolveCartSuggestions(active, rules, ['retainer', 'case']);
    expect(out.map((r) => r.id)).toEqual(['tablets', 'whitening']);
  });

  it('returns empty when basket items have no configured companions', () => {
    const out = resolveCartSuggestions(active, [], ['retainer']);
    expect(out).toEqual([]);
  });
});
