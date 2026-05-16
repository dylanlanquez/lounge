import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { type DateRange, dateRangeToUtcBounds } from '../dateRange.ts';
import { logFailure } from '../failureLog.ts';
import { properCase } from './appointments.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Cash drawer report queries (Reports → Cash drawer tab).
//
// Two surfaces:
//   • Since-last-count — anchored on a SPECIFIC location's most recent
//     signed cash count. Sums succeeded cash payments at that location
//     since the count's period_end. This is the read-only mirror of the
//     "Right now" card on /cash-counts, but for an arbitrary location
//     (rather than only the viewer's own).
//   • In-range — every cash payment whose succeeded_at OR cancelled_at
//     falls inside the report's DateRange, optionally narrowed to one
//     location. Includes voided rows so the reconciliation story holds
//     ("took £100, voided £40, net £60").
//
// These deliberately do NOT share the existing useCashPosition() — that
// hook anchors on the most recent signed count GLOBALLY, which is the
// right behaviour for the single-location /cash-counts page (RLS narrows
// it to the viewer's own location) but is wrong for a multi-location
// report where the chosen location should drive the anchor.
// ─────────────────────────────────────────────────────────────────────────────

function pickOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value as T;
}

function composePersonName(
  p:
    | { first_name: string | null; last_name: string | null; name?: string | null }
    | null,
): string {
  if (!p) return '—';
  const fn = properCase(p.first_name);
  const ln = properCase(p.last_name);
  if (fn && ln) return `${fn} ${ln}`;
  return fn || ln || properCase(p.name) || '—';
}

// ── Shared shapes ───────────────────────────────────────────────────────────

interface Person {
  first_name: string | null;
  last_name: string | null;
  // `name` only exists on the accounts table (used for the taken_by
  // join). The patients table only carries first_name + last_name, so
  // patient rows never include this field — keep it optional so the
  // composePersonName fallback chain compiles for both shapes.
  name?: string | null;
}

type OneOrMany<T> = T | T[] | null;

// Supabase returns related rows as either a single object (for to-one
// joins it can infer as such) or an array (for to-many or ambiguous
// joins). Every nested shape below has to allow both; pickOne unwraps.
interface RawVisit {
  location_id: string | null;
  patient: OneOrMany<Person>;
  appointment: OneOrMany<{ appointment_ref: string | null }>;
  walk_in: OneOrMany<{ appointment_ref: string | null }>;
}

interface RawCart {
  visit: OneOrMany<RawVisit>;
}

interface RawPayment {
  id: string;
  amount_pence: number;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  succeeded_at: string | null;
  cancelled_at: string | null;
  failure_reason: string | null;
  taken_by: OneOrMany<Person>;
  cart: OneOrMany<RawCart>;
}

export interface CashDrawerLine {
  payment_id: string;
  amount_pence: number;
  // Timestamp the line should sort by — succeeded_at when the row is a
  // good capture, cancelled_at when the row is a void. The eye reads a
  // unified "when did this happen" column regardless of status.
  occurred_at: string;
  status: RawPayment['status'];
  patient_name: string;
  appointment_ref: string | null;
  taken_by_name: string;
  void_reason: string | null;
}

// ── Since-last-count (per location) ─────────────────────────────────────────

export interface CashDrawerSinceLastCount {
  location_id: string;
  expected_in_safe_pence: number;
  payment_count: number;
  earliest_payment_at: string | null;
  latest_payment_at: string | null;
  last_signed_count: {
    id: string;
    period_end: string;
    actual_pence: number | null;
    signed_off_at: string;
  } | null;
  lines: CashDrawerLine[];
}

interface SinceLastCountResult {
  data: CashDrawerSinceLastCount | null;
  loading: boolean;
  error: string | null;
}

