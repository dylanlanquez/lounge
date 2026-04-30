import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import type { CatalogueRow } from './catalogue.ts';
import { useRealtimeRefresh } from '../useRealtimeRefresh.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';

export interface CartRow {
  id: string;
  visit_id: string;
  status: 'open' | 'paid' | 'voided';
  subtotal_pence: number;
  discount_pence: number;
  tax_pence: number;
  total_pence: number;
  opened_at: string;
  closed_at: string | null;
}

export interface CartItemRow {
  id: string;
  cart_id: string;
  sku: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit_price_pence: number;
  discount_pence: number;
  line_total_pence: number;
  sort_order: number;
  // Snapshot fields populated when the row came from the catalogue
  // picker. Free-form ad-hoc rows leave these null.
  catalogue_id: string | null;
  catalogue_code: string | null;
  service_type: string | null;
  product_key: string | null;
  repair_variant: string | null;
  arch: 'upper' | 'lower' | 'both' | null;
  shade: string | null;
  notes: string | null;
  // Frozen catalogue.quantity_enabled at insert time. Visit cart UI
  // hides the qty stepper for false rows. Default true on ad-hoc
  // entries that didn't come from the picker.
  quantity_enabled: boolean;
  // Frozen catalogue.image_url at insert time. Visit cart line items
  // render this as a small thumbnail. Null on ad-hoc rows that didn't
  // come from the picker.
  image_url: string | null;
  // Upgrade snapshots attached to this line at insert time (Scalloped
  // etc.). Their price_pence is already rolled into unit_price_pence,
  // so they contribute to line_total via the existing generated
  // column — these names are display-only on the cart line.
  upgrades: CartItemUpgradeRow[];
}

export interface CartItemUpgradeRow {
  id: string;
  cart_item_id: string;
  upgrade_id: string | null;
  upgrade_code: string;
  upgrade_name: string;
  price_pence: number;
}

// Per-instance line input. The picker passes one of these per "tick" of
// quantity. extras pricing is applied by the caller (addCatalogueItemsToCart)
// — the picker just declares the catalogue row and options.
export interface CatalogueAddOptions {
  arch?: 'upper' | 'lower' | 'both' | null;
  shade?: string | null;
  notes?: string | null;
  // Applied upgrades, already priced for this line's arch (the picker
  // resolves single-arch vs both-arches pricing before staging). Each
  // entry becomes one row in lng_cart_item_upgrades per cart_item the
  // line spawns, so the upgrade cost rides every quantity tick.
  upgrades?: AppliedUpgrade[];
}

export interface AppliedUpgrade {
  upgrade_id: string;
  code: string;
  name: string;
  // Pence. Resolved by the picker based on the line's arch (so the
  // both-arches tier of a Scalloped upgrade goes in here when arch=both).
  price_pence: number;
}

interface UseCartResult {
  cart: CartRow | null;
  items: CartItemRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  ensureOpen: () => Promise<CartRow | null>;
}

