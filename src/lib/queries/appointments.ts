import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import type { AppointmentStatus } from '../../components/AppointmentCard/AppointmentCard.tsx';

export interface IntakeAnswer {
  question: string;
  answer: string;
}

export interface AppointmentRow {
  id: string;
  patient_id: string;
  location_id: string;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  event_type_label: string | null;
  staff_account_id: string | null;
  intake: IntakeAnswer[] | null;
  patient_first_name: string | null;
  patient_last_name: string | null;
  staff_first_name: string | null;
  staff_last_name: string | null;
}

interface UseTodayAppointmentsResult {
  data: AppointmentRow[];
  loading: boolean;
  error: string | null;
}

export function useTodayAppointments(): UseTodayAppointmentsResult {
  const [data, setData] = useState<AppointmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date();
        end.setHours(23, 59, 59, 999);

        // RLS scopes this query to the receptionist's location.
        const fetchToday = (withIntake: boolean) =>
          supabase
            .from('lng_appointments')
            .select(
              [
                'id',
                'patient_id',
                'location_id',
                'start_at',
                'end_at',
                'status',
                'event_type_label',
                'staff_account_id',
                ...(withIntake ? ['intake'] : []),
                'patient:patients ( first_name, last_name )',
                'staff:accounts!lng_appointments_staff_account_id_fkey ( first_name, last_name )',
              ].join(', ')
            )
            .gte('start_at', start.toISOString())
            .lte('start_at', end.toISOString())
            .order('start_at', { ascending: true });

        let { data: rows, error: err } = await fetchToday(true);
        // 42703 = undefined_column. Frontend deployed before schema migration
        // landed: degrade gracefully without intake instead of blanking the page.
        if (err && err.code === '42703') {
          const fallback = await fetchToday(false);
          rows = fallback.data;
          err = fallback.error;
        }

        if (cancelled) return;
        if (err) {
          // PGRST200 is "relation not found in the embedded resource" — happens
          // before slice 0 migrations land. Treat as empty rather than error.
          if (err.code === 'PGRST200' || err.code === '42P01') {
            setData([]);
            setError(null);
          } else {
            setError(err.message);
          }
          setLoading(false);
          return;
        }

        const mapped: AppointmentRow[] = (rows ?? []).map((r) => {
          const raw = r as unknown as AppointmentRowRaw;
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
        setData(mapped);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Unknown error');
        setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}

interface AppointmentRowRaw {
  id: string;
  patient_id: string;
  location_id: string;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  event_type_label: string | null;
  staff_account_id: string | null;
  intake: IntakeAnswer[] | null;
  patient:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
  staff:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
}

export function patientDisplayName(row: AppointmentRow): string {
  const first = row.patient_first_name ?? '';
  const last = row.patient_last_name ?? '';
  if (!first && !last) return 'Patient';
  return `${first} ${last.slice(0, 1)}${last.slice(0, 1) ? '.' : ''}`.trim();
}

export function staffDisplayName(row: AppointmentRow): string | undefined {
  if (!row.staff_first_name && !row.staff_last_name) return undefined;
  return [row.staff_first_name, row.staff_last_name].filter(Boolean).join(' ');
}

// One-line summary of Calendly intake answers for compact list rows.
// Returns the answer values joined with ' · '; questions that look like
// generic contact fields (number, email, time zone) are filtered out.
export function intakeSummary(row: AppointmentRow): string | undefined {
  const filtered = filterCareIntake(row.intake);
  if (!filtered || filtered.length === 0) return undefined;
  return filtered.map((a) => a.answer.trim()).filter(Boolean).join(' · ');
}

const INTAKE_SKIP_PATTERNS = [
  /^contact\s*number/i,
  /^phone/i,
  /^mobile/i,
  /^email/i,
  /\btime\s*zone\b/i,
];

export function filterCareIntake(intake: IntakeAnswer[] | null | undefined): IntakeAnswer[] {
  if (!intake) return [];
  return intake.filter((a) => {
    if (!a || typeof a.answer !== 'string' || a.answer.trim() === '') return false;
    return !INTAKE_SKIP_PATTERNS.some((re) => re.test(a.question ?? ''));
  });
}
