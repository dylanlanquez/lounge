import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { supabase } from '../supabase.ts';
import type { AppointmentRow } from './appointments.ts';
import { formatDateIso } from '../calendarMonth.ts';
import { useRealtimeRefresh } from '../useRealtimeRefresh.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';

interface DayResult {
  data: AppointmentRow[];
  loading: boolean;
  // True after the first successful fetch. Lets the parent show a
  // skeleton on the very first paint but keep stale data visible (with
  // a subtle dim) on every subsequent date change so day-switching feels
  // instant instead of flashing through a loading state every time.
  hasLoaded: boolean;
  error: string | null;
  // Re-runs the underlying query against the same date. Use after
  // server-side mutations (no-show, undo no-show, virtual join,
  // etc.) so the action sheet can close and the day's row list
  // reflects the new state without a full page reload — which would
  // otherwise wipe the receptionist's selectedDate back to today.
  refresh: () => void;
}

interface RawRow {
  id: string;
  patient_id: string;
  location_id: string;
  start_at: string;
  end_at: string;
  status: AppointmentRow['status'];
  source: AppointmentRow['source'];
  event_type_label: string | null;
  // Catalogue axis pins from the widget booking flow. Optional on
  // the raw shape so a deploy that lands before the SELECT update
  // doesn't blow up.
  service_type?: string | null;
  product_key?: string | null;
  repair_variant?: string | null;
  arch?: string | null;
  brand_id?: string | null;
  staff_account_id: string | null;
  notes: string | null;
  cancel_reason?: string | null;
  intake: AppointmentRow['intake'];
  join_url: AppointmentRow['join_url'];
  walk_in_id?: string | null;
  deposit_pence?: number | null;
  deposit_currency?: string | null;
  deposit_provider?: 'paypal' | 'stripe' | null;
  deposit_status?: 'paid' | 'failed' | null;
  paid_in_full_at_booking?: boolean | null;
  patient:
    | { first_name: string | null; last_name: string | null; email: string | null; phone: string | null }
    | { first_name: string | null; last_name: string | null; email: string | null; phone: string | null }[]
    | null;
  staff:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
  phases?:
    | {
        phase_index: number;
        label: string;
        patient_required: boolean;
        start_at: string;
        end_at: string;
        status: 'pending' | 'in_progress' | 'complete' | 'skipped';
        pool_ids: string[] | null;
      }[]
    | null;
}

// Embedded phase select reused by both column-list variants. PostgREST
// resolves lng_appointment_phases via the FK to lng_appointments(id).
// Returns an empty array for appointments that aren't materialised
// yet — the renderer falls back to a single implicit phase in that
// case so legacy rows still display.
const PHASE_SELECT =
  'phases:lng_appointment_phases ( phase_index, label, patient_required, start_at, end_at, status, pool_ids )';

const SELECT_WITH_INTAKE = `
  id, patient_id, location_id, start_at, end_at, status, source, event_type_label,
  service_type, product_key, repair_variant, arch, brand_id,
  staff_account_id, notes, cancel_reason, intake, join_url, walk_in_id,
  deposit_pence, deposit_currency, deposit_provider, deposit_status, paid_in_full_at_booking,
  patient:patients ( first_name, last_name, email, phone ),
  staff:accounts!lng_appointments_staff_account_id_fkey ( first_name, last_name ),
  ${PHASE_SELECT}
`;
const SELECT_NO_INTAKE = `
  id, patient_id, location_id, start_at, end_at, status, source, event_type_label,
  service_type, product_key, repair_variant, arch, brand_id,
  staff_account_id, notes, cancel_reason, walk_in_id,
  patient:patients ( first_name, last_name, email, phone ),
  staff:accounts!lng_appointments_staff_account_id_fkey ( first_name, last_name ),
  ${PHASE_SELECT}
`;

