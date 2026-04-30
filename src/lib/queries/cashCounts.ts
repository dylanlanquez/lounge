import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { type DateRange, dateRangeToUtcBounds } from '../dateRange.ts';
import { logFailure } from '../failureLog.ts';

// Cash reconciliation reads — past counts list, per-count statement,
// and the live "what should be in the safe right now" computation.
// Write flow lives in PR9.

function pickOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value as T;
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
      notes: r.notes,
      counted_by_name: composePersonName(pickOne(r.counted_by)),
      counted_at: r.counted_at,
      signed_off_by_name: r.signed_off_by ? composePersonName(pickOne(r.signed_off_by)) : null,
      signed_off_at: r.signed_off_at,
    }))
    .sort((a, b) => b.period_end.localeCompare(a.period_end));
}

function composePersonName(
  p: { first_name: string | null; last_name: string | null; name: string | null } | null,
): string {
  if (!p) return '—';
  const fn = p.first_name?.trim();
  const ln = p.last_name?.trim();
  if (fn && ln) return `${fn} ${ln}`;
  return fn ?? ln ?? p.name?.trim() ?? '—';
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
             status, notes, counted_at, signed_off_at,
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
//   (sum of cash payments since the last signed count's period_end)
//   minus (any cash refunds in that same window — but cash refunds
//   happen out-of-band so we treat status='cancelled' on cash
//   payments as zero contribution)
//
// In practice: every cash payment with status='succeeded' AND
// succeeded_at > lastSignedCount.period_end. If no signed count
// exists yet, use the earliest cash payment as the start.

export interface CashPositionLine {
  payment_id: string;
  amount_pence: number;
  taken_at: string;
  patient_name: string;
  appointment_ref: string | null;
}

export interface CashPosition {
  expected_in_safe_pence: number;
  payment_count: number;
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

interface RawCashPosition {
  id: string;
  amount_pence: number;
  succeeded_at: string;
  cart:
    | {
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

        const paymentsRes = await supabase
          .from('lng_payments')
          .select(
            `id, amount_pence, succeeded_at,
             cart:lng_carts (
               visit:lng_visits (
                 patient:patients ( first_name, last_name, name ),
                 appointment:lng_appointments ( appointment_ref ),
                 walk_in:lng_walk_ins ( appointment_ref )
               )
             )`,
          )
          .eq('method', 'cash')
          .eq('status', 'succeeded')
          .gt('succeeded_at', sinceIso)
          .order('succeeded_at', { ascending: false });
        if (cancelled) return;
        if (paymentsRes.error) throw new Error(`cash_payments: ${paymentsRes.error.message}`);

        const raw = (paymentsRes.data ?? []) as RawCashPosition[];
        let total = 0;
        let earliest: string | null = null;
        let latest: string | null = null;
        const lines: CashPositionLine[] = raw.map((r) => {
          total += r.amount_pence;
          if (!earliest || r.succeeded_at < earliest) earliest = r.succeeded_at;
          if (!latest || r.succeeded_at > latest) latest = r.succeeded_at;
          const cart = pickOne(r.cart);
          const visit = pickOne(cart?.visit ?? null);
          const patient = pickOne(visit?.patient ?? null);
          const appt = pickOne(visit?.appointment ?? null);
          const walkIn = pickOne(visit?.walk_in ?? null);
          return {
            payment_id: r.id,
            amount_pence: r.amount_pence,
            taken_at: r.succeeded_at,
            patient_name: composePersonName(patient),
            appointment_ref: appt?.appointment_ref ?? walkIn?.appointment_ref ?? null,
          };
        });

        if (cancelled) return;
        setData({
          expected_in_safe_pence: total,
          payment_count: lines.length,
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

import { approveAsManager } from './payments.ts';

export interface CreateCashCountInput {
  location_id: string;
  period_start: string; // ISO timestamptz
  period_end: string;   // ISO timestamptz
}

export async function createCashCount(input: CreateCashCountInput): Promise<{ count_id: string; expected_pence: number; lines_count: number }> {
  if (input.period_end <= input.period_start) {
    throw new Error('Period end must be after period start.');
  }
  const { data: meId } = await supabase.rpc('auth_account_id');
  const counterId = (meId as string | null) ?? null;
  if (!counterId) throw new Error('Could not resolve current account.');

  // Snapshot the cash payments that fall in this period. We do this
  // BEFORE inserting the count row so we know expected_pence up front.
  // Once the count is signed the lines are immutable; even if
  // payments are voided afterwards, the count's record stays exact.
  const paymentsRes = await supabase
    .from('lng_payments')
    .select(
      `id, amount_pence, succeeded_at,
       cart:lng_carts (
         total_pence,
         visit:lng_visits (
           patient:patients ( first_name, last_name, name ),
           appointment:lng_appointments ( appointment_ref ),
           walk_in:lng_walk_ins ( appointment_ref )
         )
       )`,
    )
    .eq('method', 'cash')
    .eq('status', 'succeeded')
    .gte('succeeded_at', input.period_start)
    .lte('succeeded_at', input.period_end);
  if (paymentsRes.error) throw new Error(paymentsRes.error.message);

  interface RawSnapshot {
    id: string;
    amount_pence: number;
    succeeded_at: string;
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
  const expected_pence = raw.reduce((s, r) => s + r.amount_pence, 0);

  // Insert the count row. lines come next.
  const { data: insertedCount, error: countErr } = await supabase
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
  if (countErr) throw new Error(`Could not create count: ${countErr.message}`);
  const count_id = (insertedCount as { id: string }).id;

  if (raw.length > 0) {
    const lineRows = raw.map((r) => {
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
  return { count_id, expected_pence, lines_count: raw.length };
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
  signer_email: string;
  signer_password: string;
}): Promise<void> {
  if (!input.signer_email || !input.signer_password) {
    throw new Error('Signer email and password are required.');
  }
  // Manager re-auths via parallel client (doesn't disturb the
  // counter's session). approveAsManager throws on bad credentials.
  const verifiedAccountId = await approveAsManager(input.signer_email, input.signer_password);

  // Sanity: the row must exist and the signer can't be the counter.
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
  if (c.counted_by === verifiedAccountId) {
    throw new Error('Signer must be a different staff member than the counter.');
  }

  const { error: updErr } = await supabase
    .from('lng_cash_counts')
    .update({
      status: 'signed',
      signed_off_by: verifiedAccountId,
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

export interface CashCountStatement {
  count: CashCountRow;
  lines: CashCountStatementLine[];
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
        const [countRes, linesRes] = await Promise.all([
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
        ]);
        if (cancelled) return;
        if (countRes.error) throw new Error(countRes.error.message);
        if (linesRes.error) throw new Error(linesRes.error.message);
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
        if (cancelled) return;
        setData({ count: shaped, lines });
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
