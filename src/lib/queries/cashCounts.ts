import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { type DateRange, dateRangeToUtcBounds } from '../dateRange.ts';
import { logFailure } from '../failureLog.ts';
import { properCase } from './appointments.ts';

// Cash reconciliation reads — past counts list, per-count statement,
// and the live "what should be in the safe right now" computation.
// Write flow lives in PR9.

function pickOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value as T;
}

// ── Cash withdrawal reasons ────────────────────────────────────────────────
// Enum mirrors the lng_cash_withdrawals.reason CHECK constraint in
// 20260520000014. Friendly labels are used on the Take-from-safe sheet,
// the Right-now card, the count statement, and the manager-notification
// email. Keep these in sync with the SQL CHECK; adding a new reason
// requires a migration AND an entry here.
export type WithdrawalReason =
  | 'bank_deposit'
  | 'float_top_up'
  | 'petty_cash'
  | 'owner_draw'
  | 'other';

export const WITHDRAWAL_REASONS: Array<{ value: WithdrawalReason; label: string }> = [
  { value: 'bank_deposit', label: 'Bank deposit' },
  { value: 'float_top_up', label: 'Float top-up' },
  { value: 'petty_cash', label: 'Petty cash' },
  { value: 'owner_draw', label: 'Owner draw' },
  { value: 'other', label: 'Other' },
];

export function withdrawalReasonLabel(reason: string): string {
  return WITHDRAWAL_REASONS.find((r) => r.value === reason)?.label ?? reason;
}

// ── Past counts list ────────────────────────────────────────────────────────

export interface CashCountRow {
  id: string;
  period_start: string;
  period_end: string;
  expected_pence: number;
  actual_pence: number | null;
  variance_pence: number;
  status: 'pending' | 'signed' | 'disputed';
  /** 'regular' chains onto the previous signed count. 'legacy_baseline'
   *  is the one-shot launch / re-launch seeding row. Used by the
   *  history list to render the row as a baseline rather than a
   *  routine reconciliation (no over/under variance pill, "Starting
   *  balance" copy instead of "expected"). Defaults to 'regular' on
   *  any historical row that predates the kind column. */
  kind: 'regular' | 'legacy_baseline';
  notes: string | null;
  counted_by_name: string;
  counted_at: string;
  signed_off_by_name: string | null;
  signed_off_at: string | null;
}

interface RawCashCount {
  id: string;
  period_start: string;
  period_end: string;
  expected_pence: number;
  actual_pence: number | null;
  variance_pence: number;
  status: 'pending' | 'signed' | 'disputed';
  kind?: 'regular' | 'legacy_baseline' | null;
  notes: string | null;
  counted_at: string;
  signed_off_at: string | null;
  counted_by:
    | { first_name: string | null; last_name: string | null; name: string | null }
    | { first_name: string | null; last_name: string | null; name: string | null }[]
    | null;
  signed_off_by:
    | { first_name: string | null; last_name: string | null; name: string | null }
    | { first_name: string | null; last_name: string | null; name: string | null }[]
    | null;
}

export function shapeCashCounts(raw: RawCashCount[]): CashCountRow[] {
  return raw
    .map((r) => ({
      id: r.id,
      period_start: r.period_start,
      period_end: r.period_end,
      expected_pence: r.expected_pence,
      actual_pence: r.actual_pence,
      variance_pence: r.variance_pence,
      status: r.status,
      kind: (r.kind === 'legacy_baseline' ? 'legacy_baseline' : 'regular') as
        | 'regular'
        | 'legacy_baseline',
      notes: r.notes,
      counted_by_name: composePersonName(pickOne(r.counted_by)),
      counted_at: r.counted_at,
      signed_off_by_name: r.signed_off_by ? composePersonName(pickOne(r.signed_off_by)) : null,
      signed_off_at: r.signed_off_at,
    }))
    .sort((a, b) => b.period_end.localeCompare(a.period_end));
}

function composePersonName(
  p: { first_name: string | null; last_name: string | null; name?: string | null } | null,
): string {
  if (!p) return '—';
  // Title Case so reports + cash count statements never echo
  // whatever casing happened to land in the source row.
  const fn = properCase(p.first_name);
  const ln = properCase(p.last_name);
  if (fn && ln) return `${fn} ${ln}`;
  return fn || ln || properCase(p.name ?? null) || '—';
}

