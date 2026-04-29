import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import type { CatalogueRow } from './catalogue.ts';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!visitId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: c, error: ce } = await supabase
        .from('lng_carts')
        .select('*')
        .eq('visit_id', visitId)
        .maybeSingle();
      if (cancelled) return;
      if (ce) {
        setError(ce.message);
        setLoading(false);
        return;
      }
      const cartRow = (c as CartRow | null) ?? null;
      setCart(cartRow);
      if (cartRow) {
        const { data: rows } = await supabase
          .from('lng_cart_items')
          .select('*')
          .eq('cart_id', cartRow.id)
          .order('sort_order', { ascending: true })
          .order('created_at', { ascending: true });
        if (!cancelled) setItems((rows ?? []) as CartItemRow[]);
      } else {
        setItems([]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [visitId, tick]);

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
  const rows = [];
  for (let i = 0; i < qty; i++) {
    rows.push({ ...baseSnapshot, unit_price_pence: i === 0 ? baseUnitPence : extraPence });
  }
  const { data, error } = await supabase.from('lng_cart_items').insert(rows).select('*');
  if (error) throw new Error(error.message);
  const inserted = (data ?? []) as CartItemRow[];

  // Upgrade snapshots — one row per (cart_item, upgrade) pair. Upgrade
  // cost rides every quantity tick (qty 2 with Scalloped → 2 cart items
  // each with a Scalloped upgrade row), matching the line-pricing model.
  const upgrades = options.upgrades ?? [];
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

export async function updateCartItemQuantity(itemId: string, quantity: number): Promise<void> {
  if (quantity <= 0) {
    await removeCartItem(itemId);
    return;
  }
  const { error } = await supabase.from('lng_cart_items').update({ quantity }).eq('id', itemId);
  if (error) throw new Error(error.message);
}

export async function removeCartItem(itemId: string): Promise<void> {
  const { error } = await supabase.from('lng_cart_items').delete().eq('id', itemId);
  if (error) throw new Error(error.message);
}

export function formatPence(pence: number): string {
  const sign = pence < 0 ? '-' : '';
  const abs = Math.abs(pence);
  return `${sign}£${(abs / 100).toFixed(2)}`;
}