function mapRows(rows: unknown[]): AppointmentRow[] {
  return (rows ?? []).map((r) => {
    const raw = r as RawRow;
    const patient = Array.isArray(raw.patient) ? raw.patient[0] : raw.patient;
    const staff = Array.isArray(raw.staff) ? raw.staff[0] : raw.staff;
    return {
      id: raw.id,
      patient_id: raw.patient_id,
      location_id: raw.location_id,
      start_at: raw.start_at,
      end_at: raw.end_at,
      status: raw.status,
      source: raw.source,
      event_type_label: raw.event_type_label,
      service_type: raw.service_type ?? null,
      product_key: raw.product_key ?? null,
      repair_variant: raw.repair_variant ?? null,
      arch: raw.arch ?? null,
      brand_id: raw.brand_id ?? null,
      staff_account_id: raw.staff_account_id,
      notes: raw.notes ?? null,
      cancel_reason: raw.cancel_reason ?? null,
      intake: raw.intake ?? null,
      join_url: raw.join_url ?? null,
      walk_in_id: raw.walk_in_id ?? null,
      deposit_pence: raw.deposit_pence ?? null,
      deposit_currency: raw.deposit_currency ?? null,
      deposit_provider: raw.deposit_provider ?? null,
      deposit_status: raw.deposit_status ?? null,
      paid_in_full_at_booking: raw.paid_in_full_at_booking ?? false,
      patient_first_name: patient?.first_name ?? null,
      patient_last_name: patient?.last_name ?? null,
      patient_email: patient?.email ?? null,
      patient_phone: patient?.phone ?? null,
      staff_first_name: staff?.first_name ?? null,
      staff_last_name: staff?.last_name ?? null,
      phases: (raw.phases ?? [])
        .map((p) => ({
          phase_index: p.phase_index,
          label: p.label,
          patient_required: p.patient_required,
          start_at: p.start_at,
          end_at: p.end_at,
          status: p.status,
          pool_ids: p.pool_ids ?? [],
        }))
        .sort((a, b) => a.phase_index - b.phase_index),
    };
  });
}

