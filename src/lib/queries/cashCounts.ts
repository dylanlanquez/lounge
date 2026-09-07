import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { type DateRange, dateRangeToUtcBounds } from '../dateRange.ts';
import { logFailure } from '../failureLog.ts';
import { useRealtimeRefresh } from '../useRealtimeRefresh.ts';
import { properCase } from './appointments.ts';

// Re-sync a cash read whenever the tab becomes visible again. Kiosks
// and tablets stay on one page all day; without this a device that
// loaded the safe balance this morning keeps showing that morning's
// number while the DB (the one source of truth for the one safe) has
// moved on. Pairs with useRealtimeRefresh: realtime pushes live events
// while the socket is up, this reconciles whatever was missed while the
// tablet slept or the socket was down.
function useRefreshOnVisible(refresh: () => void): void {
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, [refresh]);
}

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
  /** Two-person rule (migration 20260907000003): the safe witness who
   *  was present and whether it was done on camera. Null on counts
   *  that predate the rule. */
  witness_name: string | null;
  on_camera: boolean | null;
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
  witness?:
    | { first_name: string | null; last_name: string | null; name: string | null }
    | { first_name: string | null; last_name: string | null; name: string | null }[]
    | null;
  on_camera?: boolean | null;
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
      witness_name: r.witness ? composePersonName(pickOne(r.witness)) : null,
      on_camera: r.on_camera ?? null,
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
             status, kind, notes, counted_at, signed_off_at, on_camera,
             counted_by:accounts!counted_by ( first_name, last_name, name ),
             signed_off_by:accounts!signed_off_by ( first_name, last_name, name ),
             witness:accounts!witness_id ( first_name, last_name, name )`,
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

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  // The history list moves whenever a count is created or signed off.
  // Push those in live and reconcile on visibility so every device
  // shows the same list of counts.
  useRealtimeRefresh([{ table: 'lng_cash_counts' }], refresh);
  useRefreshOnVisible(refresh);

  return { data, loading, error, refresh };
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
// The maths lives in ONE place: the lng_cash_safe_position() database
// function (migrations 20260708000003 + 20260907000002). It is
// SECURITY DEFINER with a single authorization check, so every device
// and every permitted account gets the identical figure regardless of
// its per-table RLS grants. This module only reshapes the payload for
// display; it never adds numbers up.

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
  /** Staff member who took the cash. First question anyone asks when
   *  a count is short or over. */
  taken_by_name: string;
  cart_total_pence: number | null;
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
  /** Safe witness recorded on the withdrawal; null before the
   *  two-person rule. */
  witness_name: string | null;
  on_camera: boolean | null;
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
  taken_by_name: string;
}

export type CashPositionLine =
  | CashPositionPaymentLine
  | CashPositionWithdrawalLine
  | CashPositionRefundLine
  | CashPositionRefundedSaleLine;

/** A non-cash payment taken in the same window. Evidence for the
 *  "paid in cash but logged as card" explanation of a surplus. */
export interface CashClueOtherPayment {
  payment_id: string;
  method: string;
  amount_pence: number;
  taken_at: string;
  patient_name: string;
  appointment_ref: string | null;
  visit_id: string | null;
  taken_by_name: string;
}

/** A visit opened in the window that still owes money. Evidence for
 *  the "cash was taken but never logged" explanation of a surplus. */
export interface CashClueOpenBalance {
  visit_id: string;
  opened_at: string;
  owed_pence: number;
  patient_name: string;
  appointment_ref: string | null;
}

export interface CashClues {
  other_payments: CashClueOtherPayment[];
  open_balances: CashClueOpenBalance[];
}

export interface CashPositionAnchor {
  id: string;
  period_end: string;
  actual_pence: number | null;
  expected_pence: number;
  variance_pence: number;
  signed_off_at: string;
  witness_name?: string | null;
}

export interface CashPosition {
  /** Running balance = baseline + payments − refunds − withdrawals.
   *  An absolute figure, not a delta. */
  expected_in_safe_pence: number;
  /** Opening balance carried forward from the last signed count's
   *  actual_pence (or 0 when there has never been a signed count). */
  baseline_pence: number;
  /** Window the figure covers: (period_start, period_end]. */
  period_start: string;
  period_end: string;
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
  last_signed_count: CashPositionAnchor | null;
  lines: CashPositionLine[];
  /** Present when the position was fetched with clues (the /cash-counts
   *  page always asks for them so the count sheet can investigate a
   *  difference without a second round trip). */
  clues: CashClues | null;
}

// Shape returned by the lng_cash_safe_position() RPC. The server owns
// the money maths and which rows count; the client only formats names
// for display. Names arrive as raw first/last (+ account `name` fallback
// for staff) so the Title-casing stays in composePersonName rather than
// being duplicated in SQL.
interface RpcPersonParts {
  patient_first?: string | null;
  patient_last?: string | null;
  actor_first?: string | null;
  actor_last?: string | null;
  actor_name?: string | null;
  witness_first?: string | null;
  witness_last?: string | null;
  witness_name?: string | null;
}

interface RpcCashPositionLine extends RpcPersonParts {
  kind: 'payment' | 'refunded_sale' | 'refund' | 'withdrawal';
  payment_id?: string;
  refund_id?: string;
  withdrawal_id?: string;
  amount_pence: number;
  taken_at: string;
  appointment_ref?: string | null;
  visit_id?: string | null;
  cart_total_pence?: number | null;
  reason?: WithdrawalReason;
  note?: string | null;
  on_camera?: boolean | null;
}

interface RpcOtherPayment extends RpcPersonParts {
  payment_id: string;
  method: string;
  amount_pence: number;
  taken_at: string;
  appointment_ref?: string | null;
  visit_id?: string | null;
}

interface RpcOpenBalance extends RpcPersonParts {
  visit_id: string;
  opened_at: string;
  owed_pence: number;
  appointment_ref?: string | null;
}

export interface RpcCashPosition {
  expected_in_safe_pence: number;
  baseline_pence: number;
  location_id: string;
  period_start: string;
  period_end: string;
  payment_count: number;
  withdrawal_count: number;
  refund_count: number;
  refunded_sale_count: number;
  earliest_payment_at: string | null;
  latest_payment_at: string | null;
  last_signed_count: (CashPositionAnchor & RpcPersonParts) | null;
  lines: RpcCashPositionLine[];
  clues?: {
    other_payments: RpcOtherPayment[];
    open_balances: RpcOpenBalance[];
  } | null;
}

function patientName(p: RpcPersonParts): string {
  return composePersonName({ first_name: p.patient_first ?? null, last_name: p.patient_last ?? null });
}

function actorName(p: RpcPersonParts): string {
  return composePersonName({
    first_name: p.actor_first ?? null,
    last_name: p.actor_last ?? null,
    name: p.actor_name ?? null,
  });
}

function witnessName(p: RpcPersonParts): string | null {
  if (!p.witness_first && !p.witness_last && !p.witness_name) return null;
  return composePersonName({
    first_name: p.witness_first ?? null,
    last_name: p.witness_last ?? null,
    name: p.witness_name ?? null,
  });
}

// Map the authoritative RPC payload onto the CashPosition shape the UI
// consumes. Pure presentation: no figures are recomputed. Exported for
// tests.
export function shapeCashPosition(payload: RpcCashPosition | null): CashPosition {
  if (!payload) throw new Error('cash_position: empty response from lng_cash_safe_position');
  const lines: CashPositionLine[] = (payload.lines ?? []).map((l): CashPositionLine => {
    switch (l.kind) {
      case 'payment':
        if (!l.payment_id) throw new Error('cash_position: payment line without payment_id');
        return {
          kind: 'payment',
          payment_id: l.payment_id,
          amount_pence: l.amount_pence,
          taken_at: l.taken_at,
          patient_name: patientName(l),
          appointment_ref: l.appointment_ref ?? null,
          visit_id: l.visit_id ?? null,
          taken_by_name: actorName(l),
          cart_total_pence: l.cart_total_pence ?? null,
        };
      case 'refunded_sale':
        if (!l.payment_id) throw new Error('cash_position: refunded_sale line without payment_id');
        return {
          kind: 'refunded_sale',
          payment_id: l.payment_id,
          amount_pence: l.amount_pence,
          taken_at: l.taken_at,
          patient_name: patientName(l),
          visit_id: l.visit_id ?? null,
          taken_by_name: actorName(l),
        };
      case 'refund':
        if (!l.refund_id) throw new Error('cash_position: refund line without refund_id');
        return {
          kind: 'refund',
          refund_id: l.refund_id,
          amount_pence: l.amount_pence,
          taken_at: l.taken_at,
          // Null when the refund traces to a sale outside this window
          // (no patient parts returned).
          patient_name: l.patient_first || l.patient_last ? patientName(l) : null,
        };
      case 'withdrawal':
        if (!l.withdrawal_id || !l.reason) {
          throw new Error('cash_position: withdrawal line missing id or reason');
        }
        return {
          kind: 'withdrawal',
          withdrawal_id: l.withdrawal_id,
          amount_pence: l.amount_pence,
          taken_at: l.taken_at,
          reason: l.reason,
          note: l.note ?? null,
          taken_by_name: actorName(l),
          witness_name: witnessName(l),
          on_camera: l.on_camera ?? null,
        };
      default:
        throw new Error(`cash_position: unknown line kind ${(l as { kind: string }).kind}`);
    }
  });
  const clues: CashClues | null = payload.clues
    ? {
        other_payments: (payload.clues.other_payments ?? []).map((p) => ({
          payment_id: p.payment_id,
          method: p.method,
          amount_pence: p.amount_pence,
          taken_at: p.taken_at,
          patient_name: patientName(p),
          appointment_ref: p.appointment_ref ?? null,
          visit_id: p.visit_id ?? null,
          taken_by_name: actorName(p),
        })),
        open_balances: (payload.clues.open_balances ?? []).map((b) => ({
          visit_id: b.visit_id,
          opened_at: b.opened_at,
          owed_pence: b.owed_pence,
          patient_name: patientName(b),
          appointment_ref: b.appointment_ref ?? null,
        })),
      }
    : null;
  return {
    expected_in_safe_pence: payload.expected_in_safe_pence,
    baseline_pence: payload.baseline_pence,
    period_start: payload.period_start,
    period_end: payload.period_end,
    payment_count: payload.payment_count,
    withdrawal_count: payload.withdrawal_count,
    refund_count: payload.refund_count,
    refunded_sale_count: payload.refunded_sale_count,
    earliest_payment_at: payload.earliest_payment_at,
    latest_payment_at: payload.latest_payment_at,
    last_signed_count: payload.last_signed_count
      ? {
          id: payload.last_signed_count.id,
          period_end: payload.last_signed_count.period_end,
          actual_pence: payload.last_signed_count.actual_pence,
          expected_pence: payload.last_signed_count.expected_pence,
          variance_pence: payload.last_signed_count.variance_pence,
          signed_off_at: payload.last_signed_count.signed_off_at,
          witness_name: witnessName(payload.last_signed_count),
        }
      : null,
    lines,
    clues,
  };
}

/** One call to the authoritative server function. `periodEnd` pins the
 *  window for a count snapshot; omitted means "right now". */
export async function fetchCashPosition(opts: {
  periodEnd?: string | null;
  includeClues?: boolean;
  locationId?: string | null;
} = {}): Promise<CashPosition> {
  const res = await supabase.rpc('lng_cash_safe_position', {
    p_location_id: opts.locationId ?? null,
    p_period_end: opts.periodEnd ?? null,
    p_include_clues: opts.includeClues ?? false,
  });
  if (res.error) throw new Error(`cash_position: ${res.error.message}`);
  return shapeCashPosition(res.data as RpcCashPosition | null);
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
        // Clues ride along so the count sheet can explain a difference
        // from the same snapshot the headline figure came from.
        const out = await fetchCashPosition({ includeClues: true });
        if (cancelled) return;
        setData(out);
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

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  // "What should be in the safe right now" is the single source of
  // truth for the one shared safe, so every open device has to converge
  // on it. Any insert to a table that moves the balance — a cash
  // payment, a refund, a withdrawal (bank deposit / float top-up), or a
  // new signed count that resets the baseline — pushes a live refresh;
  // visibility/focus reconciles a device that was asleep when the event
  // landed. Without this, a kiosk left open all day keeps rendering the
  // balance it computed at load time while the DB has already moved on,
  // which is exactly how two staff end up looking at different numbers.
  useRealtimeRefresh(
    [
      { table: 'lng_payments' },
      { table: 'lng_payment_refunds' },
      { table: 'lng_cash_withdrawals' },
      { table: 'lng_cash_counts' },
    ],
    refresh,
  );
  useRefreshOnVisible(refresh);

  return { data, loading, error, refresh };
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
// Four-step flow:
//   1. createCashCount — opens a pending count for a period, snapshots
//      every cash payment in that period as an immutable line row,
//      records expected_pence at snapshot time. The counter is the
//      caller. Returns the new count id.
//   2. saveCashCountDenominations — stores how the cash was physically
//      counted (how many of each note and coin). Optional only for the
//      "I already have a total" path; the DB refuses to sign a count
//      whose breakdown disagrees with the total.
//   3. updateCashCountActual — counter enters the physical amount
//      they observed in the safe. Variance is the generated column,
//      so we just write actual_pence + notes. Allowed only while the
//      count is pending.
//   4. signCashCount — a different manager signs. Status flips to
//      signed with both timestamps + accounts ids landed.
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
  /** Two-person rule: the safe witness who is physically present, and
   *  confirmation that the count is happening on camera. The database
   *  refuses the insert without both (migration 20260907000003). */
  witness_id: string;
  on_camera: boolean;
}

export async function createCashCount(input: CreateCashCountInput): Promise<{ count_id: string; expected_pence: number; lines_count: number; kind: 'regular' | 'legacy_baseline' }> {
  if (input.period_end <= input.period_start) {
    throw new Error('Period end must be after period start.');
  }
  if (!input.witness_id) throw new Error('Pick the safe witness who is present before counting.');
  if (input.on_camera !== true) throw new Error('Confirm the count is being done in front of the camera.');
  const { data: meId } = await supabase.rpc('auth_account_id');
  const counterId = (meId as string | null) ?? null;
  if (!counterId) throw new Error('Could not resolve current account.');
  if (input.witness_id === counterId) throw new Error('The safe witness must be a different person from the counter.');

  // Ask the ONE authoritative function for the figure as of period_end.
  // It anchors on the last signed count, nets fully-refunded sales,
  // subtracts real refunds and withdrawals, and returns the exact lines
  // that make up the number. We store what it tells us; we never add
  // the figures up a second time on the client.
  const position = await fetchCashPosition({ periodEnd: input.period_end, locationId: input.location_id });
  if (position.expected_in_safe_pence < 0) {
    // The DB check (expected_pence >= 0) would reject the insert. A
    // negative running balance means the recorded figures are
    // inconsistent (more taken out than ever went in) and the chain
    // needs a fresh baseline, not a clamped number.
    throw new Error(
      `The recorded balance is below zero (${position.expected_in_safe_pence} pence). Reset the chain with a legacy count before counting again.`,
    );
  }
  const expected_pence = position.expected_in_safe_pence;
  const keptPayments = position.lines.filter(
    (l): l is CashPositionPaymentLine => l.kind === 'payment',
  );
  const withdrawals = position.lines.filter(
    (l): l is CashPositionWithdrawalLine => l.kind === 'withdrawal',
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
      witness_id: input.witness_id,
      on_camera: true,
    })
    .select('id')
    .single();
  if (countErr) {
    throw new Error(`Could not create count: ${countErr.message}`);
  }
  const count_id = (insertedCount as { id: string }).id;

  if (keptPayments.length > 0) {
    // Snapshot only the sales that kept cash in the drawer, so the stored
    // per-payment breakdown reconciles to expected_pence. Fully-refunded
    // sales are intentionally omitted — they netted to nothing.
    const lineRows = keptPayments.map((r) => ({
      count_id,
      payment_id: r.payment_id,
      amount_pence: r.amount_pence,
      taken_at: r.taken_at,
      patient_name_snapshot: r.patient_name,
      cart_total_pence_snapshot: r.cart_total_pence,
      appointment_ref_snapshot: r.appointment_ref,
    }));
    const { error: linesErr } = await supabase.from('lng_cash_count_lines').insert(lineRows);
    if (linesErr) {
      throw new Error(`Lines insert failed (count ${count_id}): ${linesErr.message}`);
    }
  }

  // Snapshot the withdrawals that count against this period. Same
  // pattern as the payment lines above — denormalise reason / note /
  // taken_by name so the statement reads accurately later.
  if (withdrawals.length > 0) {
    const withdrawalRows = withdrawals.map((w) => ({
      count_id,
      withdrawal_id: w.withdrawal_id,
      amount_pence: w.amount_pence,
      reason_snapshot: w.reason,
      note_snapshot: w.note,
      taken_at: w.taken_at,
      taken_by_name_snapshot: w.taken_by_name,
    }));
    const { error: wLinesErr } = await supabase
      .from('lng_cash_count_withdrawal_lines')
      .insert(withdrawalRows);
    if (wLinesErr) {
      throw new Error(`Withdrawal lines insert failed (count ${count_id}): ${wLinesErr.message}`);
    }
  }
  return { count_id, expected_pence, lines_count: keptPayments.length, kind };
}

// ── Denomination breakdown ─────────────────────────────────────────────────
//
// UK circulating notes and coins, largest first. Mirrors the CHECK on
// lng_cash_count_denominations.denomination_pence (migration
// 20260907000001). Adding a denomination requires a migration AND an
// entry here.

export interface Denomination {
  pence: number;
  label: string;
  kind: 'note' | 'coin';
}

export const DENOMINATIONS: readonly Denomination[] = [
  { pence: 5000, label: '£50', kind: 'note' },
  { pence: 2000, label: '£20', kind: 'note' },
  { pence: 1000, label: '£10', kind: 'note' },
  { pence: 500, label: '£5', kind: 'note' },
  { pence: 200, label: '£2', kind: 'coin' },
  { pence: 100, label: '£1', kind: 'coin' },
  { pence: 50, label: '50p', kind: 'coin' },
  { pence: 20, label: '20p', kind: 'coin' },
  { pence: 10, label: '10p', kind: 'coin' },
  { pence: 5, label: '5p', kind: 'coin' },
  { pence: 2, label: '2p', kind: 'coin' },
  { pence: 1, label: '1p', kind: 'coin' },
];

/** quantity of each denomination, keyed by pence. Missing = 0. */
export type DenominationCounts = Record<number, number>;

export function denominationTotalPence(counts: DenominationCounts): number {
  let total = 0;
  for (const d of DENOMINATIONS) {
    const q = counts[d.pence] ?? 0;
    if (!Number.isInteger(q) || q < 0) {
      throw new Error(`Invalid quantity for ${d.label}: ${q}`);
    }
    total += d.pence * q;
  }
  return total;
}

export interface CashCountDenominationRow {
  denomination_pence: number;
  quantity: number;
}

/** Persist the breakdown against a pending count. Rows with quantity 0
 *  are skipped so the stored record is only what was actually there.
 *  Throws if the breakdown does not add up to `actualPence`; the DB
 *  trigger enforces the same rule at sign-off. */
export async function saveCashCountDenominations(
  countId: string,
  counts: DenominationCounts,
  actualPence: number,
): Promise<void> {
  const total = denominationTotalPence(counts);
  if (total !== actualPence) {
    throw new Error(
      `The note and coin breakdown adds up to ${total} pence but the counted total is ${actualPence} pence.`,
    );
  }
  const rows = DENOMINATIONS
    .filter((d) => (counts[d.pence] ?? 0) > 0)
    .map((d) => ({ count_id: countId, denomination_pence: d.pence, quantity: counts[d.pence] }));
  if (rows.length === 0) return;
  const { error } = await supabase.from('lng_cash_count_denominations').insert(rows);
  if (error) throw new Error(`Could not save the note and coin breakdown: ${error.message}`);
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
  /** Two-person rule: the safe witness present and the on-camera
   *  confirmation. Refused by the database without both. */
  witness_id: string;
  on_camera: boolean;
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
  if (!input.witness_id) throw new Error('Pick the safe witness who is present before taking cash.');
  if (input.on_camera !== true) throw new Error('Confirm this is being done in front of the camera.');
  const { data: meId } = await supabase.rpc('auth_account_id');
  const takenBy = (meId as string | null) ?? null;
  if (!takenBy) throw new Error('Could not resolve current account.');
  if (input.witness_id === takenBy) throw new Error('The safe witness must be a different person from the one taking the cash.');
  const trimmedNote = input.note?.trim();
  const { data: inserted, error } = await supabase
    .from('lng_cash_withdrawals')
    .insert({
      location_id: input.location_id,
      amount_pence: input.amount_pence,
      reason: input.reason,
      note: trimmedNote && trimmedNote.length > 0 ? trimmedNote : null,
      taken_by: takenBy,
      witness_id: input.witness_id,
      on_camera: true,
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
  /** How the cash was physically counted. Empty for counts made before
   *  the breakdown existed, or entered as a plain total. */
  denominations: CashCountDenominationRow[];
}

type RawStatementCount = RawCashCount;

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
        const [countRes, linesRes, withdrawalLinesRes, denominationsRes] = await Promise.all([
          supabase
            .from('lng_cash_counts')
            .select(
              `id, period_start, period_end, expected_pence, actual_pence, variance_pence,
               status, kind, notes, counted_at, signed_off_at, on_camera,
               counted_by:accounts!counted_by ( first_name, last_name, name ),
               signed_off_by:accounts!signed_off_by ( first_name, last_name, name ),
               witness:accounts!witness_id ( first_name, last_name, name )`,
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
          supabase
            .from('lng_cash_count_denominations')
            .select('denomination_pence, quantity')
            .eq('count_id', countId)
            .order('denomination_pence', { ascending: false }),
        ]);
        if (cancelled) return;
        if (countRes.error) throw new Error(countRes.error.message);
        if (linesRes.error) throw new Error(linesRes.error.message);
        if (withdrawalLinesRes.error) throw new Error(withdrawalLinesRes.error.message);
        if (denominationsRes.error) throw new Error(denominationsRes.error.message);
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
        const denominations = ((denominationsRes.data ?? []) as CashCountDenominationRow[]).map((d) => ({
          denomination_pence: d.denomination_pence,
          quantity: d.quantity,
        }));
        if (cancelled) return;
        setData({ count: shaped, lines, withdrawals, denominations });
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