export function useCashDrawerSinceLastCount(
  locationId: string | null,
): SinceLastCountResult {
  const [data, setData] = useState<CashDrawerSinceLastCount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!locationId) {
      // The since-last-count card is meaningless across locations:
      // each location chains its own count timeline. Surface null
      // rather than picking a silent default.
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // 1. Anchor on the most recent signed count AT THIS LOCATION.
        const lastRes = await supabase
          .from('lng_cash_counts')
          .select('id, period_end, actual_pence, signed_off_at')
          .eq('location_id', locationId)
          .eq('status', 'signed')
          .order('period_end', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (cancelled) return;
        if (lastRes.error) throw new Error(`last_count: ${lastRes.error.message}`);
        const last = lastRes.data as
          | {
              id: string;
              period_end: string;
              actual_pence: number | null;
              signed_off_at: string;
            }
          | null;
        const sinceIso = last ? last.period_end : '1970-01-01T00:00:00Z';

        // 2. Cash payments at this location, since the anchor.
        // !inner forces the cart→visit join so the location filter
        // narrows the result set in SQL — without it Supabase returns
        // every payment and filters client-side, which is wrong.
        const paymentsRes = await supabase
          .from('lng_payments')
          .select(
            `id, amount_pence, status, succeeded_at, cancelled_at, failure_reason,
             taken_by:accounts!taken_by ( first_name, last_name, name ),
             cart:lng_carts!inner (
               visit:lng_visits!inner (
                 location_id,
                 patient:patients ( first_name, last_name ),
                 appointment:lng_appointments ( appointment_ref ),
                 walk_in:lng_walk_ins ( appointment_ref )
               )
             )`,
          )
          .eq('method', 'cash')
          .eq('status', 'succeeded')
          .gt('succeeded_at', sinceIso)
          .eq('cart.visit.location_id', locationId)
          .order('succeeded_at', { ascending: false });
        if (cancelled) return;
        if (paymentsRes.error)
          throw new Error(`cash_payments: ${paymentsRes.error.message}`);

        const raw = (paymentsRes.data ?? []) as RawPayment[];
        let total = 0;
        let earliest: string | null = null;
        let latest: string | null = null;
        const lines: CashDrawerLine[] = raw.map((r) => {
          total += r.amount_pence;
          const occurredAt = r.succeeded_at ?? r.cancelled_at ?? '';
          if (!earliest || occurredAt < earliest) earliest = occurredAt;
          if (!latest || occurredAt > latest) latest = occurredAt;
          return shapeLine(r);
        });

        if (cancelled) return;
        setData({
          location_id: locationId,
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
        const message =
          e instanceof Error ? e.message : 'Could not compute cash position';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'cash.drawer.since_last_count',
          severity: 'error',
          message,
          context: { locationId },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  return { data, loading, error };
}

// ── In-range (all cash sale records for a DateRange) ────────────────────────

export interface CashDrawerInRange {
  range_label: string;
  succeeded_pence: number;
  succeeded_count: number;
  voided_pence: number;
  voided_count: number;
  net_pence: number;
  lines: CashDrawerLine[];
}

interface InRangeResult {
  data: CashDrawerInRange | null;
  loading: boolean;
  error: string | null;
}

export function useCashPaymentsInRange(
  range: DateRange,
  locationId: string | null,
): InRangeResult {
  const [data, setData] = useState<CashDrawerInRange | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { fromIso, toIso } = dateRangeToUtcBounds(range);
    (async () => {
      try {
        const baseSelect = `id, amount_pence, status, succeeded_at, cancelled_at, failure_reason,
           taken_by:accounts!taken_by ( first_name, last_name, name ),
           cart:lng_carts!inner (
             visit:lng_visits!inner (
               location_id,
               patient:patients ( first_name, last_name ),
               appointment:lng_appointments ( appointment_ref ),
               walk_in:lng_walk_ins ( appointment_ref )
             )
           )`;

        // Two parallel reads:
        //   • succeeded captures inside the window (timestamp =
        //     succeeded_at)
        //   • voided payments cancelled inside the window (timestamp =
        //     cancelled_at). The original capture might have happened
        //     before fromIso — including those keeps the reconciliation
        //     story honest ("a refund landed today even though the
        //     original sale was last week").
        const succeededQuery = supabase
          .from('lng_payments')
          .select(baseSelect)
          .eq('method', 'cash')
          .eq('status', 'succeeded')
          .gte('succeeded_at', fromIso)
          .lte('succeeded_at', toIso);
        const voidedQuery = supabase
          .from('lng_payments')
          .select(baseSelect)
          .eq('method', 'cash')
          .eq('status', 'cancelled')
          .gte('cancelled_at', fromIso)
          .lte('cancelled_at', toIso);

        if (locationId) {
          succeededQuery.eq('cart.visit.location_id', locationId);
          voidedQuery.eq('cart.visit.location_id', locationId);
        }

        const [succRes, voidRes] = await Promise.all([
          succeededQuery,
          voidedQuery,
        ]);
        if (cancelled) return;
        if (succRes.error)
          throw new Error(`cash_succeeded: ${succRes.error.message}`);
        if (voidRes.error)
          throw new Error(`cash_voided: ${voidRes.error.message}`);

        const succLines = ((succRes.data ?? []) as RawPayment[]).map(shapeLine);
        const voidLines = ((voidRes.data ?? []) as RawPayment[]).map(shapeLine);

        const succeeded_pence = succLines.reduce(
          (s, l) => s + l.amount_pence,
          0,
        );
        const voided_pence = voidLines.reduce(
          (s, l) => s + l.amount_pence,
          0,
        );

        // Unified, newest-first list. Tie-breaker on payment_id keeps
        // ordering stable across renders so React row keys behave.
        const lines = [...succLines, ...voidLines].sort((a, b) => {
          if (a.occurred_at === b.occurred_at)
            return a.payment_id.localeCompare(b.payment_id);
          return a.occurred_at < b.occurred_at ? 1 : -1;
        });

        if (cancelled) return;
        setData({
          range_label: `${fromIso} – ${toIso}`,
          succeeded_pence,
          succeeded_count: succLines.length,
          voided_pence,
          voided_count: voidLines.length,
          net_pence: succeeded_pence - voided_pence,
          lines,
        });
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message =
          e instanceof Error ? e.message : 'Could not load cash payments';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'cash.drawer.in_range',
          severity: 'error',
          message,
          context: { range, locationId },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range, locationId]);

  return { data, loading, error };
}

// ── Past settlements (signed counts) for a location ────────────────────────
//
// A "settlement" in Dylan's mental model is a signed cash count: the
// moment the safe was reconciled, lines were frozen, and a manager
// counter-signed. This list powers the Past settlements section of
// the report so finance can scroll back through every reconciled
// period and drill into any one's payment lines.
//
// Per-location query is separate from useCashCounts() in cashCounts.ts
// because the page-side hook (/cash-counts) deliberately doesn't filter
// — it relies on RLS to narrow to the viewer's own location. The
// drawer report supports an admin choosing any location they can see,
// so we need an explicit filter.

export interface PastSettlementRow {
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

interface RawSettlement {
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
  counted_by: OneOrMany<Person>;
  signed_off_by: OneOrMany<Person>;
}

interface PastSettlementsResult {
  data: PastSettlementRow[] | null;
  loading: boolean;
  error: string | null;
}

export function usePastSettlements(
  locationId: string | null,
): PastSettlementsResult {
  const [data, setData] = useState<PastSettlementRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const query = supabase
          .from('lng_cash_counts')
          .select(
            `id, period_start, period_end, expected_pence, actual_pence, variance_pence,
             status, notes, counted_at, signed_off_at,
             counted_by:accounts!counted_by ( first_name, last_name, name ),
             signed_off_by:accounts!signed_off_by ( first_name, last_name, name )`,
          )
          .order('period_end', { ascending: false });
        if (locationId) query.eq('location_id', locationId);
        const res = await query;
        if (cancelled) return;
        if (res.error) throw new Error(`past_settlements: ${res.error.message}`);
        const rows = ((res.data ?? []) as RawSettlement[]).map((r) => ({
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
          signed_off_by_name: r.signed_off_by
            ? composePersonName(pickOne(r.signed_off_by))
            : null,
          signed_off_at: r.signed_off_at,
        }));
        if (cancelled) return;
        setData(rows);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message =
          e instanceof Error ? e.message : 'Could not load past settlements';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'cash.drawer.past_settlements',
          severity: 'error',
          message,
          context: { locationId },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  return { data, loading, error };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function shapeLine(r: RawPayment): CashDrawerLine {
  const cart = pickOne(r.cart);
  const visit = pickOne(cart?.visit ?? null);
  const patient = pickOne(visit?.patient ?? null);
  const appt = pickOne(visit?.appointment ?? null);
  const walkIn = pickOne(visit?.walk_in ?? null);
  const takenBy = pickOne(r.taken_by);
  const occurredAt =
    r.status === 'cancelled'
      ? r.cancelled_at ?? r.succeeded_at ?? ''
      : r.succeeded_at ?? r.cancelled_at ?? '';
  return {
    payment_id: r.id,
    amount_pence: r.amount_pence,
    occurred_at: occurredAt,
    status: r.status,
    patient_name: composePersonName(patient),
    appointment_ref:
      appt?.appointment_ref ?? walkIn?.appointment_ref ?? null,
    taken_by_name: composePersonName(takenBy),
    void_reason: r.status === 'cancelled' ? r.failure_reason : null,
  };
}
