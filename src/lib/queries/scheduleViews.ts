import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import type { AppointmentRow } from './appointments.ts';
import { formatDateIso, getMonthGridDays } from '../calendarMonth.ts';

interface DayResult {
  data: AppointmentRow[];
  loading: boolean;
  error: string | null;
}

interface RawRow {
  id: string;
  patient_id: string;
  location_id: string;
  start_at: string;
  end_at: string;
  status: AppointmentRow['status'];
  event_type_label: string | null;
  staff_account_id: string | null;
  intake: AppointmentRow['intake'];
  join_url: AppointmentRow['join_url'];
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
  id, patient_id, location_id, start_at, end_at, status, event_type_label, staff_account_id, intake, join_url,
  patient:patients ( first_name, last_name, email, phone ),
  staff:accounts!lng_appointments_staff_account_id_fkey ( first_name, last_name )
`;
const SELECT_NO_INTAKE = `
  id, patient_id, location_id, start_at, end_at, status, event_type_label, staff_account_id,
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
      event_type_label: raw.event_type_label,
      staff_account_id: raw.staff_account_id,
      intake: raw.intake ?? null,
      join_url: raw.join_url ?? null,
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
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
        setLoading(false);
        return;
      }
      setData(mapRows(rows ?? []));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [dateIso]);

  return { data, loading, error };
}

interface MonthCountsResult {
  counts: Map<string, number>;
  loading: boolean;
  error: string | null;
}

// Returns a per-date appointment count for the visible 6-week month grid
// (so dots on previous/next-month padding cells are accurate too).
// Excludes cancelled and rescheduled rows — the dot represents work that
// the receptionist still needs to track on that day.
export function useMonthCounts(year: number, month: number): MonthCountsResult {
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const grid = getMonthGridDays(year, month);
      const firstIso = grid[0]!.dateIso;
      const lastIso = grid[grid.length - 1]!.dateIso;
      const start = new Date(`${firstIso}T00:00:00`);
      const end = new Date(`${lastIso}T23:59:59.999`);
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
        setLoading(false);
        return;
      }
      const m = new Map<string, number>();
      for (const r of rows ?? []) {
        const startAt = (r as { start_at: string }).start_at;
        const dateIso = formatDateIso(new Date(startAt));
        m.set(dateIso, (m.get(dateIso) ?? 0) + 1);
      }
      setCounts(m);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [year, month]);

  return { counts, loading, error };
}
