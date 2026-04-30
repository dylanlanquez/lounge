import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { type DateRange, dateRangeToUtcBounds } from '../dateRange.ts';
import { addDaysIso } from '../calendarMonth.ts';
import { logFailure } from '../failureLog.ts';

// Financials — money-side hooks. Mirrors the shape of lib/queries/
// reports.ts: pure aggregators + thin IO hooks, every error path
// loud (throws + logFailure to lng_system_failures).

function pickOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value as T;
}

// ── Overview ────────────────────────────────────────────────────────────────

export interface FinancialsOverviewPayment {
  id: string;
  amount_pence: number;
  method: string;
  status: string;
  succeeded_at: string | null;
  cancelled_at: string | null;
  taken_by: string | null;
}

export interface FinancialsOverviewData {
  total_revenue_pence: number;
  payments_count: number;
  voided_count: number;
  voided_pence: number;
  failed_count: number;
  // Daily revenue series for the line chart. Inclusive of every day
  // in range, zero-padded.
  daily: { date: string; pence: number }[];
  // Method mix on succeeded payments only.
  method_mix: { method: string; pence: number; count: number }[];
}

export function aggregateFinancialsOverview(
  range: DateRange,
  payments: FinancialsOverviewPayment[],
): FinancialsOverviewData {
  // Build the inclusive date list once for zero-padded daily totals.
  const dates: string[] = [];
  for (let d = range.start; d <= range.end; d = addDaysIso(d, 1)) dates.push(d);
  const dailyMap: Record<string, number> = {};
  for (const d of dates) dailyMap[d] = 0;

  let total_revenue_pence = 0;
  let payments_count = 0;
  let voided_count = 0;
  let voided_pence = 0;
  let failed_count = 0;
  const methodAgg = new Map<string, { pence: number; count: number }>();

  for (const p of payments) {
    if (p.status === 'succeeded' && p.succeeded_at) {
      total_revenue_pence += p.amount_pence;
      payments_count += 1;
      const date = p.succeeded_at.slice(0, 10);
      if (date in dailyMap) dailyMap[date] = (dailyMap[date] ?? 0) + p.amount_pence;
      const prior = methodAgg.get(p.method);
      if (prior) {
        prior.pence += p.amount_pence;
        prior.count += 1;
      } else {
        methodAgg.set(p.method, { pence: p.amount_pence, count: 1 });
      }
    } else if (p.status === 'cancelled') {
      voided_count += 1;
      voided_pence += p.amount_pence;
    } else if (p.status === 'failed') {
      failed_count += 1;
    }
  }

  return {
    total_revenue_pence,
    payments_count,
    voided_count,
    voided_pence,
    failed_count,
    daily: dates.map((d) => ({ date: d, pence: dailyMap[d] ?? 0 })),
    method_mix: Array.from(methodAgg.entries())
      .map(([method, agg]) => ({ method, pence: agg.pence, count: agg.count }))
      .sort((a, b) => b.pence - a.pence),
  };
}

interface OverviewResult {
  data: FinancialsOverviewData | null;
  loading: boolean;
  error: string | null;
}

