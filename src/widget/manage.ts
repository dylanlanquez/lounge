import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.ts';

// Patient-side booking management.
//
// Pulls a booking from the lng_widget_lookup_booking RPC keyed on
// the unguessable manage_token (122 bits of entropy, handed to the
// patient via their confirmation email). Anon-callable; the RPC
// returns only the patient-visible shape — no email, phone, notes,
// internal status, or any other patient's row.

export interface ManagedBooking {
  appointmentRef: string | null;
  status: string;
  serviceType: string | null;
  serviceLabel: string;
  startAt: string;
  endAt: string;
  locationName: string;
  locationAddress: string;
  patientFirstName: string | null;
  depositStatus: string | null;
  depositPence: number | null;
  depositCurrency: string | null;
  cancellable: boolean;
}

interface LookupResult {
  data: ManagedBooking | null;
  loading: boolean;
  /** true → token had no match. Distinct from `error` which means the
   *  network/server failed; this means "valid request, but the link
   *  is wrong / expired / typo". */
  notFound: boolean;
  error: string | null;
  refresh: () => void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function useManagedBooking(token: string | null): LookupResult {
  const [data, setData] = useState<ManagedBooking | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!token || !UUID_RE.test(token)) {
      setLoading(false);
      setNotFound(true);
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);
    (async () => {
      const { data: rows, error: err } = await supabase.rpc('lng_widget_lookup_booking', {
        p_token: token,
      });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setData(null);
        setLoading(false);
        return;
      }
      const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
      if (!row) {
        setNotFound(true);
        setData(null);
        setLoading(false);
        return;
      }
      const r = row as Record<string, unknown>;
      setData({
        appointmentRef: (r.appointment_ref as string | null) ?? null,
        status: (r.status as string) ?? '',
        serviceType: (r.service_type as string | null) ?? null,
        serviceLabel: (r.service_label as string) ?? '',
        startAt: (r.start_at as string) ?? '',
        endAt: (r.end_at as string) ?? '',
        locationName: (r.location_name as string) ?? '',
        locationAddress: (r.location_address as string) ?? '',
        patientFirstName: (r.patient_first_name as string | null) ?? null,
        depositStatus: (r.deposit_status as string | null) ?? null,
        depositPence: (r.deposit_pence as number | null) ?? null,
        depositCurrency: (r.deposit_currency as string | null) ?? null,
        cancellable: Boolean(r.cancellable),
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [token, tick]);

  return {
    data,
    loading,
    notFound,
    error,
    refresh: () => setTick((t) => t + 1),
  };
}

export interface CancelResult {
  appointmentId: string;
  alreadyCancelled?: boolean;
}

export class CancelError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'CancelError';
    this.code = code;
  }
}

export async function cancelBooking(token: string): Promise<CancelResult> {
  if (!UUID_RE.test(token)) throw new CancelError('invalid_token');

  const { data, error } = await supabase.functions.invoke<{
    ok?: boolean;
    appointmentId?: string;
    already_cancelled?: boolean;
    error?: string;
  }>('widget-cancel-booking', { body: { token } });

  if (error) {
    const detail = await readErrorBody(error as Error & { context?: Response });
    const code =
      (detail && typeof detail === 'object' && 'error' in detail
        ? String((detail as { error: string }).error)
        : null) ?? 'cancel_failed';
    throw new CancelError(code, error.message);
  }
  if (!data || !data.ok || !data.appointmentId) {
    throw new CancelError('cancel_failed', 'Empty response from cancel endpoint.');
  }
  return {
    appointmentId: data.appointmentId,
    alreadyCancelled: Boolean(data.already_cancelled),
  };
}

async function readErrorBody(err: Error & { context?: Response }): Promise<unknown> {
  const ctx = err.context;
  if (!ctx) return null;
  try {
    return await ctx.clone().json();
  } catch {
    try {
      return await ctx.clone().text();
    } catch {
      return null;
    }
  }
}
