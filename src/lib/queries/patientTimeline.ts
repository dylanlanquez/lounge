import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

export interface PatientEventRow {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  notes: string | null;
  created_at: string;
}

export interface VisitSummary {
  id: string;
  arrival_type: 'walk_in' | 'scheduled';
  status: string;
  opened_at: string;
  closed_at: string | null;
}

export interface AppointmentSummary {
  id: string;
  start_at: string;
  end_at: string;
  status: string;
  event_type_label: string | null;
}

export interface PaymentSummary {
  id: string;
  method: string;
  payment_journey: string;
  amount_pence: number;
  status: string;
  succeeded_at: string | null;
  created_at: string;
}

interface Result {
  events: PatientEventRow[];
  visits: VisitSummary[];
  appointments: AppointmentSummary[];
  payments: PaymentSummary[];
  loading: boolean;
  error: string | null;
}

export function usePatientTimeline(patientId: string | undefined): Result {
  const [events, setEvents] = useState<PatientEventRow[]>([]);
  const [visits, setVisits] = useState<VisitSummary[]>([]);
  const [appointments, setAppointments] = useState<AppointmentSummary[]>([]);
  const [payments, setPayments] = useState<PaymentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!patientId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [evRes, vRes, aRes] = await Promise.all([
        supabase
          .from('patient_events')
          .select('id, event_type, payload, notes, created_at')
          .eq('patient_id', patientId)
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('lng_visits')
          .select('id, arrival_type, status, opened_at, closed_at')
          .eq('patient_id', patientId)
          .order('opened_at', { ascending: false }),
        supabase
          .from('lng_appointments')
          .select('id, start_at, end_at, status, event_type_label')
          .eq('patient_id', patientId)
          .order('start_at', { ascending: false })
          .limit(50),
      ]);
      if (cancelled) return;
      if (evRes.error) setError(evRes.error.message);
      setEvents((evRes.data ?? []) as PatientEventRow[]);
      setVisits((vRes.data ?? []) as VisitSummary[]);
      setAppointments((aRes.data ?? []) as AppointmentSummary[]);

      // Pull payments for all visits in one query.
      const visitIds = (vRes.data ?? []).map((v) => v.id);
      if (visitIds.length > 0) {
        const { data: cartRows } = await supabase
          .from('lng_carts')
          .select('id, visit_id')
          .in('visit_id', visitIds);
        const cartIds = (cartRows ?? []).map((c) => c.id);
        if (cartIds.length > 0) {
          const { data: payRows } = await supabase
            .from('lng_payments')
            .select('id, method, payment_journey, amount_pence, status, succeeded_at, created_at')
            .in('cart_id', cartIds)
            .order('created_at', { ascending: false });
          if (!cancelled) setPayments((payRows ?? []) as PaymentSummary[]);
        }
      }

      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  return { events, visits, appointments, payments, loading, error };
}
