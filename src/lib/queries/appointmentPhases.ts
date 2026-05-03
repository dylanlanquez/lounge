import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabase.ts';
import type { AppointmentPhaseSummary } from './appointments.ts';

// Per-appointment phase fetch + advance helper. Used by the
// appointment detail's "Booking timeline" section. The schedule grid
// has its own embedded fetch in scheduleViews.ts because it loads
// many appointments at once; here we want one appointment's phases
// in isolation, with refresh on demand after the receptionist
// advances a phase status.
//
// Phases come back ordered by phase_index. An appointment with no
// materialised phases (legacy data) returns an empty array — the
// timeline component handles that case by hiding itself.

export interface UseAppointmentPhasesResult {
  data: AppointmentPhaseSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useAppointmentPhases(
  appointmentId: string | undefined | null,
): UseAppointmentPhasesResult {
  const [data, setData] = useState<AppointmentPhaseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!appointmentId) {
      setData([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('lng_appointment_phases')
        .select('phase_index, label, patient_required, start_at, end_at, status, pool_ids')
        .eq('appointment_id', appointmentId)
        .order('phase_index', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      setData(
        (rows ?? []).map((r) => ({
          phase_index: (r as { phase_index: number }).phase_index,
          label: (r as { label: string }).label,
          patient_required: (r as { patient_required: boolean }).patient_required,
          start_at: (r as { start_at: string }).start_at,
          end_at: (r as { end_at: string }).end_at,
          status: (r as { status: AppointmentPhaseSummary['status'] }).status,
          pool_ids: ((r as { pool_ids: string[] | null }).pool_ids ?? []),
        })),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [appointmentId, tick]);

  const refresh = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  return { data, loading, error, refresh };
}

// Advance a phase's status forward — pending → in_progress → complete
// (or skipped at any point). Calls the SQL function that enforces
// forward-only and writes a lng_event_log row. Throws on validation
// errors so the caller can surface to a toast.
export async function advanceAppointmentPhase(args: {
  appointmentId: string;
  phaseIndex: number;
  toStatus: 'in_progress' | 'complete' | 'skipped';
}): Promise<void> {
  const { error } = await supabase.rpc('lng_appointment_phase_advance', {
    p_appointment_id: args.appointmentId,
    p_phase_index: args.phaseIndex,
    p_to_status: args.toStatus,
  });
  if (error) throw new Error(error.message);
}
