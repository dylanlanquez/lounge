import { useCallback, useEffect, useState } from 'react';
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
  staff_account_id: string | null;
  notes: string | null;
  intake: AppointmentRow['intake'];
  join_url: AppointmentRow['join_url'];
  deposit_pence?: number | null;
  deposit_currency?: string | null;
  deposit_provider?: 'paypal' | 'stripe' | null;
  deposit_status?: 'paid' | 'failed' | null;
  patient:
    | { first_name: string | null; last_name: string | null; email: string | null; phone: string | null }
    | { first_name: string | null; last_name: string | null; email: string | null; phone: string | null }[]
    | null;
  staff:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
}

const SELECT_WITH_INTAKE = `
  id, patient_id, location_id, start_at, end_at, status, source, event_type_label, staff_account_id, notes, intake, join_url,
  deposit_pence, deposit_currency, deposit_provider, deposit_status,
  patient:patients ( first_name, last_name, email, phone ),
  staff:accounts!lng_appointments_staff_account_id_fkey ( first_name, last_name )
`;
const SELECT_NO_INTAKE = `
  id, patient_id, location_id, start_at, end_at, status, source, event_type_label, staff_account_id, notes,
  patient:patients ( first_name, last_name, email, phone ),
  staff:accounts!lng_appointments_staff_account_id_fkey ( first_name, last_name )
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
      staff_account_id: raw.staff_account_id,
      notes: raw.notes ?? null,
      intake: raw.intake ?? null,
      join_url: raw.join_url ?? null,
      deposit_pence: raw.deposit_pence ?? null,
      deposit_currency: raw.deposit_currency ?? null,
      deposit_provider: raw.deposit_provider ?? null,
      deposit_status: raw.deposit_status ?? null,
      patient_first_name: patient?.first_name ?? null,
      patient_last_name: patient?.last_name ?? null,
      patient_email: patient?.email ?? null,
      patient_phone: patient?.phone ?? null,
      staff_first_name: staff?.first_name ?? null,
      staff_last_name: staff?.last_name ?? null,
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

export function useDayAppointments(dateIso: string): DayResult {
  const [data, setData] = useState<AppointmentRow[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumping this counter triggers the effect below to re-run the
  // query without changing dateIso — used by `refresh()`.
  const [refreshTick, setRefreshTick] = useState(0);
  // dateIso IS the resource key — switching days is a real key
  // transition (the previous day's rows are stale). Refresh ticks
  // for the same day reuse data without flicker.
  const { loading, settle } = useStaleQueryLoading(dateIso);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Data is intentionally NOT cleared here. Keeping the previous
      // day's rows visible while the new fetch is in flight lets the
      // parent dim them in place rather than flashing a skeleton on
      // every tap.
      const { startIso, endIso } = localDayBounds(dateIso);
      const run = (sel: string) =>
        supabase
          .from('lng_appointments')
          .select(sel)
          .gte('start_at', startIso)
          .lte('start_at', endIso)
          .order('start_at', { ascending: true });
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
          setData([]);
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        setHasLoaded(true);
        return;
      }
      setData(mapRows(rows ?? []));
      settle();
      setHasLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [dateIso, refreshTick, settle]);

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
  endIso: string
): DateRangeCountsResult {
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const { loading, settle } = useStaleQueryLoading(`${startIso}|${endIso}`);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const start = new Date(`${startIso}T00:00:00`);
      const end = new Date(`${endIso}T23:59:59.999`);
      const { data: rows, error: err } = await supabase
        .from('lng_appointments')
        .select('start_at, status')
        .gte('start_at', start.toISOString())
        .lte('start_at', end.toISOString())
        .not('status', 'in', '(cancelled,rescheduled)');

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
  }, [startIso, endIso, refreshTick, settle]);

  const refresh = useCallback(() => {
    setRefreshTick((t) => t + 1);
  }, []);

  // Week-strip dots refresh on any appointment change. The strip is
  // visible while the receptionist works through the day so a fresh
  // booking landing via Calendly should pop a new dot immediately.
  useRealtimeRefresh([{ table: 'lng_appointments' }], refresh);

  return { counts, loading, error, refresh };
}