// Boundary handling note: an ISO date like "2026-04-28" is treated as the
// receptionist's local-time day. We bracket the query with the local
// midnight pair so an appointment at 23:30 on the 28th never leaks into
// the 29th's view.
function localDayBounds(dateIso: string): { startIso: string; endIso: string } {
  const start = new Date(`${dateIso}T00:00:00`);
  const end = new Date(`${dateIso}T23:59:59.999`);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export function useDayAppointments(
  dateIso: string,
  // Filter by location at the query level so a staff member visible
  // to multiple locations via RLS doesn't see the OTHER location's
  // rows on their schedule. This used to be implicit (RLS narrowed
  // to one row); but staff with cross-location visibility had both
  // locations' bookings bleeding through, which made the schedule
  // look saturated even when the staff member's own chair was free
  // (or vice versa). When omitted, the query falls back to the
  // RLS-only behaviour for callers that haven't been updated yet.
  locationId?: string | null,
): DayResult {
  // Per-day cache: Map<dateIso, AppointmentRow[]>.
  //
  // Storing rows in a ref (not state) prevents stale cross-day data from
  // ever being the source of truth for the CURRENT day. `data` and
  // `hasLoaded` are derived synchronously on every render from the cache
  // entry for the active dateIso — so switching from a day that had zero
  // appointments to a day that has many will ALWAYS show a skeleton while
  // the new day's data is in-flight, never a false "No appointments" state.
  //
  // Stale-while-revalidate still works for revisited days: the cached rows
  // are shown immediately (dimmed via DayReloadingWrapper) while the fresh
  // fetch runs in the background, then swapped atomically when it lands.
  // Cache keyed by `${dateIso}|${locationId ?? ''}` so a location
  // switch (rare in practice but possible for cross-site staff)
  // never serves stale rows from the previous location's view.
  const cache = useRef<Map<string, AppointmentRow[]>>(new Map());
  const cacheKey = `${dateIso}|${locationId ?? ''}`;
  // forceUpdate() is the only mechanism that causes React to re-render
  // after a cache write (refs are invisible to the reconciler).
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const { loading, settle } = useStaleQueryLoading(dateIso);

  // Derived from cache — always the correct data for the current
  // (date, location) tuple.
  const data = cache.current.get(cacheKey) ?? [];
  const hasLoaded = cache.current.has(cacheKey);

  useEffect(() => {
    // null locationId means "the caller is still resolving the
    // location" — don't fire an unfiltered fetch in the meantime.
    // Doing so caches an "all locations" page under the `${dateIso}|`
    // key, which then gets discarded the moment the real location
    // arrives and the cache key flips. Worse, while that stale page
    // was the active cache entry, the schedule's empty-state branch
    // could render for one frame between fetches (cache miss for the
    // new key → data=[] → "No appointments today" flashes).
    if (locationId === null) return;
    let cancelled = false;
    (async () => {
      const { startIso, endIso } = localDayBounds(dateIso);
      const run = (sel: string) => {
        let q = supabase
          .from('lng_appointments')
          .select(sel)
          .gte('start_at', startIso)
          .lte('start_at', endIso);
        if (locationId) q = q.eq('location_id', locationId);
        return q.order('start_at', { ascending: true });
      };
      let { data: rows, error: err } = await run(SELECT_WITH_INTAKE);
      // 42703 = undefined_column. Frontend deployed before the intake
      // migration: degrade gracefully without intake instead of blanking.
      if (err && err.code === '42703') {
        const fb = await run(SELECT_NO_INTAKE);
        rows = fb.data;
        err = fb.error;
      }
      if (cancelled) return;
      if (err) {
        // PGRST200 / 42P01 = pre-migration; treat as empty rather than error.
        if (err.code === 'PGRST200' || err.code === '42P01') {
          cache.current.set(cacheKey,[]);
          forceUpdate();
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        return;
      }
      cache.current.set(cacheKey,mapRows(rows ?? []));
      forceUpdate();
      setError(null);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [dateIso, locationId, refreshTick, settle]);

  const refresh = useCallback(() => {
    setRefreshTick((t) => t + 1);
  }, []);

  // Auto-refresh whenever any appointment for this day changes upstream.
  // We don't filter by start_at on the server (Realtime filters are
  // exact-match only, not ranges), so we just listen to all appointment
  // changes and let the next fetch re-window. Volume is fine — Schedule
  // is open at most one tab at a time per receptionist. Visit status
  // changes (booked → arrived → done) also affect the schedule row's
  // pill so subscribe to lng_visits too.
  useRealtimeRefresh(
    [
      { table: 'lng_appointments' },
      { table: 'lng_visits' },
    ],
    refresh,
  );

  return { data, loading, hasLoaded, error, refresh };
}

interface DateRangeCountsResult {
  counts: Map<string, number>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Per-date appointment count for an inclusive date range. Used by the
// week strip to render event dots under each visible day. Excludes
// cancelled and rescheduled rows — the dot represents work that still
// needs tracking, not historical noise.
export function useDateRangeCounts(
  startIso: string,
  endIso: string,
  // Same rationale as useDayAppointments: keep the strip honest to
  // the staff member's location so cross-site rows don't pump up the
  // wrong day's dot.
  locationId?: string | null,
): DateRangeCountsResult {
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const { loading, settle } = useStaleQueryLoading(`${startIso}|${endIso}`);

  useEffect(() => {
    // Same wait-for-location guard as useDayAppointments — skip
    // firing an unfiltered range count while the location is still
    // resolving so the strip dots don't get computed from an
    // every-location row set and then re-computed once the real
    // location lands.
    if (locationId === null) return;
    let cancelled = false;
    (async () => {
      const start = new Date(`${startIso}T00:00:00`);
      const end = new Date(`${endIso}T23:59:59.999`);
      let q = supabase
        .from('lng_appointments')
        .select('start_at, status')
        .gte('start_at', start.toISOString())
        .lte('start_at', end.toISOString())
        .not('status', 'in', '(cancelled,rescheduled)');
      if (locationId) q = q.eq('location_id', locationId);
      const { data: rows, error: err } = await q;

      if (cancelled) return;
      if (err) {
        if (err.code === 'PGRST200' || err.code === '42P01') {
          setCounts(new Map());
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        return;
      }
      const m = new Map<string, number>();
      for (const r of rows ?? []) {
        const startAt = (r as { start_at: string }).start_at;
        const dateIso = formatDateIso(new Date(startAt));
        m.set(dateIso, (m.get(dateIso) ?? 0) + 1);
      }
      setCounts(m);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [startIso, endIso, locationId, refreshTick, settle]);

  const refresh = useCallback(() => {
    setRefreshTick((t) => t + 1);
  }, []);

  // Week-strip dots refresh on any appointment change. The strip is
  // visible while the receptionist works through the day so a fresh
  // booking landing via Calendly should pop a new dot immediately.
  useRealtimeRefresh([{ table: 'lng_appointments' }], refresh);

  return { counts, loading, error, refresh };
}
