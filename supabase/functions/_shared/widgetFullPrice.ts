import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

// Server-side full-price resolver for the customer booking widget.
// Single source of truth shared between widget-create-payment-intent
// (computes the Stripe PI amount) and widget-create-appointment
// (re-verifies that same amount against the captured PI). The two
// endpoints MUST agree byte-for-byte; sharing the implementation
// here is the only way to keep them aligned.
//
// Two pricing paths, picked by service_type:
//
//   • denture_repair — cart-driven. Sum every repair-item line at the
//     catalogue's current price for its (arch, quantity). Per-line
//     pricing mirrors resolveRepairLineTotalPence; total includes
//     selected upgrades on the FIRST cart line's catalogue row
//     (which matches how the widget computes upgrades — they're
//     hung off the resolved catalogue row, not the whole cart).
//
//   • everything else — single-row. Resolve one catalogue row by
//     (service_type, product_key?, repair_variant?), pick
//     unit_price OR both_arches_price for arch='both' on
//     arch_match='single' rows, add upgrade pence.
//
// Why this split: the same-day-appliance / click-in-veneers flows
// have ONE catalogue row per booking. Denture repair has 1..N rows
// (one per repair-line) plus per-line quantity (per-tooth). Before
// this split, the single-row path was used for every service —
// a 6-line £410 denture repair was getting charged just the first
// line's unit_price (£60) and the widget told the customer they
// had paid in full. Critical payment-integrity bug; fixed 2026-05-17.

export interface PriceResolveInput {
  serviceType: string;
  productKey: string | null;
  repairVariant: string | null;
  arch: 'upper' | 'lower' | 'both' | null;
  upgradeIds: string[];
  /** Denture-repair cart. Empty for every other service. Each entry
   *  is re-priced server-side against lwo_catalogue — the client's
   *  unit_price / line_total values are ignored to defend against
   *  tampered bodies. */
  repairItems: ReadonlyArray<{
    catalogueId: string;
    arch: 'upper' | 'lower' | 'both';
    quantity: number;
  }>;
}

export type PriceResolveResult =
  | { ok: true; pence: number }
  | { ok: false; code: string };

export async function resolveWidgetFullPricePence(
  supabase: SupabaseClient,
  input: PriceResolveInput,
): Promise<PriceResolveResult> {
  if (input.serviceType === 'denture_repair') {
    return resolveDentureRepairTotal(supabase, input);
  }
  return resolveSingleRowTotal(supabase, input);
}

async function resolveDentureRepairTotal(
  supabase: SupabaseClient,
  input: PriceResolveInput,
): Promise<PriceResolveResult> {
  if (!input.repairItems || input.repairItems.length === 0) {
    return { ok: false, code: 'no_repair_items' };
  }

  // Fetch every catalogue row referenced by the cart in a single
  // query. The cart usually has 1-4 unique catalogue rows; bulk
  // resolve avoids N round-trips.
  const catalogueIds = Array.from(
    new Set(input.repairItems.map((r) => r.catalogueId)),
  );
  const { data, error } = await supabase
    .from('lwo_catalogue')
    .select('id, unit_price, both_arches_price, unit_label, service_type, active')
    .in('id', catalogueIds);
  if (error) return { ok: false, code: 'catalogue_lookup_failed' };

  const byId = new Map<
    string,
    {
      unitPence: number;
      bothPence: number | null;
      unitLabel: string | null;
    }
  >();
  for (const r of (data ?? []) as Array<{
    id: string;
    unit_price: number | string | null;
    both_arches_price: number | string | null;
    unit_label: string | null;
    service_type: string | null;
    active: boolean | null;
  }>) {
    // Defence: only honour rows that are active and belong to the
    // service the widget is booking. A tampered body shipping a
    // catalogueId from a different service_type would otherwise
    // pull that row's price into the denture-repair total.
    if (r.active === false) continue;
    if (r.service_type && r.service_type !== input.serviceType) continue;
    const unit = r.unit_price;
    if (unit === null || unit === undefined) continue;
    const unitPence = Math.round(Number(unit) * 100);
    if (!Number.isFinite(unitPence) || unitPence <= 0) continue;
    byId.set(r.id, {
      unitPence,
      bothPence:
        r.both_arches_price === null || r.both_arches_price === undefined
          ? null
          : Math.round(Number(r.both_arches_price) * 100),
      unitLabel: r.unit_label,
    });
  }

  let cartPence = 0;
  for (const item of input.repairItems) {
    const cat = byId.get(item.catalogueId);
    if (!cat) {
      // Unknown / cross-service / inactive catalogueId — silently
      // drop. Defends against tampered carts; the legitimate widget
      // client only ever ships ids it just resolved from the
      // catalogue picker.
      continue;
    }
    const quantity = Math.max(1, Math.min(14, Math.round(item.quantity)));
    cartPence += resolveRepairLineTotalPence({
      unitLabel: cat.unitLabel,
      unitPricePence: cat.unitPence,
      bothArchesPricePence: cat.bothPence,
      arch: item.arch,
      quantity,
    });
  }

  if (cartPence <= 0) {
    return { ok: false, code: 'no_price_resolved' };
  }

  // Upgrades on a denture-repair cart hang off the FIRST repair
  // line's catalogue row (matches the widget client's resolver —
  // useResolvedCatalogueRow keys on first-line repair_variant when
  // the service is denture_repair). Sum their pence onto the cart.
  const upgradePence = await resolveUpgradePence(
    supabase,
    input.upgradeIds,
    input.repairItems[0]?.catalogueId ?? null,
    input.arch,
    'any', // upgrades on denture repair don't honour the parent's arch_match — each line carries its own arch
  );
  if (upgradePence === null) return { ok: false, code: 'upgrade_resolve_failed' };

  return { ok: true, pence: cartPence + upgradePence };
}

