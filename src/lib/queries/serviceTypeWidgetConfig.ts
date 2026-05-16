import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { logFailure } from '../failureLog.ts';
import type { BookingServiceType } from './bookingTypes.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Per-service-type widget config (lng_service_type_widget_config).
//
// Sibling to lng_booking_type_config but keyed at the service_type level.
// Holds settings that apply uniformly across every booking-type under one
// service — currently:
//
//   • request_smile_photos  — widget success screen + staff appointment
//                             pages render the SmilePhotosCard when true.
//                             Previously hardcoded to click_in_veneers
//                             only; this table generalises it.
//   • show_upgrades         — widget shows the Optional extras step for
//                             this service when true. Default true; an
//                             admin opts a service OUT explicitly. Per-
//                             upgrade visibility still lives on the
//                             catalogue row.
//
// Rows are optional — when a service has no row, the helpers below
// return the defaults (request_smile_photos=false, show_upgrades=true)
// so the consumers never need null-checks.
// ─────────────────────────────────────────────────────────────────────────────

export interface ServiceTypeWidgetConfig {
  request_smile_photos: boolean;
  show_upgrades: boolean;
}

export const DEFAULT_SERVICE_TYPE_CONFIG: ServiceTypeWidgetConfig = {
  request_smile_photos: false,
  show_upgrades: true,
};

interface RawRow {
  service_type: string;
  request_smile_photos: boolean;
  show_upgrades: boolean;
}

// ── Anon-readable widget consumer ───────────────────────────────────────────
// The customer-facing widget reads from the public view at load. Returns
// a map service_type → config; consumers call configFor(serviceType, map)
// to get a defaulted value.

interface PublicResult {
  data: Record<string, ServiceTypeWidgetConfig> | null;
  loading: boolean;
  error: string | null;
}

export function useWidgetServiceTypeConfig(): PublicResult {
  const [data, setData] = useState<Record<string, ServiceTypeWidgetConfig> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('lng_widget_service_type_config')
        .select('service_type, request_smile_photos, show_upgrades');
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        await logFailure({
          source: 'widget.service_type_config',
          severity: 'error',
          message: err.message,
          context: {},
        });
        return;
      }
      const out: Record<string, ServiceTypeWidgetConfig> = {};
      for (const row of (rows ?? []) as RawRow[]) {
        out[row.service_type] = {
          request_smile_photos: row.request_smile_photos,
          show_upgrades: row.show_upgrades,
        };
      }
      setData(out);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}

/** Defaulted lookup — returns DEFAULT_SERVICE_TYPE_CONFIG for any service
 *  that has no row in the table. Components never need to null-check. */
export function configFor(
  serviceType: string | null | undefined,
  map: Record<string, ServiceTypeWidgetConfig> | null,
): ServiceTypeWidgetConfig {
  if (!serviceType || !map) return DEFAULT_SERVICE_TYPE_CONFIG;
  return map[serviceType] ?? DEFAULT_SERVICE_TYPE_CONFIG;
}

// ── Admin read + write ──────────────────────────────────────────────────────
// Admin → Widget → Service-type settings consumes this. Reads via the
// underlying table (staff-authenticated select policy) rather than the
// view so subsequent writes line up with whatever just rendered.

interface AdminResult {
  data: Record<string, ServiceTypeWidgetConfig> | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useAdminServiceTypeConfig(): AdminResult {
  const [data, setData] = useState<Record<string, ServiceTypeWidgetConfig> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (tick === 0) setLoading(true);
      const { data: rows, error: err } = await supabase
        .from('lng_service_type_widget_config')
        .select('service_type, request_smile_photos, show_upgrades');
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const out: Record<string, ServiceTypeWidgetConfig> = {};
      for (const row of (rows ?? []) as RawRow[]) {
        out[row.service_type] = {
          request_smile_photos: row.request_smile_photos,
          show_upgrades: row.show_upgrades,
        };
      }
      setData(out);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refresh };
}

/** Upsert a service-type's config. Inserts on first touch, updates
 *  thereafter. Returns the saved row so the caller can rely on a
 *  fresh round-trip rather than optimistically guessing. */
export async function saveServiceTypeConfig(input: {
  service_type: BookingServiceType;
  request_smile_photos?: boolean;
  show_upgrades?: boolean;
}): Promise<ServiceTypeWidgetConfig> {
  const { data: meId } = await supabase.rpc('auth_account_id');
  const updated_by = (meId as string | null) ?? null;

  // We patch onto whatever exists. The DEFAULT_SERVICE_TYPE_CONFIG provides
  // sensible values for fields the caller didn't touch on a row-creating
  // upsert.
  const payload = {
    service_type: input.service_type,
    request_smile_photos:
      input.request_smile_photos ?? DEFAULT_SERVICE_TYPE_CONFIG.request_smile_photos,
    show_upgrades:
      input.show_upgrades ?? DEFAULT_SERVICE_TYPE_CONFIG.show_upgrades,
    updated_at: new Date().toISOString(),
    updated_by,
  };

  const { data, error } = await supabase
    .from('lng_service_type_widget_config')
    .upsert(payload, { onConflict: 'service_type' })
    .select('service_type, request_smile_photos, show_upgrades')
    .single();

  if (error || !data) {
    throw new Error(`Could not save service-type config: ${error?.message ?? 'no row returned'}`);
  }
  const row = data as RawRow;
  return {
    request_smile_photos: row.request_smile_photos,
    show_upgrades: row.show_upgrades,
  };
}
