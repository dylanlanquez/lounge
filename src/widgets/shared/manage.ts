import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase.ts';

// Patient-side booking management.
//
// Pulls a booking from the lng_widget_lookup_booking RPC keyed on
// the unguessable manage_token (122 bits of entropy, handed to the
// patient via their confirmation email). Anon-callable; the RPC
// returns only the patient-visible shape — no email, phone, notes,
// internal status, or any other patient's row.

/** Per-arch repair line captured at booking. Renders inside the
 *  manage-page denture-repair table. */
export interface ManagedRepairItem {
  name: string;
  arch: 'upper' | 'lower' | 'both';
  unitLabel: string | null;
  quantity: number;
  linePricePence: number;
  /** lwo_catalogue.repair_variant — needed so the reschedule slot
   *  picker can ship the full distinct-variants array to the
   *  cart-aware slot RPC. Without this the manage-page reschedule
   *  flow would fall back to the appointment row's single
   *  repair_variant, missing other variants' pool claims. */
  repairVariant: string | null;
}

/** Upgrade selection captured at booking. Renders inside the
 *  manage-page upgrades table. */
export interface ManagedUpgrade {
  name: string;
  pricePence: number;
}

export interface ManagedBooking {
  /** UUID — used as the exclude target for the reschedule slot
   *  picker so the patient's own current slot stays bookable. */
  id: string;
  appointmentRef: string | null;
  status: string;
  serviceType: string | null;
  serviceLabel: string;
  /** Persisted event_type_label exactly as it sits on the row.
   *  Needed by the customer-facing Title-Case label helper so it
   *  can fall back gracefully for service types it doesn't have a
   *  bespoke phrase for. */
  eventTypeLabel: string | null;
  startAt: string;
  endAt: string;
  locationId: string | null;
  locationName: string;
  locationAddress: string;
  patientFirstName: string | null;
  depositStatus: string | null;
  depositPence: number | null;
  depositCurrency: string | null;
  /** TRUE when the patient picked "Pay now in full" at booking so
   *  there's no balance to settle in clinic. Drives the manage-page
   *  payment summary line — "Paid in full at booking" vs the
   *  existing "Deposit paid · £…". */
  paidInFullAtBooking: boolean;
  repairVariant: string | null;
  productKey: string | null;
  arch: 'upper' | 'lower' | 'both' | null;
  cancellable: boolean;
  /** Per-arch denture-repair lines captured at booking. Empty for
   *  any booking that isn't denture repair or that didn't tick any
   *  repair tiles in the widget. */
  repairItems: ManagedRepairItem[];
  /** Add-on upgrade selections captured at booking. Empty for any
   *  booking that didn't pick upgrades. */
  upgrades: ManagedUpgrade[];
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
      const repairItemsRaw = Array.isArray(r.repair_items) ? r.repair_items : [];
      const upgradesRaw = Array.isArray(r.upgrades) ? r.upgrades : [];
      const repairItems: ManagedRepairItem[] = repairItemsRaw
        .map((it) => it as Record<string, unknown>)
        .map((it) => ({
          name: (it.name as string) ?? '',
          arch: (it.arch as 'upper' | 'lower' | 'both') ?? 'both',
          unitLabel: (it.unit_label as string | null) ?? null,
          quantity: Number(it.quantity ?? 1),
          linePricePence: Number(it.line_total_pence ?? 0),
          repairVariant: (it.repair_variant as string | null) ?? null,
        }))
        .filter((it) => it.name.length > 0);
      const upgrades: ManagedUpgrade[] = upgradesRaw
        .map((u) => u as Record<string, unknown>)
        .map((u) => ({
          name: (u.name as string) ?? '',
          pricePence: Number(u.resolved_price_pence ?? 0),
        }))
        .filter((u) => u.name.length > 0);
      setData({
        id: (r.id as string) ?? '',
        appointmentRef: (r.appointment_ref as string | null) ?? null,
        status: (r.status as string) ?? '',
        serviceType: (r.service_type as string | null) ?? null,
        serviceLabel: (r.service_label as string) ?? '',
        eventTypeLabel: (r.service_label as string | null) ?? null,
        startAt: (r.start_at as string) ?? '',
        endAt: (r.end_at as string) ?? '',
        locationId: (r.location_id as string | null) ?? null,
        locationName: (r.location_name as string) ?? '',
        locationAddress: (r.location_address as string) ?? '',
        patientFirstName: (r.patient_first_name as string | null) ?? null,
        depositStatus: (r.deposit_status as string | null) ?? null,
        depositPence: (r.deposit_pence as number | null) ?? null,
        depositCurrency: (r.deposit_currency as string | null) ?? null,
        paidInFullAtBooking: Boolean(r.paid_in_full_at_booking),
        repairVariant: (r.repair_variant as string | null) ?? null,
        productKey: (r.product_key as string | null) ?? null,
        arch: (r.arch as 'upper' | 'lower' | 'both' | null) ?? null,
        cancellable: Boolean(r.cancellable),
        repairItems,
        upgrades,
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

export interface RescheduleResult {
  newAppointmentId: string;
  newManageToken: string;
  newAppointmentRef: string | null;
}

export class RescheduleError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'RescheduleError';
    this.code = code;
  }
}

export async function rescheduleBooking(token: string, newStartAtIso: string): Promise<RescheduleResult> {
  if (!UUID_RE.test(token)) throw new RescheduleError('invalid_token');
  if (!newStartAtIso) throw new RescheduleError('newStartAt_missing');

  const { data, error } = await supabase.functions.invoke<{
    ok?: boolean;
    newAppointmentId?: string;
    newManageToken?: string;
    newAppointmentRef?: string | null;
    error?: string;
  }>('widget-reschedule-booking', {
    body: { token, newStartAt: newStartAtIso },
  });

  if (error) {
    const detail = await readErrorBody(error as Error & { context?: Response });
    const code =
      (detail && typeof detail === 'object' && 'error' in detail
        ? String((detail as { error: string }).error)
        : null) ?? 'reschedule_failed';
    throw new RescheduleError(code, error.message);
  }
  if (!data || !data.ok || !data.newAppointmentId || !data.newManageToken) {
    throw new RescheduleError('reschedule_failed', 'Empty response from reschedule endpoint.');
  }
  return {
    newAppointmentId: data.newAppointmentId,
    newManageToken: data.newManageToken,
    newAppointmentRef: data.newAppointmentRef ?? null,
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
