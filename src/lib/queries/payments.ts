import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

export type PaymentMethod = 'card_terminal' | 'cash' | 'gift_card' | 'account_credit';
export type PaymentJourney =
  | 'standard'
  | 'klarna'
  | 'clearpay'
  | 'klarna_legacy_shopify'
  | 'clearpay_legacy_shopify';

export interface PaymentRow {
  id: string;
  cart_id: string;
  method: PaymentMethod;
  payment_journey: PaymentJourney;
  amount_pence: number;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  failure_reason: string | null;
  taken_by: string | null;
  notes: string | null;
  created_at: string;
  succeeded_at: string | null;
}

export async function recordCashPayment(
  cartId: string,
  amountPence: number,
  notes?: string
): Promise<PaymentRow> {
  // Stamp the staff member so the timeline's "Payment captured"
  // event renders "by [name]". Best-effort: NULL on resolver
  // failure rather than blocking the till.
  const { data: accountId } = await supabase.rpc('auth_account_id');
  const { data, error } = await supabase
    .from('lng_payments')
    .insert({
      cart_id: cartId,
      method: 'cash',
      payment_journey: 'standard',
      amount_pence: amountPence,
      status: 'succeeded',
      succeeded_at: new Date().toISOString(),
      taken_by: (accountId as string | null) ?? null,
      notes: notes ?? null,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Cash payment record failed');

  // Conditional cart paid flip — supports split payments. Sum every
  // succeeded payment on this cart and compare to the cart total.
  // Only flip status='paid' when fully covered. Partial payments
  // leave the cart 'open' so subsequent methods can still take the
  // remaining balance.
  await maybeFlipCartPaid(cartId);

  return data as PaymentRow;
}

// Sum succeeded payments on a cart and flip its status to 'paid'
// once they meet or exceed the total. No-ops on already-paid carts
// and on carts with no total (free visits — handled by the
// Complete visit flow, not here).
async function maybeFlipCartPaid(cartId: string): Promise<void> {
  const { data: cart } = await supabase
    .from('lng_carts')
    .select('total_pence, status')
    .eq('id', cartId)
    .maybeSingle();
  if (!cart) return;
  const c = cart as { total_pence: number | null; status: string };
  if (c.status === 'paid' || c.status === 'voided') return;
  if (c.total_pence == null || c.total_pence <= 0) return;

  const { data: rows } = await supabase
    .from('lng_payments')
    .select('amount_pence')
    .eq('cart_id', cartId)
    .eq('status', 'succeeded');
  const succeeded = ((rows ?? []) as { amount_pence: number }[]).reduce(
    (s, r) => s + r.amount_pence,
    0
  );
  if (succeeded < c.total_pence) return;

  await supabase
    .from('lng_carts')
    .update({ status: 'paid', closed_at: new Date().toISOString() })
    .eq('id', cartId);
}

export interface VisitPaidStatus {
  visit_id: string;
  cart_id: string | null;
  amount_due_pence: number | null;
  amount_paid_pence: number;
  paid_status: 'free_visit' | 'paid' | 'partially_paid' | 'owed';
}

export function useVisitPaidStatus(visitId: string | undefined) {
  const [data, setData] = useState<VisitPaidStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    if (!visitId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: row, error: err } = await supabase
        .from('lng_visit_paid_status')
        .select('*')
        .eq('visit_id', visitId)
        .maybeSingle();
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      setData(row as VisitPaidStatus | null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [visitId, tick]);

  return { data, loading, error, refresh };
}
