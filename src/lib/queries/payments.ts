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

  // Use the canonical lng_visit_paid_status view as the single
  // source of truth for "money on file". The view already nets out
  // succeeded refunds against both lng_payments and the appointment
  // deposit — without that, this function would see gross deposit
  // and gross till captures and flip the cart to 'paid' even when
  // a refund has put the net coverage below the total. Reusing the
  // view also keeps this function in lockstep with the
  // VisitDetail / Pay surfaces that read it.
  const { data: paidRow } = await supabase
    .from('lng_visit_paid_status')
    .select('amount_paid_pence')
    .eq('visit_id', c.visit_id)
    .maybeSingle();
  const amountPaid = (paidRow as { amount_paid_pence: number } | null)?.amount_paid_pence ?? 0;

  if (amountPaid < c.total_pence) return;

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

// Whether the Shopify order linked to an appointment should credit
// against THIS visit's cart. True for same-day appliance / click-in
// veneers — the Shopify order pays for the chair-side work itself.
// False for impression appointments (in-person + virtual): the
// order pays for the downstream same-day-appliance visit, not for
// the impression visit, so crediting it here would manufacture an
// "owed back" that never existed (the £14.95 upgrade fee was never
// against the impression cart in the first place).
//
// The DB view lng_visit_paid_status counts every linked Shopify
// order as paid; callers MUST gate on this helper and subtract
// out the un-applied amount on the client side. AppointmentDetail
// already gates the pre-arrival credit card on the same allow-list
// (see AppointmentDetail.tsx:676) — this puts the post-arrival
// surfaces (VisitDetail, Pay) on the same rule.
export function shopifyOrderAppliesToVisit(
  serviceType: string | null | undefined,
): boolean {
  return serviceType === 'same_day_appliance' || serviceType === 'click_in_veneers';
}

