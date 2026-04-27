import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

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
