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

// Voids a previously-succeeded cash payment. Used when staff
// records cash, customer then changes their mind to card (or
// vice-versa), or staff hits the wrong amount. NOT a hard delete:
// the lng_payments row stays as audit, just flipped to 'cancelled'
// with the reason on failure_reason. Re-opens the cart if this was
// the payment that flipped it to paid, so the next attempt can take
// the bill again.
//
// Anti-theft rail: voids require a second staff sign-off
// (approverAccountId). The approver must be a different account
// from the voider — a lone cashier can't pocket cash, void the
// row, and re-ring it. Both ids land on the patient_events row
// alongside the reason.
export async function voidCashPayment(
  paymentId: string,
  reason: string,
  approverAccountId: string
): Promise<void> {
  const trimmedReason = reason.trim();
  if (trimmedReason.length === 0) throw new Error('A reason is required to void a payment');

  const { data: accountId } = await supabase.rpc('auth_account_id');
  const voidedBy = (accountId as string | null) ?? null;
  if (!approverAccountId) throw new Error('Manager approval is required to void a payment.');
  if (voidedBy && approverAccountId === voidedBy) {
    throw new Error('Approver must be a different staff member from the one voiding.');
  }

  // Read the payment to validate state + grab cart_id, amount, method.
  const { data: payment, error: pErr } = await supabase
    .from('lng_payments')
    .select('id, cart_id, method, payment_journey, amount_pence, status')
    .eq('id', paymentId)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!payment) throw new Error('Payment not found');
  const p = payment as {
    id: string;
    cart_id: string;
    method: string;
    payment_journey: string;
    amount_pence: number;
    status: string;
  };
  if (p.method !== 'cash') {
    throw new Error('voidCashPayment is for cash only. Use the card refund flow for card payments.');
  }
  if (p.status !== 'succeeded') {
    throw new Error(`Cannot void payment in status ${p.status}`);
  }

  // Block voiding once the visit is complete — at that point the
  // box has been freed and the appointment is closed, so unwinding
  // would be a multi-table reversal best handled by an admin.
  const { data: cartRow, error: cartErr } = await supabase
    .from('lng_carts')
    .select('visit_id')
    .eq('id', p.cart_id)
    .maybeSingle();
  if (cartErr) throw new Error(cartErr.message);
  const visitId = (cartRow as { visit_id: string } | null)?.visit_id ?? null;
  let patientId: string | null = null;
  if (visitId) {
    const { data: visit } = await supabase
      .from('lng_visits')
      .select('status, patient_id')
      .eq('id', visitId)
      .maybeSingle();
    const v = visit as { status: string; patient_id: string } | null;
    if (v?.status === 'complete') {
      throw new Error('Visit is already complete. Voiding payments needs an admin reversal.');
    }
    patientId = v?.patient_id ?? null;
  }

  // Mark the payment cancelled. failure_reason carries the staff
  // text; cancelled_at marks the moment.
  const { error: updErr } = await supabase
    .from('lng_payments')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      failure_reason: trimmedReason,
    })
    .eq('id', p.id);
  if (updErr) throw new Error(updErr.message);

  // Re-open the cart so the next method can take the bill. The
  // cart's status only flips to 'paid' when the sum of succeeded
  // covers the total; voiding a row drops the sum below that, so
  // re-opening is the right state.
  await supabase
    .from('lng_carts')
    .update({ status: 'open', closed_at: null })
    .eq('id', p.cart_id);

  // Audit row. event_type 'refund_issued' is the existing rail —
  // the payload carries method='cash' so a downstream consumer can
  // tell it apart from a card refund. Both staff ids (voider +
  // approver) land here so the timeline shows the 2-person
  // sign-off chain.
  if (patientId) {
    await supabase.from('patient_events').insert({
      patient_id: patientId,
      event_type: 'refund_issued',
      actor_account_id: voidedBy,
      notes: trimmedReason,
      payload: {
        payment_id: p.id,
        amount_pence: p.amount_pence,
        method: p.method,
        payment_journey: p.payment_journey,
        reason: trimmedReason,
        staff_account_id: voidedBy,
        approver_account_id: approverAccountId,
      },
    });
  }
}

