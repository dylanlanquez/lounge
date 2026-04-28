import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import type { AppointmentRow } from './appointments.ts';

interface Result {
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
  patient: { first_name: string | null; last_name: string | null }[] | { first_name: string | null; last_name: string | null } | null;
  staff: { first_name: string | null; last_name: string | null }[] | { first_name: string | null; last_name: string | null } | null;
}

const SELECT_WITH_INTAKE = `
  id, patient_id, location_id, start_at, end_at, status, event_type_label, staff_account_id, intake,
  patient:patients ( first_name, last_name ),
  staff:accounts!lng_appointments_staff_account_id_fkey ( first_name, last_name )
`;
const SELECT_NO_INTAKE = `
  id, patient_id, location_id, start_at, end_at, status, event_type_label, staff_account_id,
  patient:patients ( first_name, last_name ),
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
      patient_first_name: patient?.first_name ?? null,
      patient_last_name: patient?.last_name ?? null,
      staff_first_name: staff?.first_name ?? null,
      staff_last_name: staff?.last_name ?? null,
    };
  });
}

export function useUpcomingAppointments(daysAhead = 14): Result {
  const [data, setData] = useState<AppointmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + daysAhead * 24 * 60 * 60 * 1000);
      const run = (sel: string) =>
        supabase
          .from('lng_appointments')
          .select(sel)
          .gte('start_at', start.toISOString())
          .lte('start_at', end.toISOString())
          .in('status', ['booked', 'arrived', 'in_progress'])
          .order('start_at', { ascending: true });
      let { data: rows, error: err } = await run(SELECT_WITH_INTAKE);
      if (err && err.code === '42703') {
        const fb = await run(SELECT_NO_INTAKE);
        rows = fb.data;
        err = fb.error;
      }
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      setData(mapRows(rows ?? []));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [daysAhead]);

  return { data, loading, error };
}

export function usePastAppointments(daysBack = 30): Result {
  const [data, setData] = useState<AppointmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const end = new Date();
      end.setHours(0, 0, 0, 0);
      const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);
      const run = (sel: string) =>
        supabase
          .from('lng_appointments')
          .select(sel)
          .gte('start_at', start.toISOString())
          .lt('start_at', end.toISOString())
          .order('start_at', { ascending: false });
      let { data: rows, error: err } = await run(SELECT_WITH_INTAKE);
      if (err && err.code === '42703') {
        const fb = await run(SELECT_NO_INTAKE);
        rows = fb.data;
        err = fb.error;
      }
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      setData(mapRows(rows ?? []));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [daysBack]);

  return { data, loading, error };
}