// Loads the cart for a visit (creates one if absent on demand via ensureOpen).
export function useCart(visitId: string | undefined): UseCartResult {
  const [cart, setCart] = useState<CartRow | null>(null);
  const [items, setItems] = useState<CartItemRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const { loading, settle } = useStaleQueryLoading(visitId);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!visitId) {
      settle();
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: c, error: ce } = await supabase
        .from('lng_carts')
        .select('*')
        .eq('visit_id', visitId)
        .maybeSingle();
      if (cancelled) return;
      if (ce) {
        setError(ce.message);
        settle();
        return;
      }
      const cartRow = (c as CartRow | null) ?? null;
      setCart(cartRow);
      if (cartRow) {
        // Active cart lines only — soft-deleted rows (removed_at IS
        // NOT NULL) are kept for audit + Reverse but stay out of the
        // cart UI. The active partial index makes this filter cheap.
        const { data: rows } = await supabase
          .from('lng_cart_items')
          .select('*')
          .eq('cart_id', cartRow.id)
          .is('removed_at', null)
          .order('sort_order', { ascending: true })
          .order('created_at', { ascending: true });
        const baseItems = (rows ?? []) as Omit<CartItemRow, 'upgrades'>[];
        // Pull every upgrade snapshot for this cart in one round-trip,
        // then group by cart_item_id. Avoids N+1 queries when a cart
        // has many lines.
        let upgradeRows: CartItemUpgradeRow[] = [];
        if (baseItems.length > 0) {
          const itemIds = baseItems.map((it) => it.id);
          const { data: ups } = await supabase
            .from('lng_cart_item_upgrades')
            .select('id, cart_item_id, upgrade_id, upgrade_code, upgrade_name, price_pence')
            .in('cart_item_id', itemIds);
          upgradeRows = (ups ?? []) as CartItemUpgradeRow[];
        }
        const upgradesByItem = new Map<string, CartItemUpgradeRow[]>();
        for (const u of upgradeRows) {
          const list = upgradesByItem.get(u.cart_item_id) ?? [];
          list.push(u);
          upgradesByItem.set(u.cart_item_id, list);
        }
        if (!cancelled) {
          setItems(
            baseItems.map((it) => ({ ...it, upgrades: upgradesByItem.get(it.id) ?? [] })),
          );
        }
      } else {
        setItems([]);
      }
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [visitId, tick, settle]);

  const ensureOpen = useCallback(async (): Promise<CartRow | null> => {
    if (!visitId) return null;
    if (cart) return cart;
    const { data, error: err } = await supabase
      .from('lng_carts')
      .insert({ visit_id: visitId })
      .select('*')
      .single();
    if (err || !data) {
      setError(err?.message ?? 'Could not create cart');
      return null;
    }
    setCart(data as CartRow);
    return data as CartRow;
  }, [cart, visitId]);

  // Realtime: cart row (status flip when paid), cart items (line
  // edits from another tab / kiosk session), and cart_item_upgrades
  // (upgrade snapshots attached to a line). Filter the cart channel
  // by visit_id so a busy clinic doesn't fan out every cart change
  // to every open VisitDetail tab. cart_items / cart_item_upgrades
  // can't be filtered by cart_id from the start (we don't have one
  // until ensureOpen runs), so listen unfiltered and let the next
  // fetch re-window — volume is low.
  useRealtimeRefresh(
    visitId
      ? [
          { table: 'lng_carts', filter: `visit_id=eq.${visitId}` },
          { table: 'lng_cart_items' },
          { table: 'lng_cart_item_upgrades' },
        ]
      : [],
    refresh,
  );

  return { cart, items, loading, error, refresh, ensureOpen };
}