export function useFinancialsOverview(range: DateRange): OverviewResult {
  const [data, setData] = useState<FinancialsOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { fromIso, toIso } = dateRangeToUtcBounds(range);
    (async () => {
      try {
        // Cover both filter axes with one query: succeeded payments
        // are date-filtered on succeeded_at; cancelled/failed live
        // on created_at. Pull both windows then aggregate.
        const [succeededRes, cancelledRes, failedRes] = await Promise.all([
          supabase
            .from('lng_payments')
            .select('id, amount_pence, method, status, succeeded_at, cancelled_at, taken_by')
            .eq('status', 'succeeded')
            .gte('succeeded_at', fromIso)
            .lte('succeeded_at', toIso),
          supabase
            .from('lng_payments')
            .select('id, amount_pence, method, status, succeeded_at, cancelled_at, taken_by')
            .eq('status', 'cancelled')
            .gte('cancelled_at', fromIso)
            .lte('cancelled_at', toIso),
          supabase
            .from('lng_payments')
            .select('id, amount_pence, method, status, succeeded_at, cancelled_at, taken_by')
            .eq('status', 'failed')
            .gte('created_at', fromIso)
            .lte('created_at', toIso),
        ]);
        if (cancelled) return;
        if (succeededRes.error) throw new Error(`succeeded: ${succeededRes.error.message}`);
        if (cancelledRes.error) throw new Error(`cancelled: ${cancelledRes.error.message}`);
        if (failedRes.error) throw new Error(`failed: ${failedRes.error.message}`);
        const payments = [
          ...((succeededRes.data ?? []) as FinancialsOverviewPayment[]),
          ...((cancelledRes.data ?? []) as FinancialsOverviewPayment[]),
          ...((failedRes.data ?? []) as FinancialsOverviewPayment[]),
        ];
        const out = aggregateFinancialsOverview(range, payments);
        if (cancelled) return;
        setData(out);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load financials overview';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'financials.overview',
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

// ── Sales log ────────────────────────────────────────────────────────────────

export interface SalesRow {
  visit_id: string;
  visit_date: string;
  patient_name: string;
  appointment_ref: string | null;
  arrival_type: 'walk_in' | 'scheduled';
  items_summary: string;
  subtotal_pence: number;
  discount_pence: number;
  total_pence: number;
  cart_status: string;
  // Methods used to pay this cart, joined with " + " (e.g. "cash + card"
  // for split payments). Empty string when no succeeded payments.
  payment_methods: string;
  amount_paid_pence: number;
}

export interface SalesData {
  rows: SalesRow[];
  total_subtotal_pence: number;
  total_discount_pence: number;
  total_collected_pence: number;
}

interface RawSalesVisit {
  id: string;
  opened_at: string;
  arrival_type: 'walk_in' | 'scheduled';
  patient:
    | { first_name: string | null; last_name: string | null; name: string | null }
    | { first_name: string | null; last_name: string | null; name: string | null }[]
    | null;
  appointment:
    | { appointment_ref: string | null }
    | { appointment_ref: string | null }[]
    | null;
  walk_in:
    | { appointment_ref: string | null }
    | { appointment_ref: string | null }[]
    | null;
  cart:
    | {
        id: string;
        status: string;
        subtotal_pence: number | null;
        discount_pence: number | null;
        total_pence: number | null;
        items: { name: string; removed_at: string | null }[] | null;
        payments: { method: string; amount_pence: number; status: string }[] | null;
      }
    | {
        id: string;
        status: string;
        subtotal_pence: number | null;
        discount_pence: number | null;
        total_pence: number | null;
        items: { name: string; removed_at: string | null }[] | null;
        payments: { method: string; amount_pence: number; status: string }[] | null;
      }[]
    | null;
}

export interface SalesFilters {
  paymentMethod: string | null; // 'cash' | 'card_terminal' | 'gift_card' | 'account_credit' | null = any
  cartStatus: string | null; // 'paid' | 'open' | 'voided' | null = any
  arrivalType: 'walk_in' | 'scheduled' | null;
}

export function shapeSalesRows(visits: RawSalesVisit[], filters: SalesFilters): SalesData {
  const rows: SalesRow[] = [];
  for (const v of visits) {
    const cart = pickOne(v.cart);
    if (!cart) continue;
    if (filters.cartStatus && cart.status !== filters.cartStatus) continue;
    if (filters.arrivalType && v.arrival_type !== filters.arrivalType) continue;

    const patient = pickOne(v.patient);
    const appt = pickOne(v.appointment);
    const walkIn = pickOne(v.walk_in);
    const items = (cart.items ?? []).filter((i) => !i.removed_at);
    const payments = cart.payments ?? [];
    const succeeded = payments.filter((p) => p.status === 'succeeded');

    if (filters.paymentMethod) {
      const matched = succeeded.some((p) => p.method === filters.paymentMethod);
      if (!matched) continue;
    }

    const items_summary = items.length === 0
      ? '—'
      : items.length <= 2
        ? items.map((i) => i.name).join(' · ')
        : `${items.slice(0, 2).map((i) => i.name).join(' · ')} +${items.length - 2} more`;

    const fn = patient?.first_name?.trim();
    const ln = patient?.last_name?.trim();
    const display =
      fn && ln ? `${fn} ${ln}` : fn ?? ln ?? patient?.name?.trim() ?? 'Unknown patient';

    const methodSet = Array.from(new Set(succeeded.map((p) => humaniseMethod(p.method))));
    const payment_methods = methodSet.join(' + ');
    const amount_paid_pence = succeeded.reduce((s, p) => s + p.amount_pence, 0);

    rows.push({
      visit_id: v.id,
      visit_date: v.opened_at,
      patient_name: display,
      appointment_ref: appt?.appointment_ref ?? walkIn?.appointment_ref ?? null,
      arrival_type: v.arrival_type,
      items_summary,
      subtotal_pence: cart.subtotal_pence ?? 0,
      discount_pence: cart.discount_pence ?? 0,
      total_pence: cart.total_pence ?? 0,
      cart_status: cart.status,
      payment_methods,
      amount_paid_pence,
    });
  }
  rows.sort((a, b) => b.visit_date.localeCompare(a.visit_date));
  const total_subtotal_pence = rows.reduce((s, r) => s + r.subtotal_pence, 0);
  const total_discount_pence = rows.reduce((s, r) => s + r.discount_pence, 0);
  const total_collected_pence = rows.reduce((s, r) => s + r.amount_paid_pence, 0);
  return { rows, total_subtotal_pence, total_discount_pence, total_collected_pence };
}

// ── Discounts ───────────────────────────────────────────────────────────────

export interface DiscountRow {
  id: string;
  cart_id: string;
  visit_id: string | null;
  patient_name: string;
  amount_pence: number;
  reason: string;
  applied_at: string;
  removed_at: string | null;
  removed_reason: string | null;
  approver_name: string;
  applier_name: string;
}

interface RawDiscount {
  id: string;
  cart_id: string;
  amount_pence: number;
  reason: string;
  applied_at: string;
  removed_at: string | null;
  removed_reason: string | null;
  approver:
    | { first_name: string | null; last_name: string | null; name: string | null }
    | { first_name: string | null; last_name: string | null; name: string | null }[]
    | null;
  applier:
    | { first_name: string | null; last_name: string | null; name: string | null }
    | { first_name: string | null; last_name: string | null; name: string | null }[]
    | null;
  cart:
    | {
        visit:
          | {
              id: string;
              patient:
                | { first_name: string | null; last_name: string | null; name: string | null }
                | { first_name: string | null; last_name: string | null; name: string | null }[]
                | null;
            }
          | {
              id: string;
              patient:
                | { first_name: string | null; last_name: string | null; name: string | null }
                | { first_name: string | null; last_name: string | null; name: string | null }[]
                | null;
            }[]
          | null;
      }
    | {
        visit:
          | {
              id: string;
              patient:
                | { first_name: string | null; last_name: string | null; name: string | null }
                | { first_name: string | null; last_name: string | null; name: string | null }[]
                | null;
            }
          | {
              id: string;
              patient:
                | { first_name: string | null; last_name: string | null; name: string | null }
                | { first_name: string | null; last_name: string | null; name: string | null }[]
                | null;
            }[]
          | null;
      }[]
    | null;
}

export interface ApproverLeaderboardEntry {
  name: string;
  count: number;
  total_pence: number;
}

export interface DiscountsData {
  rows: DiscountRow[];
  total_amount_pence: number;
  active_count: number;
  removed_count: number;
  approver_leaderboard: ApproverLeaderboardEntry[];
}

export function shapeDiscounts(raw: RawDiscount[]): DiscountsData {
  const rows: DiscountRow[] = [];
  const approverAgg = new Map<string, ApproverLeaderboardEntry>();
  let total = 0;
  let active = 0;
  let removed = 0;

  for (const d of raw) {
    const cart = pickOne(d.cart);
    const visit = pickOne(cart?.visit ?? null);
    const patient = pickOne(visit?.patient ?? null);
    const approver = pickOne(d.approver);
    const applier = pickOne(d.applier);
    const approverName = composePersonName(approver);
    const applierName = composePersonName(applier);
    const patientName = composePersonName(patient);

    rows.push({
      id: d.id,
      cart_id: d.cart_id,
      visit_id: visit?.id ?? null,
      patient_name: patientName,
      amount_pence: d.amount_pence,
      reason: d.reason,
      applied_at: d.applied_at,
      removed_at: d.removed_at,
      removed_reason: d.removed_reason,
      approver_name: approverName,
      applier_name: applierName,
    });

    total += d.amount_pence;
    if (d.removed_at) removed += 1;
    else active += 1;

    const key = approverName;
    const prior = approverAgg.get(key);
    if (prior) {
      prior.count += 1;
      prior.total_pence += d.amount_pence;
    } else {
      approverAgg.set(key, { name: approverName, count: 1, total_pence: d.amount_pence });
    }
  }

  rows.sort((a, b) => b.applied_at.localeCompare(a.applied_at));
  const approver_leaderboard = Array.from(approverAgg.values()).sort(
    (a, b) => b.total_pence - a.total_pence,
  );

  return {
    rows,
    total_amount_pence: total,
    active_count: active,
    removed_count: removed,
    approver_leaderboard,
  };
}

interface DiscountsResult {
  data: DiscountsData | null;
  loading: boolean;
  error: string | null;
}

export function useFinancialsDiscounts(range: DateRange): DiscountsResult {
  const [data, setData] = useState<DiscountsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { fromIso, toIso } = dateRangeToUtcBounds(range);
    (async () => {
      try {
        const res = await supabase
          .from('lng_cart_discounts')
          .select(
            `id, cart_id, amount_pence, reason, applied_at, removed_at, removed_reason,
             approver:accounts!approved_by ( first_name, last_name, name ),
             applier:accounts!applied_by ( first_name, last_name, name ),
             cart:lng_carts (
               visit:lng_visits ( id, patient:patients ( first_name, last_name, name ) )
             )`,
          )
          .gte('applied_at', fromIso)
          .lte('applied_at', toIso);
        if (cancelled) return;
        if (res.error) throw new Error(`discounts: ${res.error.message}`);
        const out = shapeDiscounts((res.data ?? []) as RawDiscount[]);
        if (cancelled) return;
        setData(out);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load discounts';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'financials.discounts',
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

// ── Voids ───────────────────────────────────────────────────────────────────

export interface VoidRow {
  id: string;
  cart_id: string;
  visit_id: string | null;
  patient_name: string;
  amount_pence: number;
  method: string;
  reason: string;
  cancelled_at: string;
  // Time between succeeded_at and cancelled_at, in minutes. Null when
  // the payment never succeeded (cancelled before capture).
  minutes_to_void: number | null;
  taken_by_name: string;
}

interface RawVoid {
  id: string;
  cart_id: string;
  amount_pence: number;
  method: string;
  failure_reason: string | null;
  succeeded_at: string | null;
  cancelled_at: string;
  taken_by:
    | { first_name: string | null; last_name: string | null; name: string | null }
    | { first_name: string | null; last_name: string | null; name: string | null }[]
    | null;
  cart:
    | {
        visit:
          | { id: string; patient: { first_name: string | null; last_name: string | null; name: string | null } | { first_name: string | null; last_name: string | null; name: string | null }[] | null }
          | { id: string; patient: { first_name: string | null; last_name: string | null; name: string | null } | { first_name: string | null; last_name: string | null; name: string | null }[] | null }[]
          | null;
      }
    | {
        visit:
          | { id: string; patient: { first_name: string | null; last_name: string | null; name: string | null } | { first_name: string | null; last_name: string | null; name: string | null }[] | null }
          | { id: string; patient: { first_name: string | null; last_name: string | null; name: string | null } | { first_name: string | null; last_name: string | null; name: string | null }[] | null }[]
          | null;
      }[]
    | null;
}

export interface VoidsData {
  rows: VoidRow[];
  total_amount_pence: number;
  count: number;
  // Voids in <60 min — useful flag for sus-pattern surfacing.
  same_day_count: number;
}

export function shapeVoids(raw: RawVoid[], windowMinutes: number): VoidsData {
  const rows: VoidRow[] = [];
  let total = 0;
  let same_day_count = 0;
  for (const v of raw) {
    const cart = pickOne(v.cart);
    const visit = pickOne(cart?.visit ?? null);
    const patient = pickOne(visit?.patient ?? null);
    const taken = pickOne(v.taken_by);

    let minutes_to_void: number | null = null;
    if (v.succeeded_at) {
      const ms = new Date(v.cancelled_at).getTime() - new Date(v.succeeded_at).getTime();
      minutes_to_void = Math.max(0, Math.round(ms / 60000));
      if (minutes_to_void <= windowMinutes) same_day_count += 1;
    }

    rows.push({
      id: v.id,
      cart_id: v.cart_id,
      visit_id: visit?.id ?? null,
      patient_name: composePersonName(patient),
      amount_pence: v.amount_pence,
      method: v.method,
      reason: v.failure_reason ?? '—',
      cancelled_at: v.cancelled_at,
      minutes_to_void,
      taken_by_name: composePersonName(taken),
    });
    total += v.amount_pence;
  }
  rows.sort((a, b) => b.cancelled_at.localeCompare(a.cancelled_at));
  return { rows, total_amount_pence: total, count: rows.length, same_day_count };
}

interface VoidsResult {
  data: VoidsData | null;
  loading: boolean;
  error: string | null;
}

export function useFinancialsVoids(
  range: DateRange,
  windowMinutes: number = 60,
): VoidsResult {
  const [data, setData] = useState<VoidsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { fromIso, toIso } = dateRangeToUtcBounds(range);
    (async () => {
      try {
        const res = await supabase
          .from('lng_payments')
          .select(
            `id, cart_id, amount_pence, method, failure_reason, succeeded_at, cancelled_at,
             taken_by:accounts!taken_by ( first_name, last_name, name ),
             cart:lng_carts (
               visit:lng_visits ( id, patient:patients ( first_name, last_name, name ) )
             )`,
          )
          .eq('status', 'cancelled')
          .gte('cancelled_at', fromIso)
          .lte('cancelled_at', toIso);
        if (cancelled) return;
        if (res.error) throw new Error(`voids: ${res.error.message}`);
        const out = shapeVoids((res.data ?? []) as RawVoid[], windowMinutes);
        if (cancelled) return;
        setData(out);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load voids';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'financials.voids',
          severity: 'error',
          message,
          context: { range, windowMinutes },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range, windowMinutes]);

  return { data, loading, error };
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

function humaniseMethod(method: string): string {
  switch (method) {
    case 'cash':
      return 'Cash';
    case 'card_terminal':
      return 'Card';
    case 'gift_card':
      return 'Gift card';
    case 'account_credit':
      return 'Credit';
    default:
      return method;
  }
}

interface SalesResult {
  data: SalesData | null;
  loading: boolean;
  error: string | null;
}

export function useFinancialsSales(range: DateRange, filters: SalesFilters): SalesResult {
  const [data, setData] = useState<SalesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { fromIso, toIso } = dateRangeToUtcBounds(range);
    (async () => {
      try {
        const visitsRes = await supabase
          .from('lng_visits')
          .select(
            `id, opened_at, arrival_type,
             patient:patients ( first_name, last_name, name ),
             appointment:lng_appointments ( appointment_ref ),
             walk_in:lng_walk_ins ( appointment_ref ),
             cart:lng_carts (
               id, status, subtotal_pence, discount_pence, total_pence,
               items:lng_cart_items ( name, removed_at ),
               payments:lng_payments ( method, amount_pence, status )
             )`,
          )
          .gte('opened_at', fromIso)
          .lte('opened_at', toIso);
        if (cancelled) return;
        if (visitsRes.error) throw new Error(`sales: ${visitsRes.error.message}`);
        const visits = (visitsRes.data ?? []) as RawSalesVisit[];
        const out = shapeSalesRows(visits, filters);
        if (cancelled) return;
        setData(out);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load sales';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'financials.sales',
          severity: 'error',
          message,
          context: { range, filters },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range, filters.paymentMethod, filters.cartStatus, filters.arrivalType]);

  return { data, loading, error };
}