// Sum payments toward a cart and flip its status to 'paid' once they
// meet or exceed the total. "Payments toward" means succeeded
// lng_payments PLUS the appointment's paid Calendly deposit when one
// was taken — without that, a £100 cart with a £25 deposit and £75
// collected at the till would never flip because the till sees only
// the £75. No-ops on already-paid / voided carts and on carts with
// no total (free visits — handled by the Complete visit flow, not
// here).
async function maybeFlipCartPaid(cartId: string): Promise<void> {
  const { data: cart } = await supabase
    .from('lng_carts')
    .select('total_pence, status, visit_id')
    .eq('id', cartId)
    .maybeSingle();
  if (!cart) return;
  const c = cart as { total_pence: number | null; status: string; visit_id: string };
  if (c.status === 'paid' || c.status === 'voided') return;
  if (c.total_pence == null || c.total_pence <= 0) return;

  const { data: rows } = await supabase
    .from('lng_payments')
    .select('amount_pence')
    .eq('cart_id', cartId)
    .eq('status', 'succeeded');
  const succeeded = ((rows ?? []) as { amount_pence: number }[]).reduce(
    (s, r) => s + r.amount_pence,
    0,
  );

  // Pull the appointment deposit (if any) for this visit. Walk-ins
  // have no appointment so the deposit term is 0. Failed deposits
  // (deposit_status = 'failed') don't credit the till.
  const { data: visit } = await supabase
    .from('lng_visits')
    .select('appointment_id')
    .eq('id', c.visit_id)
    .maybeSingle();
  let depositPaid = 0;
  const v = visit as { appointment_id: string | null } | null;
  if (v?.appointment_id) {
    const { data: appt } = await supabase
      .from('lng_appointments')
      .select('deposit_pence, deposit_status')
      .eq('id', v.appointment_id)
      .maybeSingle();
    const a = appt as { deposit_pence: number | null; deposit_status: string | null } | null;
    if (a?.deposit_status === 'paid' && typeof a.deposit_pence === 'number') {
      depositPaid = a.deposit_pence;
    }
  }

  if (succeeded + depositPaid < c.total_pence) return;

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

// Captured payments on a cart. Used by the Pay screen's
// "Already collected" list so staff can see / void specific
// methods without having to leave the till.
export interface CartPaymentRow {
  id: string;
  method: PaymentMethod;
  payment_journey: PaymentJourney;
  amount_pence: number;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  succeeded_at: string | null;
  cancelled_at: string | null;
  taken_by_name: string | null;
}

export function useCartPayments(cartId: string | null | undefined) {
  const [data, setData] = useState<CartPaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    if (!cartId) {
      setData([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('lng_payments')
        .select(
          'id, method, payment_journey, amount_pence, status, succeeded_at, cancelled_at, taken_by, account:accounts!taken_by ( first_name, last_name, name )'
        )
        .eq('cart_id', cartId)
        .order('created_at', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const mapped: CartPaymentRow[] = ((rows ?? []) as Array<{
        id: string;
        method: PaymentMethod;
        payment_journey: PaymentJourney;
        amount_pence: number;
        status: CartPaymentRow['status'];
        succeeded_at: string | null;
        cancelled_at: string | null;
        account:
          | { first_name: string | null; last_name: string | null; name: string | null }
          | { first_name: string | null; last_name: string | null; name: string | null }[]
          | null;
      }>).map((r) => {
        const a = Array.isArray(r.account) ? r.account[0] ?? null : r.account ?? null;
        const fn = a?.first_name?.trim();
        const ln = a?.last_name?.trim();
        const display = fn && ln ? `${fn} ${ln}` : fn ?? ln ?? a?.name?.trim() ?? null;
        return {
          id: r.id,
          method: r.method,
          payment_journey: r.payment_journey,
          amount_pence: r.amount_pence,
          status: r.status,
          succeeded_at: r.succeeded_at,
          cancelled_at: r.cancelled_at,
          taken_by_name: display,
        };
      });
      setData(mapped);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [cartId, tick]);

  return { data, loading, error, refresh };
}

// Voids a captured payment regardless of method. Cash routes to
// voidCashPayment (client-side, since cash needs no third-party
// reversal); card routes to the terminal-refund edge function
// (which calls Stripe's refund API). Both paths require a 2nd
// staff sign-off via approverAccountId (resolved by approveAsManager
// against email + password).
//
// Both end up with:
//   - lng_payments.status = 'cancelled'
//   - cart re-opened so the next method can charge again
//   - patient_events 'refund_issued' row with voider + approver + reason
export async function voidPayment(
  paymentId: string,
  method: PaymentMethod,
  reason: string,
  approverAccountId: string
): Promise<void> {
  const trimmed = reason.trim();
  if (trimmed.length === 0) throw new Error('A reason is required to void a payment');
  if (!approverAccountId) throw new Error('Manager approval is required.');

  if (method === 'cash') {
    await voidCashPayment(paymentId, trimmed, approverAccountId);
    return;
  }

  // Card / BNPL go through the terminal-refund edge function so
  // the Stripe refund fires server-side (and the function carries
  // the bearer to resolve the voider). approver_account_id rides
  // on the body — the function verifies it differs from the bearer
  // before recording it on the patient_events row.
  const url = new URL(import.meta.env.VITE_SUPABASE_URL);
  const projectRef = url.hostname.split('.')[0];
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const r = await fetch(`https://${projectRef}.functions.supabase.co/terminal-refund`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      payment_id: paymentId,
      reason: trimmed,
      approver_account_id: approverAccountId,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body?.ok) {
    throw new Error(body?.error ?? `Refund failed (HTTP ${r.status})`);
  }
}

// Verifies an approving manager's credentials WITHOUT changing the
// active session. Returns the approver's accounts.id when the
// password is valid, or throws.
//
// How it works: spins up a parallel Supabase client with
// persistSession=false so signing in doesn't touch localStorage or
// the global auth event bus. Calls auth_account_id() RPC on that
// client to translate the new auth user back to an accounts.id,
// then signs the temp client out so we leave no residue. The main
// app session keeps running uninterrupted on the original client.
export async function approveAsManager(
  email: string,
  password: string
): Promise<string> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new Error('Missing Supabase env vars for approver re-auth');
  }
  const tmp = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInErr } = await tmp.auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error('Approver email or password is wrong.');
  try {
    const { data: accountId, error: rpcErr } = await tmp.rpc('auth_account_id');
    if (rpcErr) throw new Error(rpcErr.message);
    if (!accountId) throw new Error('Approver has no account record.');
    return accountId as string;
  } finally {
    await tmp.auth.signOut().catch(() => undefined);
  }
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
