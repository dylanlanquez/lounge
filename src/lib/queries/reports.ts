import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { type DateRange, dateRangeToUtcBounds } from '../dateRange.ts';
import { logFailure } from '../failureLog.ts';

// Reports — read-side hooks for the Reports section.
//
// Each hook in this module is keyed on a DateRange. The hook fans
// out one to four parallel queries and aggregates the results into a
// shape that the page can render directly. No PostgreSQL views; we
// keep the data layer plain SQL fetches so the joins stay obvious
// and a future analyst can read what's happening here without
// chasing through a chain of derived views.
//
// Failures are loud: anything unexpected throws into the
// per-hook error state AND lands a row in lng_system_failures via
// logFailure. Per the brief, never silently fall back.

// Raw shapes used by useReportsOverview. Exported so the pure
// aggregateOverview function can be unit-tested without spinning up
// a fake Supabase response — tests build the input arrays directly.

export interface ReportsOverviewVisit {
  id: string;
  patient_id: string;
  arrival_type: 'walk_in' | 'scheduled';
  opened_at: string;
  closed_at: string | null;
  status: string;
  cart:
    | {
        id: string;
        total_pence: number | null;
        subtotal_pence: number | null;
        discount_pence: number | null;
        status: string;
      }
    | {
        id: string;
        total_pence: number | null;
        subtotal_pence: number | null;
        discount_pence: number | null;
        status: string;
      }[]
    | null;
}

export interface ReportsOverviewPayment {
  id: string;
  amount_pence: number;
  method: string;
  payment_journey: string | null;
  succeeded_at: string | null;
}

export interface ReportsOverviewItem {
  id: string;
  name: string;
  catalogue_id: string | null;
  line_total_pence: number;
  quantity: number;
  cart:
    | {
        id: string;
        visit:
          | { id: string; opened_at: string }
          | { id: string; opened_at: string }[]
          | null;
      }
    | {
        id: string;
        visit:
          | { id: string; opened_at: string }
          | { id: string; opened_at: string }[]
          | null;
      }[]
    | null;
}

export interface TopService {
  catalogue_id: string | null;
  name: string;
  count: number;
  revenue_pence: number;
}

export interface ReportsOverview {
  // Visit-side
  total_visits: number;
  walk_ins: number;
  scheduled: number;
  unique_patients: number;
  // Status mix on visits in the period
  status_mix: Record<string, number>;
  // Payment-side
  revenue_pence: number;
  payments_count: number;
  payment_method_mix: Record<string, number>; // amount_pence by method
  // Average ticket = revenue / paid-cart count, in pence. Null when
  // no paid carts so the consumer can render '—' rather than NaN.
  average_ticket_pence: number | null;
  // Top 5 services by revenue across all carts in the period.
  top_services: TopService[];
  // Best day in period (most visits). Null when no visits.
  best_day: { date: string; visits: number } | null;
}

interface OverviewResult {
  data: ReportsOverview | null;
  loading: boolean;
  error: string | null;
}

// pickOne is duplicated here rather than imported because the
// import would pull in supabase too eagerly during testing — the
// helper is two lines anyway.
function pickOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value as T;
}

