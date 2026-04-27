import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

export interface CalendlyDiagnostic {
  deliveriesTotal: number;
  deliveriesProcessed: number;
  deliveriesFailed: number;
  lngAppointmentsCalendly: number;
  recentFailures: number;
  lastDelivery: string | null;
  loading: boolean;
  error: string | null;
}

export function useCalendlyDiagnostic(): CalendlyDiagnostic & { refresh: () => void } {
  const [d, setD] = useState<CalendlyDiagnostic>({
    deliveriesTotal: 0,
    deliveriesProcessed: 0,
    deliveriesFailed: 0,
    lngAppointmentsCalendly: 0,
    recentFailures: 0,
    lastDelivery: null,
    loading: true,
    error: null,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const [
        delTotal,
        delProc,
        delFail,
        apptCal,
        recFail,
        lastDel,
      ] = await Promise.all([
        supabase.from('lng_calendly_bookings').select('*', { count: 'exact', head: true }),
        supabase.from('lng_calendly_bookings').select('*', { count: 'exact', head: true }).not('processed_at', 'is', null),
        supabase.from('lng_calendly_bookings').select('*', { count: 'exact', head: true }).not('failure_reason', 'is', null),
        supabase.from('lng_appointments').select('*', { count: 'exact', head: true }).eq('source', 'calendly'),
        supabase.from('lng_system_failures').select('*', { count: 'exact', head: true }).eq('source', 'calendly-webhook').gte('occurred_at', sinceISO),
        supabase.from('lng_calendly_bookings').select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ]);
      if (cancelled) return;
      setD({
        deliveriesTotal: delTotal.count ?? 0,
        deliveriesProcessed: delProc.count ?? 0,
        deliveriesFailed: delFail.count ?? 0,
        lngAppointmentsCalendly: apptCal.count ?? 0,
        recentFailures: recFail.count ?? 0,
        lastDelivery: (lastDel.data as { created_at: string } | null)?.created_at ?? null,
        loading: false,
        error: null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { ...d, refresh: () => setTick((t) => t + 1) };
}

export interface BackfillResult {
  ok: boolean;
  received?: number;
  applied?: number;
  errors?: string[];
  error?: string;
}

export async function runCalendlyBackfill(): Promise<BackfillResult> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) return { ok: false, error: 'Not signed in' };
    const url = new URL(import.meta.env.VITE_SUPABASE_URL);
    const projectRef = url.hostname.split('.')[0];
    const r = await fetch(`https://${projectRef}.functions.supabase.co/calendly-backfill`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await r.json();
    if (!r.ok) return { ok: false, error: body?.error ?? `HTTP ${r.status}` };
    return { ok: true, received: body.received, applied: body.applied, errors: body.errors };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Unknown error' };
  }
}
