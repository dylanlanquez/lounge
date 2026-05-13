import { supabase } from '../supabase.ts';

// Resolves a Shopify order number (e.g. "VEN73520", "#VEN73520",
// "ven73520") to its core fields via the lng_lookup_shopify_order
// RPC. Used by the booking form when a service is flagged
// sold_on_shopify — the receptionist types the customer's order
// number, this resolves it, and the amount already paid online lands
// on the appointment row as a credit against the cart at checkout.

export interface ShopifyOrderItem {
  title: string | null;
  sku: string | null;
  quantity: number;
  price: number | string | null;
}

export interface ShopifyOrderLookup {
  id: string;
  name: string;
  customer_id: string | null;
  customer_email: string | null;
  // Resolved through patients via shopify_customer_id (Meridian
  // doesn't replicate shopify_customers). Empty string when the
  // online-only customer hasn't been registered as a patient yet.
  customer_name: string | null;
  total_price_pence: number;
  currency: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  cancelled_at: string | null;
  created_at: string;
  items: ShopifyOrderItem[];
}

export type ShopifyOrderLookupResult =
  | { ok: true; order: ShopifyOrderLookup }
  | { ok: false; reason: 'not_found' | 'not_paid' | 'cancelled' | 'refunded' | 'rpc_error'; message: string };

export async function lookupShopifyOrder(
  orderName: string,
): Promise<ShopifyOrderLookupResult> {
  const trimmed = orderName.trim();
  if (!trimmed) {
    return { ok: false, reason: 'not_found', message: 'Type an order number.' };
  }
  const { data, error } = await supabase.rpc('lng_lookup_shopify_order', {
    p_order_name: trimmed,
  });
  if (error) {
    return { ok: false, reason: 'rpc_error', message: error.message };
  }
  const rows = (data ?? []) as ShopifyOrderLookup[];
  if (rows.length === 0) {
    return {
      ok: false,
      reason: 'not_found',
      message: `No Shopify order matching "${trimmed}".`,
    };
  }
  const order = rows[0]!;

  // Refuse to attach an order that won't actually be paid against the
  // cart. Each refusal explains itself so the receptionist knows
  // whether to retry, raise with the customer, or move on.
  if (order.cancelled_at) {
    return {
      ok: false,
      reason: 'cancelled',
      message: `Order ${order.name} was cancelled. It can't be used as a credit.`,
    };
  }
  const financial = (order.financial_status ?? '').toLowerCase();
  if (financial === 'refunded') {
    return {
      ok: false,
      reason: 'refunded',
      message: `Order ${order.name} was refunded. The customer no longer holds the credit.`,
    };
  }
  if (financial !== 'paid' && financial !== 'partially_refunded') {
    return {
      ok: false,
      reason: 'not_paid',
      message: `Order ${order.name} hasn't been paid yet (status: ${order.financial_status ?? 'unknown'}). The credit only applies once the customer's payment has cleared.`,
    };
  }
  return { ok: true, order };
}