export async function addCartItem(
  cartId: string,
  item: {
    name: string;
    unit_price_pence: number;
    quantity?: number;
    sku?: string;
    description?: string;
  }
): Promise<CartItemRow> {
  const { data, error } = await supabase
    .from('lng_cart_items')
    .insert({
      cart_id: cartId,
      name: item.name,
      unit_price_pence: item.unit_price_pence,
      quantity: item.quantity ?? 1,
      sku: item.sku ?? null,
      description: item.description ?? null,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Add item failed');
  return data as CartItemRow;
}

// Inserts N rows for a catalogue pick — one per instance — so volume
// pricing is per-line and no window-function trigger is needed. The
// first instance charges the catalogue's unit_price; every subsequent
// instance charges extra_unit_price (or unit_price again if the
// catalogue has no extras price).
//
// Each row carries the full catalogue snapshot (code, name, service_type,
// product_key, repair_variant, arch_match collapsed to the per-line
// `arch` value, shade, notes) so post-checkout edits to lwo_catalogue
// can never alter the receipt.
export async function addCatalogueItemsToCart(
  cartId: string,
  catalogue: CatalogueRow,
  qty: number,
  options: CatalogueAddOptions
): Promise<CartItemRow[]> {
  if (qty <= 0) return [];
  const arch = options.arch ?? null;
  // Single-arch tier (or non-arch row) uses unit_price + the volume
  // discount via extra_unit_price. Both-arches tier uses
  // both_arches_price flat — no extras tier on the multi-arch deal.
  const isBoth = arch === 'both' && catalogue.both_arches_price != null;
  const baseUnitPounds = isBoth ? catalogue.both_arches_price! : catalogue.unit_price;
  const baseUnitPence = Math.round(baseUnitPounds * 100);
  const extraPence = isBoth
    ? baseUnitPence
    : catalogue.extra_unit_price != null
      ? Math.round(catalogue.extra_unit_price * 100)
      : baseUnitPence;
  const baseSnapshot = {
    cart_id: cartId,
    sku: catalogue.code,
    name: catalogue.name,
    description: catalogue.description,
    quantity: 1,
    discount_pence: 0,
    catalogue_id: catalogue.id,
    catalogue_code: catalogue.code,
    service_type: catalogue.service_type,
    product_key: catalogue.product_key,
    repair_variant: catalogue.repair_variant,
    arch,
    shade: options.shade ?? null,
    notes: options.notes ?? null,
    quantity_enabled: catalogue.quantity_enabled,
    image_url: catalogue.image_url,
  };
  // Upgrade pence is rolled into unit_price_pence on every spawned
  // cart line so line_total_pence (a generated column = unit * qty -
  // discount) and the cart subtotal trigger stay correct without
  // schema changes. The lng_cart_item_upgrades rows below are kept
  // as immutable display-only snapshots — the receptionist still sees
  // "Scalloped" listed under the line, but the price already lives
  // in the parent line's unit price.
  const upgrades = options.upgrades ?? [];
  const upgradePerInstancePence = upgrades.reduce((sum, u) => sum + u.price_pence, 0);
  // Stamp the staff member who added the line so the timeline can
  // surface "Added X by [name]". Best-effort: if the account
  // resolver fails (kiosk session edge case) the column lands NULL
  // rather than blocking the picker.
  const { data: accountId } = await supabase.rpc('auth_account_id');
  const createdBy = (accountId as string | null) ?? null;
  const rows = [];
  for (let i = 0; i < qty; i++) {
    const baseForInstance = i === 0 ? baseUnitPence : extraPence;
    rows.push({
      ...baseSnapshot,
      unit_price_pence: baseForInstance + upgradePerInstancePence,
      created_by: createdBy,
    });
  }
  const { data, error } = await supabase.from('lng_cart_items').insert(rows).select('*');
  if (error) throw new Error(error.message);
  const inserted = (data ?? []).map((it) => ({ ...(it as Omit<CartItemRow, 'upgrades'>), upgrades: [] as CartItemUpgradeRow[] })) as CartItemRow[];

  // Upgrade snapshots — one row per (cart_item, upgrade) pair. Upgrade
  // cost rides every quantity tick (qty 2 with Scalloped → 2 cart items
  // each with a Scalloped upgrade row), matching the line-pricing model.
  if (upgrades.length > 0 && inserted.length > 0) {
    const upgradeRows = inserted.flatMap((item) =>
      upgrades.map((u) => ({
        cart_item_id: item.id,
        upgrade_id: u.upgrade_id,
        upgrade_code: u.code,
        upgrade_name: u.name,
        price_pence: u.price_pence,
      }))
    );
    const { error: upErr } = await supabase
      .from('lng_cart_item_upgrades')
      .insert(upgradeRows);
    if (upErr) throw new Error(upErr.message);
  }

  return inserted;
}

// Quantity stepper. Refuses to go below 1 — the only way to remove a
// line is the explicit Remove sheet (trash icon) which captures a
// reason. This closes the audit-bypass loophole where staff could
// silently zero-out a line.
export async function updateCartItemQuantity(itemId: string, quantity: number): Promise<void> {
  const safeQty = Math.max(1, quantity);
  const { error } = await supabase.from('lng_cart_items').update({ quantity: safeQty }).eq('id', itemId);
  if (error) throw new Error(error.message);
}

export type CartLineRemoveReason = 'mistake' | 'changed_mind' | 'unsuitable';

export interface RemoveCartLineInput {
  itemId: string;
  reason: CartLineRemoveReason;
  // Required for 'unsuitable', optional for 'changed_mind', unused
  // for 'mistake'. Caller validates per-reason; this function only
  // persists what it's given.
  note?: string;
}

// Soft-delete a cart line with a reason. The line stays in the
// lng_cart_items table (filtered out of the cart UI by the
// removed_at IS NULL clause in useCart) so that
// reverseVisitTermination can un-flag it and bring the line back
// exactly as it was. Hard-DELETE would lose the original arch /
// shade / upgrades / qty.
//
// The visit-status flip and the lng_unsuitability_records write
// happen at a higher level — call recordUnsuitability separately
// when reason is 'unsuitable'. Keeping this function single-purpose
// means callers can soft-delete in different contexts (e.g. a
// future bulk-clear on cart reset) without each having to know the
// unsuitability semantics.
export async function removeCartLine(input: RemoveCartLineInput): Promise<void> {
  const { data: accountId } = await supabase.rpc('auth_account_id');
  const note = input.note?.trim() ?? '';
  const { error } = await supabase
    .from('lng_cart_items')
    .update({
      removed_at: new Date().toISOString(),
      removed_reason: input.reason,
      removed_by: (accountId as string | null) ?? null,
      removed_note: note.length > 0 ? note : null,
    })
    .eq('id', input.itemId);
  if (error) throw new Error(error.message);
}

// One source of truth for GBP rendering across the app. Intl gives us
// the thousand separators ("£1,248.00", not "£1248.00"), the en-GB
// minus-sign placement, and 2dp without us hand-rolling it.
const GBP = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPence(pence: number): string {
  return GBP.format(pence / 100);
}

// For the few callers that already hold a pounds value (catalogue
// rows, picker line-totals computed in pounds). Convert in one spot
// so every readable money value flows through the same formatter.
export function formatPounds(pounds: number): string {
  return GBP.format(pounds);
}
