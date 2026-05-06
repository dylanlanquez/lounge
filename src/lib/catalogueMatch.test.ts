import { describe, expect, it } from 'vitest';
import { findMatches, scoreMatch, totalForQty, totalForQtyPence } from './catalogueMatch.ts';
import type { CatalogueRow } from './queries/catalogue.ts';

const baseRow = (over: Partial<CatalogueRow> = {}): CatalogueRow => ({
  id: 'id-' + Math.random(),
  code: 'code',
  category: 'Test',
  name: 'Test row',
  description: null,
  unit_price: 100,
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
  sort_order: 0,
  active: true,
  created_at: '2026-04-28T00:00:00Z',
  updated_at: '2026-04-28T00:00:00Z',
  ...over,
});

describe('scoreMatch', () => {
  it('returns 0 when every catalogue field is wildcard', () => {
    const row = baseRow();
    expect(scoreMatch(row, { service_type: 'denture_repair' })).toBe(0);
  });

  it('counts each non-wildcard field that matches', () => {
    const row = baseRow({
      service_type: 'denture_repair',
      repair_variant: 'Snapped denture',
    });
    expect(
      scoreMatch(row, { service_type: 'denture_repair', repair_variant: 'Snapped denture' })
    ).toBe(2);
  });

  it('returns null when a constrained service_type disagrees', () => {
    const row = baseRow({ service_type: 'denture_repair' });
    expect(scoreMatch(row, { service_type: 'click_in_veneers' })).toBeNull();
  });

  it('returns null when a constrained repair_variant disagrees', () => {
    const row = baseRow({ repair_variant: 'Snapped denture' });
    expect(scoreMatch(row, { repair_variant: 'Cracked denture' })).toBeNull();
  });

  describe('arch_match', () => {
    it('"any" is a wildcard — adds zero specificity, matches all arches', () => {
      const row = baseRow({ arch_match: 'any' });
      expect(scoreMatch(row, { arch: 'upper' })).toBe(0);
      expect(scoreMatch(row, { arch: 'both' })).toBe(0);
      expect(scoreMatch(row, {})).toBe(0);
    });

    it('"single" matches upper or lower; rejects both', () => {
      const row = baseRow({ arch_match: 'single' });
      expect(scoreMatch(row, { arch: 'upper' })).toBe(1);
      expect(scoreMatch(row, { arch: 'lower' })).toBe(1);
      expect(scoreMatch(row, { arch: 'both' })).toBeNull();
    });

    it('"both" matches both; rejects single', () => {
      const row = baseRow({ arch_match: 'both' });
      expect(scoreMatch(row, { arch: 'both' })).toBe(1);
      expect(scoreMatch(row, { arch: 'upper' })).toBeNull();
    });
  });
});

describe('findMatches', () => {
  it('orders by score desc, then sort_order asc', () => {
    const generic = baseRow({ id: 'generic', code: 'g', sort_order: 50 });
    const specific = baseRow({
      id: 'specific',
      code: 's',
      service_type: 'denture_repair',
      sort_order: 100,
    });
    const moreSpecific = baseRow({
      id: 'more',
      code: 'm',
      service_type: 'denture_repair',
      repair_variant: 'Snapped denture',
      sort_order: 200,
    });
    const ordered = findMatches([generic, specific, moreSpecific], {
      service_type: 'denture_repair',
      repair_variant: 'Snapped denture',
    });
    expect(ordered.map((r) => r.id)).toEqual(['more', 'specific', 'generic']);
  });

  it('breaks ties on sort_order ascending', () => {
    const a = baseRow({ id: 'a', code: 'a', service_type: 'x', sort_order: 20 });
    const b = baseRow({ id: 'b', code: 'b', service_type: 'x', sort_order: 10 });
    expect(findMatches([a, b], { service_type: 'x' }).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('drops inactive rows', () => {
    const row = baseRow({ active: false });
    expect(findMatches([row], {})).toHaveLength(0);
  });

  it('drops rows whose constraints disagree', () => {
    const row = baseRow({ service_type: 'denture_repair' });
    expect(findMatches([row], { service_type: 'click_in_veneers' })).toHaveLength(0);
  });
});

describe('totalForQty / totalForQtyPence', () => {
  it('extra_unit_price=null charges unit_price for every instance', () => {
    const row = baseRow({ unit_price: 50, extra_unit_price: null });
    expect(totalForQty(row, 1)).toBe(50);
    expect(totalForQty(row, 3)).toBe(150);
  });

  it('extra_unit_price set: first at unit_price, rest at extra_unit_price', () => {
    const row = baseRow({ unit_price: 70, extra_unit_price: 50 });
    expect(totalForQty(row, 1)).toBe(70);
    expect(totalForQty(row, 2)).toBe(120);
    expect(totalForQty(row, 3)).toBe(170);
  });

  it('returns 0 for non-positive quantities', () => {
    const row = baseRow({ unit_price: 100 });
    expect(totalForQty(row, 0)).toBe(0);
    expect(totalForQty(row, -1)).toBe(0);
  });

  it('snaps to 2dp', () => {
    const row = baseRow({ unit_price: 25.55, extra_unit_price: null });
    expect(totalForQty(row, 3)).toBe(76.65);
  });

  it('totalForQtyPence converts pounds to pence integers', () => {
    const row = baseRow({ unit_price: 70, extra_unit_price: 50 });
    expect(totalForQtyPence(row, 2)).toBe(12000);
  });
});