interface CashCountsResult {
  data: CashCountRow[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useCashCounts(): CashCountsResult {
  const [data, setData] = useState<CashCountRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await supabase
          .from('lng_cash_counts')
          .select(
            `id, period_start, period_end, expected_pence, actual_pence, variance_pence,
             status, kind, notes, counted_at, signed_off_at,
             counted_by:accounts!counted_by ( first_name, last_name, name ),
             signed_off_by:accounts!signed_off_by ( first_name, last_name, name )`,
          )
          .order('period_end', { ascending: false });
        if (cancelled) return;
        if (res.error) throw new Error(`cash_counts: ${res.error.message}`);
        const out = shapeCashCounts((res.data ?? []) as RawCashCount[]);
        if (cancelled) return;
        setData(out);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load cash counts';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'cash.counts',
          severity: 'error',
          message,
          context: {},
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { data, loading, error, refresh: () => setTick((t) => t + 1) };
}

// ── Current outstanding cash position ───────────────────────────────────────
// "What should be in the safe right now?" =
//   last_signed_count.actual_pence (carry-forward opening balance)
//   + sum of cash payments since the last signed count's period_end
//   − sum of cash refunds in that same window
//   − sum of cash withdrawals in that same window (bank deposit,
//     float top-up, petty cash, owner draw, other — recorded via
//     recordCashWithdrawal)
//
// When no signed count exists yet, baseline = 0 and the running
// total accumulates from the very first cash event.

export interface CashPositionPaymentLine {
  kind: 'payment';
  payment_id: string;
  amount_pence: number;
  taken_at: string;
  patient_name: string;
  appointment_ref: string | null;
  /** Visit the payment lives on — the click-through target from
   *  the Cash counts table (visit detail page shows the
   *  appointment / walk-in context, the full cart, and the
   *  payment that made it onto this row). Null only for the
   *  rare orphan case where the cart was disassociated. */
  visit_id: string | null;
}

export interface CashPositionWithdrawalLine {
  kind: 'withdrawal';
  withdrawal_id: string;
  amount_pence: number;
  taken_at: string;
  /** One of the lng_cash_withdrawals.reason enum values. The UI
   *  resolves the friendly label via WITHDRAWAL_REASONS. */
  reason: WithdrawalReason;
  note: string | null;
  taken_by_name: string | null;
}

export interface CashPositionRefundLine {
  kind: 'refund';
  refund_id: string;
  amount_pence: number;
  /** Named taken_at (not refunded_at) so refunds sort and render through
   *  the same chronological path as payments and withdrawals. */
  taken_at: string;
  /** Patient the refund traces back to, when the original sale is in
   *  this window; null for refunds against sales from a prior period. */
  patient_name: string | null;
}

/** A cash sale that was taken and then fully refunded in the same
 *  window. The money came in and went straight back out, so it nets to
 *  zero and never moves the safe. Shown for the audit trail, not counted
 *  in "cash in" or "cash out". */
export interface CashPositionRefundedSaleLine {
  kind: 'refunded_sale';
  payment_id: string;
  amount_pence: number;
  taken_at: string;
  patient_name: string;
  visit_id: string | null;
}

export type CashPositionLine =
  | CashPositionPaymentLine
  | CashPositionWithdrawalLine
  | CashPositionRefundLine
  | CashPositionRefundedSaleLine;

export interface CashPosition {
  /** Running balance = baseline + payments − refunds − withdrawals.
   *  Now an absolute figure, not a delta. */
  expected_in_safe_pence: number;
  /** Opening balance carried forward from the last signed count's
   *  actual_pence (or 0 when there has never been a signed count). */
  baseline_pence: number;
  payment_count: number;
  withdrawal_count: number;
  /** Refunds that moved the safe — partial clawbacks and refunds against
   *  older sales. Excludes fully-refunded same-window sales (those net to
   *  zero and are surfaced as refunded_sale lines instead). */
  refund_count: number;
  /** Same-window sales that were taken and fully refunded (net zero). */
  refunded_sale_count: number;
  earliest_payment_at: string | null;
  latest_payment_at: string | null;
  // Last signed count is the anchor.
  last_signed_count: {
    id: string;
    period_end: string;
    actual_pence: number | null;
    signed_off_at: string;
  } | null;
  lines: CashPositionLine[];
}

interface RawCashPositionVisit {
  id: string;
  patient: { first_name: string | null; last_name: string | null; name: string | null } | { first_name: string | null; last_name: string | null; name: string | null }[] | null;
  appointment: { appointment_ref: string | null } | { appointment_ref: string | null }[] | null;
  walk_in: { appointment_ref: string | null } | { appointment_ref: string | null }[] | null;
}

interface RawCashPosition {
  id: string;
  amount_pence: number;
  succeeded_at: string;
  status: string;
  cart:
    | { visit: RawCashPositionVisit | RawCashPositionVisit[] | null }
    | { visit: RawCashPositionVisit | RawCashPositionVisit[] | null }[]
    | null;
}

interface CashPositionResult {
  data: CashPosition | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useCashPosition(): CashPositionResult {
  const [data, setData] = useState<CashPosition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // Anchor: most-recent signed count's period_end.
        const lastRes = await supabase
          .from('lng_cash_counts')
          .select('id, period_end, actual_pence, signed_off_at')
          .eq('status', 'signed')
          .order('period_end', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (cancelled) return;
        if (lastRes.error) throw new Error(`last_count: ${lastRes.error.message}`);
        const last = lastRes.data as { id: string; period_end: string; actual_pence: number | null; signed_off_at: string } | null;
        const sinceIso = last ? last.period_end : '1970-01-01T00:00:00Z';

        const [paymentsRes, refundsRes, withdrawalsRes] = await Promise.all([
          supabase
            .from('lng_payments')
            .select(
              `id, amount_pence, succeeded_at, status,
               cart:lng_carts (
                 visit:lng_visits (
                   id,
                   patient:patients ( first_name, last_name ),
                   appointment:lng_appointments ( appointment_ref ),
                   walk_in:lng_walk_ins ( appointment_ref )
                 )
               )`,
            )
            .eq('method', 'cash')
            // Include cancelled sales, not just succeeded: a fully
            // refunded cash sale flips to 'cancelled' but the cash still
            // physically entered and left the drawer, so we need it to
            // net its own refund to zero (below). Filtering it out here
            // while still subtracting its refund is what made the safe
            // read £70 light.
            .in('status', ['succeeded', 'cancelled'])
            .gt('succeeded_at', sinceIso)
            .order('succeeded_at', { ascending: false }),
          // Cash refunds in the same window. A partial refund leaves the
          // payment 'succeeded' (real money out — subtracted and shown).
          // A full refund flips the payment to 'cancelled'; that pair
          // nets to zero and is shown as a single refunded-sale line
          // instead of double-counting the cash out.
          supabase
            .from('lng_payment_refunds')
            .select('id, amount_pence, refunded_at, payment_id')
            .eq('method', 'cash')
            .eq('status', 'succeeded')
            .gt('refunded_at', sinceIso)
            .order('refunded_at', { ascending: false }),
          // Cash withdrawals — bank deposits, float top-ups, petty
          // cash etc. Each row drops the running safe balance by its
          // amount_pence. Joined to accounts for the taken_by display
          // name on the Right-now card.
          supabase
            .from('lng_cash_withdrawals')
            .select(
              `id, amount_pence, reason, note, taken_at,
               taken_by_account:accounts!lng_cash_withdrawals_taken_by_fkey ( first_name, last_name )`,
            )
            .gt('taken_at', sinceIso)
            .order('taken_at', { ascending: false }),
        ]);
        if (cancelled) return;
        if (paymentsRes.error) throw new Error(`cash_payments: ${paymentsRes.error.message}`);
        if (refundsRes.error) throw new Error(`cash_refunds: ${refundsRes.error.message}`);
        if (withdrawalsRes.error) throw new Error(`cash_withdrawals: ${withdrawalsRes.error.message}`);

        const raw = (paymentsRes.data ?? []) as RawCashPosition[];
        const refundRows = ((refundsRes.data ?? []) as Array<{
          id: string;
          amount_pence: number;
          refunded_at: string;
          payment_id: string | null;
        }>);
        const withdrawalRows = ((withdrawalsRes.data ?? []) as Array<{
          id: string;
          amount_pence: number;
          reason: WithdrawalReason;
          note: string | null;
          taken_at: string;
          taken_by_account:
            | { first_name: string | null; last_name: string | null }
            | { first_name: string | null; last_name: string | null }[]
            | null;
        }>);
        // Baseline carries forward from the last signed count's
        // actual_pence; first-ever-count case starts from zero and
        // accumulates pure flow until the first sign-off.
        const baseline = last?.actual_pence ?? 0;

        let earliest: string | null = null;
        let latest: string | null = null;
        const track = (iso: string | null) => {
          if (!iso) return;
          if (!earliest || iso < earliest) earliest = iso;
          if (!latest || iso > latest) latest = iso;
        };

        // Sum every refund against each payment, so we can tell a fully
        // refunded sale (taken then handed straight back — nets to zero)
        // from a partial clawback (real money out) or a refund against a
        // sale from a previous period.
        const refundedByPayment = new Map<string, number>();
        for (const r of refundRows) {
          if (!r.payment_id) continue;
          refundedByPayment.set(r.payment_id, (refundedByPayment.get(r.payment_id) ?? 0) + (r.amount_pence ?? 0));
        }
        // A sale is "fully refunded" when its refunds cover its full
        // amount. Those are surfaced as refunded_sale lines and their
        // refunds are NOT subtracted again (the sale simply isn't counted
        // as cash in).
        const fullyRefundedIds = new Set<string>();
        for (const r of raw) {
          const refunded = refundedByPayment.get(r.id) ?? 0;
          if (refunded > 0 && refunded >= r.amount_pence) fullyRefundedIds.add(r.id);
        }

        let total = baseline;
        const paymentLines: CashPositionPaymentLine[] = [];
        const refundedSaleLines: CashPositionRefundedSaleLine[] = [];
        for (const r of raw) {
          track(r.succeeded_at);
          const cart = pickOne(r.cart);
          const visit = pickOne(cart?.visit ?? null);
          const patient = pickOne(visit?.patient ?? null);
          const appt = pickOne(visit?.appointment ?? null);
          const walkIn = pickOne(visit?.walk_in ?? null);
          const patientName = composePersonName(patient);
          if (fullyRefundedIds.has(r.id)) {
            // Money in and straight back out — no effect on the safe.
            refundedSaleLines.push({
              kind: 'refunded_sale' as const,
              payment_id: r.id,
              amount_pence: r.amount_pence,
              taken_at: r.succeeded_at,
              patient_name: patientName,
              visit_id: visit?.id ?? null,
            });
          } else {
            total += r.amount_pence;
            paymentLines.push({
              kind: 'payment' as const,
              payment_id: r.id,
              amount_pence: r.amount_pence,
              taken_at: r.succeeded_at,
              patient_name: patientName,
              appointment_ref: appt?.appointment_ref ?? walkIn?.appointment_ref ?? null,
              visit_id: visit?.id ?? null,
            });
          }
        }

        // Refunds that actually moved the safe: partial clawbacks against
        // a kept sale, and refunds against sales from a prior period
        // (whose cash sat in the opening balance). Refunds belonging to a
        // fully-refunded same-window sale are already netted above.
        const nameByPaymentId = new Map<string, string>();
        for (const l of paymentLines) nameByPaymentId.set(l.payment_id, l.patient_name);
        const refundLines: CashPositionRefundLine[] = [];
        for (const rr of refundRows) {
          if (rr.payment_id && fullyRefundedIds.has(rr.payment_id)) continue;
          total -= rr.amount_pence ?? 0;
          track(rr.refunded_at);
          refundLines.push({
            kind: 'refund' as const,
            refund_id: rr.id,
            amount_pence: rr.amount_pence ?? 0,
            taken_at: rr.refunded_at,
            patient_name: rr.payment_id ? (nameByPaymentId.get(rr.payment_id) ?? null) : null,
          });
        }

        const withdrawalLines: CashPositionWithdrawalLine[] = withdrawalRows.map((w) => {
          const actor = pickOne(w.taken_by_account ?? null);
          track(w.taken_at);
          total -= w.amount_pence ?? 0;
          return {
            kind: 'withdrawal' as const,
            withdrawal_id: w.id,
            amount_pence: w.amount_pence,
            taken_at: w.taken_at,
            reason: w.reason,
            note: w.note,
            taken_by_name: composePersonName(actor),
          };
        });

        // Interleave by time so the activity card reads as a
        // chronological narrative of safe movements.
        const lines: CashPositionLine[] = [...paymentLines, ...refundedSaleLines, ...refundLines, ...withdrawalLines]
          .sort((a, b) => (a.taken_at < b.taken_at ? 1 : a.taken_at > b.taken_at ? -1 : 0));

        if (cancelled) return;
        setData({
          expected_in_safe_pence: total,
          baseline_pence: baseline,
          payment_count: paymentLines.length,
          withdrawal_count: withdrawalLines.length,
          refund_count: refundLines.length,
          refunded_sale_count: refundedSaleLines.length,
          earliest_payment_at: earliest,
          latest_payment_at: latest,
          last_signed_count: last,
          lines,
        });
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not compute cash position';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'cash.position',
          severity: 'error',
          message,
          context: {},
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { data, loading, error, refresh: () => setTick((t) => t + 1) };
}

// ── Anomaly thresholds (read) ───────────────────────────────────────────────

export interface AnomalyThresholds {
  discount_pct: number;
  void_window_minutes: number;
  cash_variance_pence: number;
  cash_count_overdue_days: number;
}

interface ThresholdsResult {
  data: AnomalyThresholds | null;
  loading: boolean;
  error: string | null;
}

const ANOMALY_KEYS = [
  'anomaly.discount_pct_threshold',
  'anomaly.void_window_minutes',
  'anomaly.cash_variance_pence',
  'anomaly.cash_count_overdue_days',
];

export function useAnomalyThresholds(): ThresholdsResult {
  const [data, setData] = useState<AnomalyThresholds | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await supabase
          .from('lng_settings')
          .select('key, value')
          .is('location_id', null)
          .in('key', ANOMALY_KEYS);
        if (cancelled) return;
        if (res.error) throw new Error(res.error.message);
        const map = new Map<string, number>();
        for (const row of (res.data ?? []) as { key: string; value: number }[]) {
          // value is JSONB; numeric values come back as a JS number.
          map.set(row.key, Number(row.value));
        }
        // Throw loudly if any threshold is missing — the brief says
        // every behaviour-driving value comes from the schema, so a
        // missing setting is a configuration bug, not a fallback case.
        const required: Array<keyof AnomalyThresholds> = [
          'discount_pct',
          'void_window_minutes',
          'cash_variance_pence',
          'cash_count_overdue_days',
        ];
        const lookup: Record<keyof AnomalyThresholds, string> = {
          discount_pct: 'anomaly.discount_pct_threshold',
          void_window_minutes: 'anomaly.void_window_minutes',
          cash_variance_pence: 'anomaly.cash_variance_pence',
          cash_count_overdue_days: 'anomaly.cash_count_overdue_days',
        };
        const out = {} as AnomalyThresholds;
        for (const k of required) {
          const v = map.get(lookup[k]);
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            throw new Error(`Missing or invalid lng_settings entry: ${lookup[k]}`);
          }
          out[k] = v;
        }
        if (cancelled) return;
        setData(out);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load anomaly thresholds';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'cash.anomaly_thresholds',
          severity: 'critical',
          message,
          context: {},
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}

// ── Anomaly aggregations ────────────────────────────────────────────────────

export type AnomalyKind =
  | 'discount_above_threshold'
  | 'void_in_window'
  | 'cash_count_overdue'
  | 'cash_variance_high';

export interface AnomalyFlag {
  kind: AnomalyKind;
  title: string;
  detail: string;
  amount_pence?: number;
  occurred_at?: string;
  visit_id?: string;
  reference: string; // payment_id / discount_id / count_id
}

export interface AnomalyData {
  thresholds: AnomalyThresholds;
  flags: AnomalyFlag[];
  // Convenience grouped-by-kind for the per-section badges.
  counts: Record<AnomalyKind, number>;
}

interface AnomalyDiscountRow {
  id: string;
  amount_pence: number;
  applied_at: string;
  cart:
    | {
        subtotal_pence: number | null;
        visit: { id: string } | { id: string }[] | null;
      }
    | {
        subtotal_pence: number | null;
        visit: { id: string } | { id: string }[] | null;
      }[]
    | null;
}

interface AnomalyVoidRow {
  id: string;
  amount_pence: number;
  succeeded_at: string | null;
  cancelled_at: string;
  cart:
    | { visit: { id: string } | { id: string }[] | null }
    | { visit: { id: string } | { id: string }[] | null }[]
    | null;
}

export function aggregateAnomalies(
  thresholds: AnomalyThresholds,
  discounts: AnomalyDiscountRow[],
  voids: AnomalyVoidRow[],
  lastSignedCount: { period_end: string } | null,
  now: Date,
): AnomalyData {
  const flags: AnomalyFlag[] = [];

  for (const d of discounts) {
    const cart = pickOne(d.cart);
    const visit = pickOne(cart?.visit ?? null);
    const subtotal = cart?.subtotal_pence ?? 0;
    if (subtotal <= 0) continue;
    const pct = (d.amount_pence / subtotal) * 100;
    if (pct >= thresholds.discount_pct) {
      flags.push({
        kind: 'discount_above_threshold',
        title: `Discount of ${pct.toFixed(0)}%`,
        detail: `Above the ${thresholds.discount_pct}% threshold (£${(d.amount_pence / 100).toFixed(2)} on a £${(subtotal / 100).toFixed(2)} cart).`,
        amount_pence: d.amount_pence,
        occurred_at: d.applied_at,
        visit_id: visit?.id,
        reference: d.id,
      });
    }
  }

  for (const v of voids) {
    if (!v.succeeded_at) continue;
    const minutes = Math.round(
      (new Date(v.cancelled_at).getTime() - new Date(v.succeeded_at).getTime()) / 60000,
    );
    if (minutes <= thresholds.void_window_minutes) {
      const cart = pickOne(v.cart);
      const visit = pickOne(cart?.visit ?? null);
      flags.push({
        kind: 'void_in_window',
        title: `Void within ${minutes} min of capture`,
        detail: `Inside the ${thresholds.void_window_minutes}-minute window — captured then voided quickly.`,
        amount_pence: v.amount_pence,
        occurred_at: v.cancelled_at,
        visit_id: visit?.id,
        reference: v.id,
      });
    }
  }

  if (lastSignedCount) {
    const ageDays = (now.getTime() - new Date(lastSignedCount.period_end).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays >= thresholds.cash_count_overdue_days) {
      flags.push({
        kind: 'cash_count_overdue',
        title: 'Cash count overdue',
        detail: `${Math.round(ageDays)} days since the last signed count — threshold is ${thresholds.cash_count_overdue_days}.`,
        occurred_at: lastSignedCount.period_end,
        reference: lastSignedCount.period_end,
      });
    }
  } else {
    // No signed count ever — still a flag worth raising.
    flags.push({
      kind: 'cash_count_overdue',
      title: 'No cash count on record',
      detail: 'The safe has never been formally counted. Run a count to establish a baseline.',
      reference: 'no_count',
    });
  }

  flags.sort((a, b) => (b.occurred_at ?? '').localeCompare(a.occurred_at ?? ''));

  const counts: Record<AnomalyKind, number> = {
    discount_above_threshold: 0,
    void_in_window: 0,
    cash_count_overdue: 0,
    cash_variance_high: 0,
  };
  for (const f of flags) counts[f.kind] += 1;

  return { thresholds, flags, counts };
}

interface AnomaliesResult {
  data: AnomalyData | null;
  loading: boolean;
  error: string | null;
}

export function useAnomalies(range: DateRange): AnomaliesResult {
  const [data, setData] = useState<AnomalyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { fromIso, toIso } = dateRangeToUtcBounds(range);
    (async () => {
      try {
        const [settingsRes, discRes, voidRes, lastRes] = await Promise.all([
          supabase
            .from('lng_settings')
            .select('key, value')
            .is('location_id', null)
            .in('key', ANOMALY_KEYS),
          supabase
            .from('lng_cart_discounts')
            .select(
              `id, amount_pence, applied_at,
               cart:lng_carts ( subtotal_pence, visit:lng_visits ( id ) )`,
            )
            .gte('applied_at', fromIso)
            .lte('applied_at', toIso),
          supabase
            .from('lng_payments')
            .select(
              `id, amount_pence, succeeded_at, cancelled_at,
               cart:lng_carts ( visit:lng_visits ( id ) )`,
            )
            .eq('status', 'cancelled')
            .gte('cancelled_at', fromIso)
            .lte('cancelled_at', toIso),
          supabase
            .from('lng_cash_counts')
            .select('period_end')
            .eq('status', 'signed')
            .order('period_end', { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);

        if (cancelled) return;
        if (settingsRes.error) throw new Error(`settings: ${settingsRes.error.message}`);
        if (discRes.error) throw new Error(`discounts: ${discRes.error.message}`);
        if (voidRes.error) throw new Error(`voids: ${voidRes.error.message}`);
        if (lastRes.error) throw new Error(`last_count: ${lastRes.error.message}`);

        const map = new Map<string, number>();
        for (const row of (settingsRes.data ?? []) as { key: string; value: number }[]) {
          map.set(row.key, Number(row.value));
        }
        const thresholds: AnomalyThresholds = {
          discount_pct: ensureNumber(map.get('anomaly.discount_pct_threshold'), 'anomaly.discount_pct_threshold'),
          void_window_minutes: ensureNumber(map.get('anomaly.void_window_minutes'), 'anomaly.void_window_minutes'),
          cash_variance_pence: ensureNumber(map.get('anomaly.cash_variance_pence'), 'anomaly.cash_variance_pence'),
          cash_count_overdue_days: ensureNumber(map.get('anomaly.cash_count_overdue_days'), 'anomaly.cash_count_overdue_days'),
        };

        const out = aggregateAnomalies(
          thresholds,
          (discRes.data ?? []) as AnomalyDiscountRow[],
          (voidRes.data ?? []) as AnomalyVoidRow[],
          (lastRes.data ?? null) as { period_end: string } | null,
          new Date(),
        );

        if (cancelled) return;
        setData(out);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load anomalies';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'cash.anomalies',
          severity: 'error',
          message,
          context: { range },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range]);

  return { data, loading, error };
}

function ensureNumber(v: number | undefined, key: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`Missing or invalid lng_settings entry: ${key}`);
  }
  return v;
}

// ── Write mutations ─────────────────────────────────────────────────────────
// Three-step flow:
//   1. createCashCount — opens a pending count for a period, snapshots
//      every cash payment in that period as an immutable line row,
//      records expected_pence at snapshot time. The counter is the
//      caller. Returns the new count id.
//   2. updateCashCountActual — counter enters the physical amount
//      they observed in the safe. Variance is the generated column,
//      so we just write actual_pence + notes. Allowed only while the
//      count is pending.
//   3. signCashCount — manager re-auths with their password (parallel
//      Supabase client, doesn't disturb the cashier session — same
//      pattern as discount + void approvals). Status flips to signed
//      with both timestamps + accounts ids landed.
//
// Each step throws on validation failure with a meaningful message,
// no silent fallback.


export interface CreateCashCountInput {
  location_id: string;
  period_start: string; // ISO timestamptz
  period_end: string;   // ISO timestamptz
  // 'regular' (the default) chains onto the previous signed count.
  // 'legacy_baseline' is the explicit "start the chain fresh" path
  // triggered from Admin → Financials when launching the app. Both
  // kinds compute expected_pence the same way; the column exists so
  // admins (and the history list) can tell baselines apart from
  // routine reconciliation counts.
  kind?: 'regular' | 'legacy_baseline';
}

export async function createCashCount(input: CreateCashCountInput): Promise<{ count_id: string; expected_pence: number; lines_count: number; kind: 'regular' | 'legacy_baseline' }> {
  if (input.period_end <= input.period_start) {
    throw new Error('Period end must be after period start.');
  }
  const { data: meId } = await supabase.rpc('auth_account_id');
  const counterId = (meId as string | null) ?? null;
  if (!counterId) throw new Error('Could not resolve current account.');

  // Snapshot the cash payments, refunds AND withdrawals that fall in
  // this period. We do this BEFORE inserting the count row so we
  // know expected_pence up front. Once the count is signed the
  // lines are immutable; even if payments are voided / withdrawals
  // are corrected afterwards, the count's record stays exact.
  //
  // Cash refunds drop expected_pence by exactly their amount — the
  // cash left the drawer when the staff member handed it back.
  // Withdrawals do the same (bank deposit, float top-up, etc.).
  // Baseline is the previous signed count's actual_pence (the
  // opening balance the safe carries into this period); zero when
  // this is the first ever count.
  const [baselineRes, paymentsRes, refundsSnapshotRes, withdrawalsSnapshotRes] = await Promise.all([
    supabase
      .from('lng_cash_counts')
      .select('actual_pence, period_end')
      .eq('status', 'signed')
      .lte('period_end', input.period_start)
      .order('period_end', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('lng_payments')
      .select(
        `id, amount_pence, succeeded_at, status,
         cart:lng_carts (
           total_pence,
           visit:lng_visits (
             patient:patients ( first_name, last_name ),
             appointment:lng_appointments ( appointment_ref ),
             walk_in:lng_walk_ins ( appointment_ref )
           )
         )`,
      )
      .eq('method', 'cash')
      // Include cancelled (fully-refunded) sales so the snapshot can net
      // them against their refunds instead of subtracting the refund on
      // its own — the same fix as the live cash position.
      .in('status', ['succeeded', 'cancelled'])
      .gte('succeeded_at', input.period_start)
      .lte('succeeded_at', input.period_end),
    supabase
      .from('lng_payment_refunds')
      .select('amount_pence, payment_id')
      .eq('method', 'cash')
      .eq('status', 'succeeded')
      .gte('refunded_at', input.period_start)
      .lte('refunded_at', input.period_end),
    supabase
      .from('lng_cash_withdrawals')
      .select(
        `id, amount_pence, reason, note, taken_at,
         taken_by_account:accounts!lng_cash_withdrawals_taken_by_fkey ( first_name, last_name )`,
      )
      .gte('taken_at', input.period_start)
      .lte('taken_at', input.period_end),
  ]);
  if (baselineRes.error) throw new Error(baselineRes.error.message);
  if (paymentsRes.error) throw new Error(paymentsRes.error.message);
  if (refundsSnapshotRes.error) throw new Error(refundsSnapshotRes.error.message);
  if (withdrawalsSnapshotRes.error) throw new Error(withdrawalsSnapshotRes.error.message);
  const baselinePence = (baselineRes.data as { actual_pence: number | null } | null)?.actual_pence ?? 0;
  const refundSnapshotRows = ((refundsSnapshotRes.data ?? []) as Array<{
    amount_pence: number;
    payment_id: string | null;
  }>);
  const withdrawalSnapshotRows = ((withdrawalsSnapshotRes.data ?? []) as Array<{
    id: string;
    amount_pence: number;
    reason: WithdrawalReason;
    note: string | null;
    taken_at: string;
    taken_by_account:
      | { first_name: string | null; last_name: string | null }
      | { first_name: string | null; last_name: string | null }[]
      | null;
  }>);
  const cashWithdrawalsTotal = withdrawalSnapshotRows.reduce(
    (acc, w) => acc + (w.amount_pence ?? 0),
    0,
  );

  interface RawSnapshot {
    id: string;
    amount_pence: number;
    succeeded_at: string;
    status: string;
    cart:
      | {
          total_pence: number | null;
          visit:
            | {
                patient: { first_name: string | null; last_name: string | null; name: string | null } | { first_name: string | null; last_name: string | null; name: string | null }[] | null;
                appointment: { appointment_ref: string | null } | { appointment_ref: string | null }[] | null;
                walk_in: { appointment_ref: string | null } | { appointment_ref: string | null }[] | null;
              }
            | {
                patient: { first_name: string | null; last_name: string | null; name: string | null } | { first_name: string | null; last_name: string | null; name: string | null }[] | null;
                appointment: { appointment_ref: string | null } | { appointment_ref: string | null }[] | null;
                walk_in: { appointment_ref: string | null } | { appointment_ref: string | null }[] | null;
              }[]
            | null;
        }
      | {
          total_pence: number | null;
          visit:
            | {
                patient: { first_name: string | null; last_name: string | null; name: string | null } | { first_name: string | null; last_name: string | null; name: string | null }[] | null;
                appointment: { appointment_ref: string | null } | { appointment_ref: string | null }[] | null;
                walk_in: { appointment_ref: string | null } | { appointment_ref: string | null }[] | null;
              }
            | {
                patient: { first_name: string | null; last_name: string | null; name: string | null } | { first_name: string | null; last_name: string | null; name: string | null }[] | null;
                appointment: { appointment_ref: string | null } | { appointment_ref: string | null }[] | null;
                walk_in: { appointment_ref: string | null } | { appointment_ref: string | null }[] | null;
              }[]
            | null;
        }[]
      | null;
  }
  const raw = (paymentsRes.data ?? []) as RawSnapshot[];
  // A sale is fully refunded when its refunds cover its whole amount. Such
  // a sale never nets any cash into the safe, so it is neither counted as
  // cash in nor has its refund subtracted (doing both was the £70 bug).
  const refundedByPayment = new Map<string, number>();
  for (const r of refundSnapshotRows) {
    if (!r.payment_id) continue;
    refundedByPayment.set(r.payment_id, (refundedByPayment.get(r.payment_id) ?? 0) + (r.amount_pence ?? 0));
  }
  const fullyRefundedIds = new Set<string>();
  for (const r of raw) {
    const refunded = refundedByPayment.get(r.id) ?? 0;
    if (refunded > 0 && refunded >= r.amount_pence) fullyRefundedIds.add(r.id);
  }
  // Kept sales are the ones that actually left cash in the drawer.
  const keptPayments = raw.filter((r) => !fullyRefundedIds.has(r.id));
  const keptPaymentsTotal = keptPayments.reduce((s, r) => s + r.amount_pence, 0);
  // Subtract only refunds that moved the safe: partial clawbacks and
  // refunds against sales from an earlier period. Refunds belonging to a
  // fully-refunded same-period sale are already netted by exclusion.
  const cashRefundsTotal = refundSnapshotRows.reduce(
    (acc, r) => acc + (r.payment_id && fullyRefundedIds.has(r.payment_id) ? 0 : (r.amount_pence ?? 0)),
    0,
  );
  // Running balance: baseline carried from the previous signed count
  // + kept cash payments − refunds that moved the safe − withdrawals.
  // Clamp at 0 — the DB check (expected_pence >= 0) would otherwise
  // reject the insert. If you see this clamp fire in practice the
  // underlying figures are inconsistent and the count needs investigating.
  const expected_pence = Math.max(
    0,
    baselinePence
      + keptPaymentsTotal
      - cashRefundsTotal
      - cashWithdrawalsTotal,
  );

  // Insert the count row. lines come next.
  const kind = input.kind ?? 'regular';
  const { data: insertedCount, error: countErr } = await supabase
    .from('lng_cash_counts')
    .insert({
      location_id: input.location_id,
      period_start: input.period_start,
      period_end: input.period_end,
      expected_pence,
      counted_by: counterId,
      kind,
    })
    .select('id')
    .single();
  if (countErr) {
    // 42703 = column does not exist on this Meridian deploy (migration
    // 20260512000009 not yet applied). Retry without the kind column
    // rather than block the cash count entirely — staff at a venue
    // that hasn't shipped the migration yet still need to count cash.
    if (countErr.code === '42703' && kind === 'regular') {
      const retry = await supabase
        .from('lng_cash_counts')
        .insert({
          location_id: input.location_id,
          period_start: input.period_start,
          period_end: input.period_end,
          expected_pence,
          counted_by: counterId,
        })
        .select('id')
        .single();
      if (retry.error || !retry.data) {
        throw new Error(`Could not create count: ${retry.error?.message ?? 'no row returned'}`);
      }
      const count_id_fallback = (retry.data as { id: string }).id;
      return { count_id: count_id_fallback, expected_pence, lines_count: 0, kind };
    }
    throw new Error(`Could not create count: ${countErr.message}`);
  }
  const count_id = (insertedCount as { id: string }).id;

  if (keptPayments.length > 0) {
    // Snapshot only the sales that kept cash in the drawer, so the stored
    // per-payment breakdown reconciles to expected_pence. Fully-refunded
    // sales are intentionally omitted — they netted to nothing.
    const lineRows = keptPayments.map((r) => {
      const cart = pickOne(r.cart);
      const visit = pickOne(cart?.visit ?? null);
      const patient = pickOne(visit?.patient ?? null);
      const appt = pickOne(visit?.appointment ?? null);
      const walkIn = pickOne(visit?.walk_in ?? null);
      return {
        count_id,
        payment_id: r.id,
        amount_pence: r.amount_pence,
        taken_at: r.succeeded_at,
        patient_name_snapshot: composePersonName(patient),
        cart_total_pence_snapshot: cart?.total_pence ?? null,
        appointment_ref_snapshot: appt?.appointment_ref ?? walkIn?.appointment_ref ?? null,
      };
    });
    const { error: linesErr } = await supabase.from('lng_cash_count_lines').insert(lineRows);
    if (linesErr) {
      throw new Error(`Lines insert failed (count ${count_id}): ${linesErr.message}`);
    }
  }

  // Snapshot the withdrawals that count against this period. Same
  // pattern as the payment lines above — denormalise reason / note /
  // taken_by name so the statement reads accurately later.
  if (withdrawalSnapshotRows.length > 0) {
    const withdrawalRows = withdrawalSnapshotRows.map((w) => {
      const actor = pickOne(w.taken_by_account ?? null);
      return {
        count_id,
        withdrawal_id: w.id,
        amount_pence: w.amount_pence,
        reason_snapshot: w.reason,
        note_snapshot: w.note,
        taken_at: w.taken_at,
        taken_by_name_snapshot: composePersonName(actor),
      };
    });
    const { error: wLinesErr } = await supabase
      .from('lng_cash_count_withdrawal_lines')
      .insert(withdrawalRows);
    if (wLinesErr) {
      throw new Error(`Withdrawal lines insert failed (count ${count_id}): ${wLinesErr.message}`);
    }
  }
  return { count_id, expected_pence, lines_count: keptPayments.length, kind };
}

// ── Record a cash withdrawal ───────────────────────────────────────────────
//
// Inserts a row into lng_cash_withdrawals (audit + running-balance
// driver). Also fires the manager-notification email best-effort —
// failure to deliver MUST NOT undo the audit row, so it's caught and
// surfaced to lng_system_failures, not bubbled up.
//
// Callers (Take-from-safe sheet) await this and refresh
// useCashPosition so the Right-now card reflects the new balance.

export interface RecordCashWithdrawalInput {
  location_id: string;
  amount_pence: number;
  reason: WithdrawalReason;
  note?: string | null;
}

export interface RecordCashWithdrawalResult {
  withdrawal_id: string;
}

export async function recordCashWithdrawal(
  input: RecordCashWithdrawalInput,
): Promise<RecordCashWithdrawalResult> {
  if (!Number.isFinite(input.amount_pence) || input.amount_pence <= 0) {
    throw new Error('Amount must be greater than zero.');
  }
  if (!WITHDRAWAL_REASONS.find((r) => r.value === input.reason)) {
    throw new Error(`Unknown withdrawal reason: ${input.reason}`);
  }
  const { data: meId } = await supabase.rpc('auth_account_id');
  const takenBy = (meId as string | null) ?? null;
  if (!takenBy) throw new Error('Could not resolve current account.');
  const trimmedNote = input.note?.trim();
  const { data: inserted, error } = await supabase
    .from('lng_cash_withdrawals')
    .insert({
      location_id: input.location_id,
      amount_pence: input.amount_pence,
      reason: input.reason,
      note: trimmedNote && trimmedNote.length > 0 ? trimmedNote : null,
      taken_by: takenBy,
    })
    .select('id')
    .single();
  if (error || !inserted) {
    throw new Error(`Could not record withdrawal: ${error?.message ?? 'no row returned'}`);
  }
  return { withdrawal_id: (inserted as { id: string }).id };
}

export async function updateCashCountActual(
  countId: string,
  actualPence: number,
  notes: string | null,
): Promise<void> {
  if (!Number.isFinite(actualPence) || actualPence < 0) {
    throw new Error('Actual amount must be a non-negative integer (pence).');
  }
  const trimmedNotes = notes?.trim() ?? null;
  const { error } = await supabase
    .from('lng_cash_counts')
    .update({ actual_pence: actualPence, notes: trimmedNotes && trimmedNotes.length > 0 ? trimmedNotes : null })
    .eq('id', countId)
    .eq('status', 'pending');
  if (error) throw new Error(`Could not update count: ${error.message}`);
}

export async function signCashCount(input: {
  count_id: string;
  signer_account_id: string;
}): Promise<void> {
  if (!input.signer_account_id) {
    throw new Error('Pick the manager signing off this count.');
  }

  // Sanity: the row must exist.
  const { data: row, error: readErr } = await supabase
    .from('lng_cash_counts')
    .select('id, status, counted_by, actual_pence')
    .eq('id', input.count_id)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!row) throw new Error('Count not found.');
  const c = row as { id: string; status: string; counted_by: string; actual_pence: number | null };
  if (c.status !== 'pending') {
    throw new Error(`Count is ${c.status}; only pending counts can be signed.`);
  }
  if (c.actual_pence === null) {
    throw new Error('Enter the actual amount in the safe before signing.');
  }

  const { error: updErr } = await supabase
    .from('lng_cash_counts')
    .update({
      status: 'signed',
      signed_off_by: input.signer_account_id,
      signed_off_at: new Date().toISOString(),
    })
    .eq('id', input.count_id)
    .eq('status', 'pending');
  if (updErr) throw new Error(`Sign failed: ${updErr.message}`);
}

// ── Per-count statement read ───────────────────────────────────────────────

export interface CashCountStatementLine {
  payment_id: string;
  amount_pence: number;
  taken_at: string;
  patient_name: string;
  appointment_ref: string | null;
}

export interface CashCountStatementWithdrawal {
  withdrawal_id: string;
  amount_pence: number;
  taken_at: string;
  reason: WithdrawalReason;
  note: string | null;
  taken_by_name: string | null;
}

export interface CashCountStatement {
  count: CashCountRow;
  lines: CashCountStatementLine[];
  withdrawals: CashCountStatementWithdrawal[];
}

interface RawStatementCount extends RawCashCount {}

interface StatementResult {
  data: CashCountStatement | null;
  loading: boolean;
  error: string | null;
}

export function useCashCountStatement(countId: string | null): StatementResult {
  const [data, setData] = useState<CashCountStatement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!countId) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [countRes, linesRes, withdrawalLinesRes] = await Promise.all([
          supabase
            .from('lng_cash_counts')
            .select(
              `id, period_start, period_end, expected_pence, actual_pence, variance_pence,
               status, notes, counted_at, signed_off_at,
               counted_by:accounts!counted_by ( first_name, last_name, name ),
               signed_off_by:accounts!signed_off_by ( first_name, last_name, name )`,
            )
            .eq('id', countId)
            .maybeSingle(),
          supabase
            .from('lng_cash_count_lines')
            .select('payment_id, amount_pence, taken_at, patient_name_snapshot, appointment_ref_snapshot')
            .eq('count_id', countId)
            .order('taken_at', { ascending: true }),
          supabase
            .from('lng_cash_count_withdrawal_lines')
            .select('withdrawal_id, amount_pence, taken_at, reason_snapshot, note_snapshot, taken_by_name_snapshot')
            .eq('count_id', countId)
            .order('taken_at', { ascending: true }),
        ]);
        if (cancelled) return;
        if (countRes.error) throw new Error(countRes.error.message);
        if (linesRes.error) throw new Error(linesRes.error.message);
        if (withdrawalLinesRes.error) throw new Error(withdrawalLinesRes.error.message);
        if (!countRes.data) throw new Error('Count not found');
        const [shaped] = shapeCashCounts([countRes.data as RawStatementCount]);
        if (!shaped) throw new Error('Count not found');
        const lines: CashCountStatementLine[] = ((linesRes.data ?? []) as Array<{
          payment_id: string;
          amount_pence: number;
          taken_at: string;
          patient_name_snapshot: string | null;
          appointment_ref_snapshot: string | null;
        }>).map((l) => ({
          payment_id: l.payment_id,
          amount_pence: l.amount_pence,
          taken_at: l.taken_at,
          patient_name: l.patient_name_snapshot ?? '—',
          appointment_ref: l.appointment_ref_snapshot,
        }));
        const withdrawals: CashCountStatementWithdrawal[] = ((withdrawalLinesRes.data ?? []) as Array<{
          withdrawal_id: string;
          amount_pence: number;
          taken_at: string;
          reason_snapshot: string;
          note_snapshot: string | null;
          taken_by_name_snapshot: string | null;
        }>).map((w) => ({
          withdrawal_id: w.withdrawal_id,
          amount_pence: w.amount_pence,
          taken_at: w.taken_at,
          reason: w.reason_snapshot as WithdrawalReason,
          note: w.note_snapshot,
          taken_by_name: w.taken_by_name_snapshot,
        }));
        if (cancelled) return;
        setData({ count: shaped, lines, withdrawals });
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load count statement';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'cash.statement',
          severity: 'error',
          message,
          context: { countId },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [countId]);

  return { data, loading, error };
}