// Whether the "Paid in full" / "Paid" label is honest for this kind
// of appointment. Impression appointments (in-person + virtual) have
// a £0 cart by design — nothing is ever charged at the impression
// visit itself; the upgrade fee paid on Shopify credits against the
// downstream same-day visit. Labelling the appointment "Paid in
// full" or the visit cart "Paid" would imply money was settled
// against this visit's bill when no bill existed. The rule applies
// only to impression appointments — other £0-balance services
// (e.g. a returning consult with nothing chargeable on the day)
// still legitimately read as "Paid in full" once their cart closes.
export function appointmentAcceptsPaidInFullLabel(
  serviceType: string | null | undefined,
): boolean {
  return (
    serviceType !== 'impression_appointment' &&
    serviceType !== 'virtual_impression_appointment'
  );
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

// Reason categories surfaced on the RefundSheet dropdown. Stored on
// lng_payment_refunds.reason_category (text + check constraint).
// Keep in sync with the migration's check list.
export type RefundReasonCategory =
  | 'item_removed'
  | 'visit_cancelled'
  | 'visit_ended_early'
  | 'service_not_delivered'
  | 'patient_request'
  | 'cart_correction'
  | 'other';

export const REFUND_REASON_CATEGORIES: Array<{ key: RefundReasonCategory; label: string }> = [
  { key: 'item_removed', label: 'Item removed from cart' },
  { key: 'visit_cancelled', label: 'Visit cancelled' },
  { key: 'visit_ended_early', label: 'Visit ended early' },
  { key: 'service_not_delivered', label: 'Service not delivered' },
  { key: 'patient_request', label: 'Patient request' },
  { key: 'cart_correction', label: 'Cart correction' },
  { key: 'other', label: 'Other' },
];

// A refundable money source on the visit. Two shapes feed this list:
//
//   • lng_payments rows captured at the till (kind='payment'). Each
//     row's refundable balance = amount_pence − sum of succeeded
//     refunds against it.
//   • The appointment's widget-paid deposit (kind='deposit'). Lives
//     on lng_appointments.deposit_external_id; refundable balance =
//     deposit_pence − sum of succeeded refunds against the
//     appointment.
//
// Both surfaces in RefundSheet treat these uniformly: pick a row,
// type an amount, submit. The edge function routes by kind.
export interface RefundableSourceRow {
  kind: 'payment' | 'deposit';
  /** lng_payments.id when kind='payment', lng_appointments.id when
   *  kind='deposit'. The edge function reads this + kind to decide
   *  which Stripe PI (if any) to refund against. */
  id: string;
  method: PaymentMethod;
  payment_journey: PaymentJourney;
  amount_pence: number;
  refunded_pence: number;
  refundable_pence: number;
  /** When the source was originally captured. For payments this is
   *  succeeded_at; for deposits it's lng_appointments.deposit_paid_at. */
  captured_at: string | null;
  taken_by_name: string | null;
  /** Display label override — deposits read as "Paid online at booking"
   *  rather than the generic "Card / contactless". Null for payments
   *  (the method drives the label). */
  source_label: string | null;
  /** Stripe card brand for this source (e.g. "visa", "mastercard"),
   *  when known. Null for cash, deposits that pre-date card-detail
   *  capture, or any payment we never saw a Stripe response for. The
   *  RefundSheet upgrades the "Going back to" row to "Visa ending in
   *  4242" when both brand + last4 are present, and falls back to a
   *  channel-level label otherwise. */
  card_brand: string | null;
  /** Last 4 digits of the card used, when known. Same rules as
   *  card_brand. */
  card_last4: string | null;
  /** Stripe PaymentIntent id for this source, when one exists. Used
   *  by useRefundableSources to lazily backfill card_brand /
   *  card_last4 via the lng-card-details-backfill edge function for
   *  rows captured before the webhook started writing those columns.
   *  Null for cash payments and any source without a PI on file. */
  stripe_payment_intent_id: string | null;
}

export function useRefundableSources({
  cartId,
  appointmentId,
}: {
  cartId: string | null | undefined;
  appointmentId: string | null | undefined;
}) {
  const [data, setData] = useState<RefundableSourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    if (!cartId && !appointmentId) {
      setData([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const sources: RefundableSourceRow[] = [];

      // ── lng_payments on the cart ─────────────────────────────
      if (cartId) {
        const { data: rows, error: err } = await supabase
          .from('lng_payments')
          .select(
            'id, method, payment_journey, amount_pence, status, succeeded_at, taken_by, card_brand, card_last4, account:accounts!taken_by ( first_name, last_name, name )',
          )
          .eq('cart_id', cartId)
          .eq('status', 'succeeded')
          .order('created_at', { ascending: true });
        if (cancelled) return;
        if (err) {
          setError(err.message);
          setLoading(false);
          return;
        }
        const paymentRows = (rows ?? []) as Array<{
          id: string;
          method: PaymentMethod;
          payment_journey: PaymentJourney;
          amount_pence: number;
          succeeded_at: string | null;
          card_brand: string | null;
          card_last4: string | null;
          account:
            | { first_name: string | null; last_name: string | null; name: string | null }
            | { first_name: string | null; last_name: string | null; name: string | null }[]
            | null;
        }>;
        const paymentIds = paymentRows.map((r) => r.id);
        let refundedByPayment = new Map<string, number>();
        if (paymentIds.length > 0) {
          const { data: refundRows, error: refundErr } = await supabase
            .from('lng_payment_refunds')
            .select('payment_id, amount_pence')
            .in('payment_id', paymentIds)
            .eq('status', 'succeeded');
          if (cancelled) return;
          if (refundErr) {
            setError(refundErr.message);
            setLoading(false);
            return;
          }
          refundedByPayment = new Map(
            paymentIds.map((id) => [
              id,
              ((refundRows ?? []) as Array<{ payment_id: string; amount_pence: number }>)
                .filter((r) => r.payment_id === id)
                .reduce((acc, r) => acc + (r.amount_pence ?? 0), 0),
            ]),
          );
        }
        // Resolve the Stripe PI for each card_terminal payment in one
        // batched query against lng_terminal_payments. Carried on the
        // RefundableSourceRow so the lazy card-detail backfill can fire
        // a single edge function call covering every PI in one round-
        // trip (instead of N round-trips, one per source).
        const piByPaymentId = new Map<string, string>();
        const cardPaymentIds = paymentRows
          .filter((r) => r.method === 'card_terminal')
          .map((r) => r.id);
        if (cardPaymentIds.length > 0) {
          const { data: tpRows } = await supabase
            .from('lng_terminal_payments')
            .select('payment_id, stripe_payment_intent_id')
            .in('payment_id', cardPaymentIds);
          if (cancelled) return;
          for (const tp of (tpRows ?? []) as Array<{
            payment_id: string;
            stripe_payment_intent_id: string | null;
          }>) {
            if (tp.stripe_payment_intent_id) {
              piByPaymentId.set(tp.payment_id, tp.stripe_payment_intent_id);
            }
          }
        }
        for (const r of paymentRows) {
          const a = Array.isArray(r.account) ? r.account[0] ?? null : r.account ?? null;
          const fn = a?.first_name?.trim();
          const ln = a?.last_name?.trim();
          const display = fn && ln ? `${fn} ${ln}` : fn ?? ln ?? a?.name?.trim() ?? null;
          const refunded = refundedByPayment.get(r.id) ?? 0;
          sources.push({
            kind: 'payment',
            id: r.id,
            method: r.method,
            payment_journey: r.payment_journey,
            amount_pence: r.amount_pence,
            refunded_pence: refunded,
            refundable_pence: Math.max(0, r.amount_pence - refunded),
            captured_at: r.succeeded_at,
            taken_by_name: display,
            source_label: null,
            card_brand: r.card_brand,
            card_last4: r.card_last4,
            stripe_payment_intent_id: piByPaymentId.get(r.id) ?? null,
          });
        }
      }

      // ── Widget deposit on the appointment ────────────────────
      if (appointmentId) {
        const { data: appt, error: aErr } = await supabase
          .from('lng_appointments')
          .select(
            'id, deposit_pence, deposit_status, deposit_provider, deposit_paid_at, deposit_external_id, card_brand, card_last4',
          )
          .eq('id', appointmentId)
          .maybeSingle();
        if (cancelled) return;
        if (aErr) {
          setError(aErr.message);
          setLoading(false);
          return;
        }
        const a = appt as {
          id: string;
          deposit_pence: number | null;
          deposit_status: string | null;
          deposit_provider: string | null;
          deposit_paid_at: string | null;
          deposit_external_id: string | null;
          card_brand: string | null;
          card_last4: string | null;
        } | null;
        if (
          a &&
          a.deposit_status === 'paid' &&
          a.deposit_provider === 'stripe' &&
          a.deposit_pence &&
          a.deposit_pence > 0 &&
          a.deposit_external_id
        ) {
          // Sum existing refunds against this appointment's deposit.
          const { data: depositRefundRows, error: depErr } = await supabase
            .from('lng_payment_refunds')
            .select('amount_pence')
            .eq('deposit_appointment_id', a.id)
            .eq('status', 'succeeded');
          if (cancelled) return;
          if (depErr) {
            setError(depErr.message);
            setLoading(false);
            return;
          }
          const depositRefunded = ((depositRefundRows ?? []) as Array<{
            amount_pence: number;
          }>).reduce((acc, r) => acc + (r.amount_pence ?? 0), 0);
          const refundable = Math.max(0, a.deposit_pence - depositRefunded);
          if (refundable > 0) {
            sources.push({
              kind: 'deposit',
              id: a.id,
              method: 'card_terminal',
              payment_journey: 'standard',
              amount_pence: a.deposit_pence,
              refunded_pence: depositRefunded,
              refundable_pence: refundable,
              captured_at: a.deposit_paid_at,
              taken_by_name: null,
              source_label: 'Paid online at booking',
              card_brand: a.card_brand,
              card_last4: a.card_last4,
              stripe_payment_intent_id: a.deposit_external_id,
            });
          }
        }
      }

      // Order: deposit first (chronologically earliest), then till
      // payments in capture order. The customer paid the deposit
      // first, so refunding it last reads naturally for the
      // accounting trail.
      sources.sort((x, y) => {
        if (x.kind === 'deposit' && y.kind !== 'deposit') return -1;
        if (y.kind === 'deposit' && x.kind !== 'deposit') return 1;
        const xt = x.captured_at ? Date.parse(x.captured_at) : 0;
        const yt = y.captured_at ? Date.parse(y.captured_at) : 0;
        return xt - yt;
      });
      setData(sources);
      setError(null);
      setLoading(false);

      // Lazy backfill of card_brand + card_last4 for sources that
      // pre-date the webhook-side capture. Fires a single edge-
      // function call covering every source with a Stripe PI but a
      // missing column. The function resolves the details from
      // Stripe, persists them on the row, and returns them so we
      // can patch the local state without a refetch. Best-effort:
      // if the edge function fails or returns null, the UI keeps
      // showing the channel-level label.
      const needBackfill = sources.filter(
        (s) =>
          s.stripe_payment_intent_id &&
          (!s.card_brand || !s.card_last4),
      );
      if (needBackfill.length > 0) {
        try {
          const payload = {
            sources: needBackfill.map((s) => ({
              kind: s.kind,
              id: s.id,
              payment_intent_id: s.stripe_payment_intent_id,
            })),
          };
          const { data: resp, error: invokeErr } = await supabase.functions.invoke(
            'lng-card-details-backfill',
            { body: payload },
          );
          if (cancelled) return;
          if (invokeErr || !resp || !Array.isArray((resp as { results?: unknown }).results)) {
            return;
          }
          const results = (resp as {
            results: Array<{ brand: string | null; last4: string | null } | null>;
          }).results;
          // Build a kind+id keyed map so the result lookup is
          // unambiguous, even if sources or results were reordered
          // by some upstream layer. The previous findIndex-by-
          // position pattern silently fell back to "no match" when
          // anything moved; the Map version makes that an explicit
          // .get() === undefined.
          const resultBySource = new Map<string, { brand: string | null; last4: string | null } | null>();
          needBackfill.forEach((source, i) => {
            resultBySource.set(`${source.kind}:${source.id}`, results[i] ?? null);
          });
          const updated = sources.map((s) => {
            const r = resultBySource.get(`${s.kind}:${s.id}`);
            if (!r) return s;
            return {
              ...s,
              card_brand: r.brand ?? s.card_brand,
              card_last4: r.last4 ?? s.card_last4,
            };
          });
          setData(updated);
        } catch {
          // best-effort
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cartId, appointmentId, tick]);

  return { data, loading, error, refresh };
}

// Refund input — exactly one of paymentId or depositAppointmentId
// must be set, mirroring the edge function's contract. The
// RefundSheet UI maps a RefundableSourceRow.kind directly to which
// id field gets populated.
export type RefundPartialInput =
  | {
      paymentId: string;
      depositAppointmentId?: never;
      amountPence: number;
      reasonCategory: RefundReasonCategory;
      reasonNote: string;
      approverAccountId: string | null;
    }
  | {
      paymentId?: never;
      depositAppointmentId: string;
      amountPence: number;
      reasonCategory: RefundReasonCategory;
      reasonNote: string;
      approverAccountId: string | null;
    };

export interface RefundPartialResult {
  refundId: string;
  refundSource: 'payment' | 'deposit';
  cumulativeRefundedPence: number;
  isFullRefund: boolean;
}

// Refunds an arbitrary amount against a captured payment OR the
// appointment's widget-paid deposit. Routes through the
// terminal-refund edge function so:
//   • Stripe refunds (card_terminal payments + every deposit) call
//     /v1/refunds server-side with the service-role key + an
//     idempotency key derived from the freshly-inserted refund row.
//   • Cash refunds also write an lng_payment_refunds row — one
//     audit table for every refund regardless of source.
//
// Manager approval is now async — staff fire the refund, a separate
// notification email lands on every configured manager (Admin →
// Emails → Manager notifications). approverAccountId is therefore
// optional; pass null for refunds issued under the new flow.
export async function refundPartial(input: RefundPartialInput): Promise<RefundPartialResult> {
  const note = input.reasonNote.trim();
  if (note.length === 0) throw new Error('A reason note is required to issue a refund');
  if (!Number.isFinite(input.amountPence) || input.amountPence <= 0) {
    throw new Error('Refund amount must be greater than zero');
  }
  const payload: Record<string, unknown> = {
    amount_pence: Math.round(input.amountPence),
    reason_category: input.reasonCategory,
    reason_note: note,
    approver_account_id: input.approverAccountId ?? null,
  };
  if (input.paymentId) {
    payload.payment_id = input.paymentId;
  } else {
    payload.deposit_appointment_id = input.depositAppointmentId;
  }

  // Route based on the underlying payment's method. Klarna refunds
  // go through Klarna's Order Management API (klarna-refund edge
  // function); everything else (card_terminal, cash, deposits)
  // stays on terminal-refund which talks to Stripe. We resolve the
  // method here so RefundSheet doesn't have to know about the
  // routing — it always calls refundPartial with the same shape.
  let endpoint = 'terminal-refund';
  if (input.paymentId) {
    const { data: payment } = await supabase
      .from('lng_payments')
      .select('method')
      .eq('id', input.paymentId)
      .maybeSingle();
    const method = (payment as { method: string } | null)?.method;
    if (method === 'klarna') endpoint = 'klarna-refund';
  }

  const url = new URL(import.meta.env.VITE_SUPABASE_URL);
  const projectRef = url.hostname.split('.')[0];
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const r = await fetch(`https://${projectRef}.functions.supabase.co/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = (await r.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    detail?: unknown;
    refund_id?: string;
    refund_source?: 'payment' | 'deposit';
    cumulative_refunded_pence?: number;
    is_full_refund?: boolean;
  };
  if (!r.ok || !body?.ok || !body.refund_id) {
    throw new Error(body?.error ?? `Refund failed (HTTP ${r.status})`);
  }
  return {
    refundId: body.refund_id,
    refundSource: body.refund_source ?? (input.paymentId ? 'payment' : 'deposit'),
    cumulativeRefundedPence: body.cumulative_refunded_pence ?? 0,
    isFullRefund: body.is_full_refund === true,
  };
}

// Voids the entire captured amount on a payment. Backward-compatible
// shim over refundPartial — every existing voidPayment caller
// (Pay.tsx) gets the same UX while the underlying audit row lands
// in lng_payment_refunds like every other refund.
export async function voidPayment(
  paymentId: string,
  _method: PaymentMethod,
  reason: string,
  approverAccountId: string | null,
): Promise<{ amountPence: number }> {
  const trimmed = reason.trim();
  if (trimmed.length === 0) throw new Error('A reason is required to void a payment');

  // Re-read the payment so we know the full amount to refund. The
  // void-this-whole-payment UX in Pay.tsx doesn't ask staff for an
  // amount; it implicitly means "all of it remaining".
  const { data: payment, error: pErr } = await supabase
    .from('lng_payments')
    .select('amount_pence, status')
    .eq('id', paymentId)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!payment) throw new Error('Payment not found');
  const p = payment as { amount_pence: number; status: string };
  if (p.status !== 'succeeded') {
    throw new Error(`Cannot void payment in status ${p.status}`);
  }

  // Sum existing refunds so the void only asks for what's left.
  const { data: refundedRows } = await supabase
    .from('lng_payment_refunds')
    .select('amount_pence')
    .eq('payment_id', paymentId)
    .eq('status', 'succeeded');
  const alreadyRefunded = ((refundedRows ?? []) as { amount_pence: number }[]).reduce(
    (acc, r) => acc + (r.amount_pence ?? 0),
    0,
  );
  const remaining = p.amount_pence - alreadyRefunded;
  if (remaining <= 0) {
    throw new Error('This payment has already been refunded in full.');
  }

  await refundPartial({
    paymentId,
    amountPence: remaining,
    reasonCategory: 'cart_correction',
    reasonNote: trimmed,
    approverAccountId,
  });
  return { amountPence: remaining };
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