async function resolveSingleRowTotal(
  supabase: SupabaseClient,
  input: PriceResolveInput,
): Promise<PriceResolveResult> {
  let q = supabase
    .from('lwo_catalogue')
    .select('id, unit_price, both_arches_price, arch_match')
    .eq('service_type', input.serviceType)
    .eq('active', true);
  if (input.productKey) q = q.eq('product_key', input.productKey);
  if (input.repairVariant) q = q.eq('repair_variant', input.repairVariant);
  const { data, error } = await q.limit(1);
  if (error) return { ok: false, code: 'catalogue_lookup_failed' };

  const row = (data && data.length > 0 ? data[0] : null) as
    | {
        id: string;
        unit_price: number | string | null;
        both_arches_price: number | string | null;
        arch_match: 'any' | 'single' | 'both' | null;
      }
    | null;
  if (!row) return { ok: false, code: 'no_catalogue_row' };

  const archMatch = row.arch_match ?? 'any';
  const useBoth =
    archMatch === 'single' &&
    input.arch === 'both' &&
    row.both_arches_price !== null;
  const baseDecimal = useBoth ? row.both_arches_price : row.unit_price;
  if (baseDecimal === null || baseDecimal === undefined) {
    return { ok: false, code: 'no_price_resolved' };
  }
  const basePence = Math.round(Number(baseDecimal) * 100);
  if (!Number.isFinite(basePence) || basePence <= 0) {
    return { ok: false, code: 'no_price_resolved' };
  }

  const upgradePence = await resolveUpgradePence(
    supabase,
    input.upgradeIds,
    row.id,
    input.arch,
    archMatch,
  );
  if (upgradePence === null) return { ok: false, code: 'upgrade_resolve_failed' };

  return { ok: true, pence: basePence + upgradePence };
}

// Per-line price math — mirrors the client's resolveLineTotal in
// src/widgets/shared/state.ts and the server's
// resolveRepairLineTotalPence in widget-create-appointment. Pure;
// no Supabase calls.
function resolveRepairLineTotalPence(input: {
  unitLabel: string | null;
  unitPricePence: number;
  bothArchesPricePence: number | null;
  arch: 'upper' | 'lower' | 'both';
  quantity: number;
}): number {
  if (input.unitLabel === 'per tooth') {
    return input.quantity * input.unitPricePence;
  }
  if (input.unitLabel === 'per arch' && input.arch === 'both') {
    return input.bothArchesPricePence ?? input.unitPricePence * 2;
  }
  return input.unitPricePence;
}

// Resolve total upgrade pence. Returns null on Supabase error so the
// caller can return a structured error; returns 0 for empty input or
// when no upgrades survive validation.
async function resolveUpgradePence(
  supabase: SupabaseClient,
  upgradeIds: string[],
  catalogueRowId: string | null,
  arch: 'upper' | 'lower' | 'both' | null,
  archMatch: 'any' | 'single' | 'both',
): Promise<number | null> {
  const ids = Array.from(new Set(upgradeIds)).filter(
    (id) => typeof id === 'string' && id.length > 0,
  );
  if (ids.length === 0 || !catalogueRowId) return 0;

  const { data, error } = await supabase
    .from('lng_widget_upgrades')
    .select('id, catalogue_id, unit_price, both_arches_price')
    .in('id', ids)
    .eq('catalogue_id', catalogueRowId);
  if (error) return null;

  let total = 0;
  for (const u of (data ?? []) as Array<{
    id: string;
    catalogue_id: string;
    unit_price: number | string | null;
    both_arches_price: number | string | null;
  }>) {
    const useBoth =
      archMatch === 'single' && arch === 'both' && u.both_arches_price !== null;
    const decimal = useBoth ? u.both_arches_price : u.unit_price;
    if (decimal === null || decimal === undefined) continue;
    const pence = Math.round(Number(decimal) * 100);
    if (!Number.isFinite(pence) || pence <= 0) continue;
    total += pence;
  }
  return total;
}

// Stable serialisation of a repair-cart for inclusion in the
// idempotency-key hash. Sorting by catalogueId then arch ensures
// the same cart contents produce the same hash regardless of the
// order the client serialised them in. Without this, the
// PaymentIntent endpoint could return a stale PI at the wrong
// amount when a customer back-navigates and re-adds the same
// items in a different order.
export function serialiseRepairItemsForHash(
  items: ReadonlyArray<{
    catalogueId: string;
    arch: 'upper' | 'lower' | 'both';
    quantity: number;
  }>,
): string {
  return items
    .map((r) => `${r.catalogueId}:${r.arch}:${r.quantity}`)
    .sort()
    .join(',');
}