// Pure aggregation. Exported so the test suite can build raw inputs
// and verify the derived stats deterministically without hitting the
// network. The hook below calls this after IO.
export function aggregateOverview(
  visits: ReportsOverviewVisit[],
  payments: ReportsOverviewPayment[],
  items: ReportsOverviewItem[],
): ReportsOverview {
  // ── Visit-side aggregations ────────────────────────────────
  const total_visits = visits.length;
  let walk_ins = 0;
  let scheduled = 0;
  const patientIds = new Set<string>();
  const statusMix: Record<string, number> = {};
  const visitsByDate: Record<string, number> = {};
  for (const v of visits) {
    if (v.arrival_type === 'walk_in') walk_ins += 1;
    else scheduled += 1;
    patientIds.add(v.patient_id);
    statusMix[v.status] = (statusMix[v.status] ?? 0) + 1;
    const date = v.opened_at.slice(0, 10);
    visitsByDate[date] = (visitsByDate[date] ?? 0) + 1;
  }

  // ── Best day ───────────────────────────────────────────────
  let best_day: ReportsOverview['best_day'] = null;
  for (const [date, count] of Object.entries(visitsByDate)) {
    if (!best_day || count > best_day.visits) {
      best_day = { date, visits: count };
    }
  }

  // ── Payment-side aggregations ──────────────────────────────
  let revenue_pence = 0;
  const paymentMethodMix: Record<string, number> = {};
  for (const p of payments) {
    revenue_pence += p.amount_pence;
    paymentMethodMix[p.method] = (paymentMethodMix[p.method] ?? 0) + p.amount_pence;
  }

  // Paid-cart count: distinct cart_ids among the visits in range
  // whose cart.status = 'paid'. Uses the visits' joined cart so we
  // don't need a separate carts query.
  const paidCartIds = new Set<string>();
  for (const v of visits) {
    const cart = pickOne(v.cart);
    if (cart && cart.status === 'paid') paidCartIds.add(cart.id);
  }
  const average_ticket_pence =
    paidCartIds.size > 0 ? Math.round(revenue_pence / paidCartIds.size) : null;

  // ── Top services ───────────────────────────────────────────
  // Group by (catalogue_id, name). catalogue_id can be null for
  // ad-hoc lines; group those by name only so a typo'd ad-hoc
  // line doesn't merge with its catalogue cousin.
  const serviceAgg = new Map<string, TopService>();
  for (const it of items) {
    const cart = pickOne(it.cart);
    const visit = pickOne(cart?.visit ?? null);
    if (!visit) continue; // safety: range filter should have caught this
    const key = it.catalogue_id ?? `__ad_hoc__${it.name}`;
    const prior = serviceAgg.get(key);
    if (prior) {
      prior.count += it.quantity;
      prior.revenue_pence += it.line_total_pence;
    } else {
      serviceAgg.set(key, {
        catalogue_id: it.catalogue_id,
        name: it.name,
        count: it.quantity,
        revenue_pence: it.line_total_pence,
      });
    }
  }
  const top_services = Array.from(serviceAgg.values())
    .sort((a, b) => b.revenue_pence - a.revenue_pence)
    .slice(0, 5);

  return {
    total_visits,
    walk_ins,
    scheduled,
    unique_patients: patientIds.size,
    status_mix: statusMix,
    revenue_pence,
    payments_count: payments.length,
    payment_method_mix: paymentMethodMix,
    average_ticket_pence,
    top_services,
    best_day,
  };
}

export function useReportsOverview(range: DateRange): OverviewResult {
  const [data, setData] = useState<ReportsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { fromIso, toIso } = dateRangeToUtcBounds(range);

    (async () => {
      try {
        const [visitsRes, paymentsRes, itemsRes] = await Promise.all([
          supabase
            .from('lng_visits')
            .select(
              `id, patient_id, arrival_type, opened_at, closed_at, status,
               cart:lng_carts ( id, total_pence, subtotal_pence, discount_pence, status )`,
            )
            .gte('opened_at', fromIso)
            .lte('opened_at', toIso),
          supabase
            .from('lng_payments')
            .select('id, amount_pence, method, payment_journey, succeeded_at')
            .eq('status', 'succeeded')
            .gte('succeeded_at', fromIso)
            .lte('succeeded_at', toIso),
          supabase
            .from('lng_cart_items')
            .select(
              // !inner on cart and visit promotes the embedded joins to
              // INNER JOINs so the root-level filter on the visit's
              // opened_at actually limits which lng_cart_items come back.
              // Without !inner PostgREST would still return every item
              // and just null the embedded join when the visit was out
              // of range — wrong shape for "items whose visit landed in
              // this period".
              `id, name, catalogue_id, line_total_pence, quantity,
               cart:lng_carts!inner ( id, visit:lng_visits!inner ( id, opened_at ) )`,
            )
            .is('removed_at', null)
            .gte('cart.visit.opened_at', fromIso)
            .lte('cart.visit.opened_at', toIso),
        ]);

        if (cancelled) return;

        if (visitsRes.error) throw new Error(`visits: ${visitsRes.error.message}`);
        if (paymentsRes.error) throw new Error(`payments: ${paymentsRes.error.message}`);
        if (itemsRes.error) throw new Error(`items: ${itemsRes.error.message}`);

        const visits = (visitsRes.data ?? []) as ReportsOverviewVisit[];
        const payments = (paymentsRes.data ?? []) as ReportsOverviewPayment[];
        const items = (itemsRes.data ?? []) as ReportsOverviewItem[];
        const overview = aggregateOverview(visits, payments, items);
        if (cancelled) return;
        setData(overview);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load overview';
        setError(message);
        setLoading(false);
        // Loud failure so the operator sees it on the Failures tab,
        // not just in the page's inline error state.
        await logFailure({
          source: 'reports.overview',
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
