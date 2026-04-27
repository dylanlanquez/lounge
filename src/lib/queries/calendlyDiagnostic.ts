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
  skipped?: number;
  errors?: string[];
  error?: string;
}

export interface VerifyResult {
  ok: boolean;
  expectedUrl?: string;
  subscriptionsTotal?: number;
  subscriptionsMatching?: number;
  activeMatching?: number;
  subscriptions?: Array<{
    uri?: string;
    callback_url?: string;
    events?: string[];
    state?: string;
    created_at?: string;
    matchesProject?: boolean;
  }>;
  error?: string;
}

async function callBackfillFn(payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) return { ok: false, status: 401, body: { error: 'Not signed in' } };
  const url = new URL(import.meta.env.VITE_SUPABASE_URL);
  const projectRef = url.hostname.split('.')[0];
  const r = await fetch(`https://${projectRef}.functions.supabase.co/calendly-backfill`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body: Record<string, unknown> = {};
  try {
    body = await r.json();
  } catch {
    body = {};
  }
  return { ok: r.ok, status: r.status, body };
}

export async function runCalendlyBackfill(): Promise<BackfillResult> {
  try {
    const { ok, status, body } = await callBackfillFn({ action: 'backfill' });
    if (!ok) return { ok: false, error: (body.error as string | undefined) ?? `HTTP ${status}` };
    return {
      ok: true,
      received: body.received as number,
      applied: body.applied as number,
      skipped: body.skipped as number,
      errors: body.errors as string[] | undefined,
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Unknown error' };
  }
}

export async function verifyCalendlyWebhook(): Promise<VerifyResult> {
  try {
    const { ok, status, body } = await callBackfillFn({ action: 'verify' });
    if (!ok) return { ok: false, error: (body.error as string | undefined) ?? `HTTP ${status}` };
    return {
      ok: true,
      expectedUrl: body.expectedUrl as string,
      subscriptionsTotal: body.subscriptionsTotal as number,
      subscriptionsMatching: body.subscriptionsMatching as number,
      activeMatching: body.activeMatching as number,
      subscriptions: body.subscriptions as VerifyResult['subscriptions'],
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Unknown error' };
  }
}
