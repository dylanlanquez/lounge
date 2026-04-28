import type { CatalogueRow } from './queries/catalogue.ts';

// Match criteria the picker has at the moment it asks "what catalogue rows
// fit this booking?" — drawn from the appointment's intake answers and
// (for repair variants) the receptionist's selection. Each field is
// optional; missing fields don't constrain the match.
export interface MatchCriteria {
  service_type?: string | null;
  product_key?: string | null;
  repair_variant?: string | null;
  // 'upper' / 'lower' / 'both' — the patient's actual arch, NOT the
  // catalogue's arch_match wildcard. The matcher resolves whether
  // 'single' / 'both' / 'any' on the catalogue row covers this arch.
  arch?: 'upper' | 'lower' | 'both' | null;
}

// Specificity score: count of non-wildcard catalogue fields that line up
// with the criteria. The most specific row wins; ties break on sort_order.
// Returns null when the row CAN'T match (a constrained field disagrees) so
// the caller can filter it out.
//
// e.g. row { service_type: 'denture_repair', repair_variant: 'Snapped', arch_match: 'any' }
//      vs criteria { service_type: 'denture_repair', repair_variant: 'Snapped', arch: 'upper' }
//      → score = 2 (service_type + repair_variant matched; arch_match='any' is wildcard).
export function scoreMatch(row: CatalogueRow, criteria: MatchCriteria): number | null {
  let score = 0;

  // service_type: null on row = wildcard; non-null must equal criteria.
  if (row.service_type != null) {
    if (criteria.service_type !== row.service_type) return null;
    score++;
  }

  if (row.product_key != null) {
    if (criteria.product_key !== row.product_key) return null;
    score++;
  }

  if (row.repair_variant != null) {
    if (criteria.repair_variant !== row.repair_variant) return null;
    score++;
  }

  // arch_match has its own DSL:
  //   'any'    → wildcard, doesn't constrain
  //   'single' → matches arch in (upper, lower)
  //   'both'   → matches arch === 'both'
  if (row.arch_match === 'single') {
    if (criteria.arch !== 'upper' && criteria.arch !== 'lower') return null;
    score++;
  } else if (row.arch_match === 'both') {
    if (criteria.arch !== 'both') return null;
    score++;
  }
  // 'any' adds zero specificity (correctly).

  return score;
}

// Returns rows that match the criteria, sorted by specificity (highest
// first), then by sort_order. Inactive rows are filtered out — admin
// edits land in the catalogue but only `active=true` rows are pickable.
export function findMatches(rows: CatalogueRow[], criteria: MatchCriteria): CatalogueRow[] {
  const scored: Array<{ row: CatalogueRow; score: number }> = [];
  for (const row of rows) {
    if (!row.active) continue;
    const score = scoreMatch(row, criteria);
    if (score === null) continue;
    scored.push({ row, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.row.sort_order - b.row.sort_order;
  });
  return scored.map((x) => x.row);
}

// Total chargeable amount in pounds for a given catalogue row at a
// quantity. Mirrors Checkpoint's "first instance at unit_price, every
// subsequent instance at extra_unit_price" rule. Null extra_unit_price
// means no volume discount — every instance charges unit_price.
export function totalForQty(row: CatalogueRow, qty: number): number {
  if (qty <= 0) return 0;
  if (row.extra_unit_price == null) return roundPounds(row.unit_price * qty);
  return roundPounds(row.unit_price + row.extra_unit_price * (qty - 1));
}

// Pence equivalent of totalForQty. Used when copying a catalogue line
// into lng_cart_items (which stores pence integers).
export function totalForQtyPence(row: CatalogueRow, qty: number): number {
  return Math.round(totalForQty(row, qty) * 100);
}

// Snap to 2dp so 25.55 * 3 doesn't return 76.65000000000001.
function roundPounds(p: number): number {
  return Math.round(p * 100) / 100;
}
