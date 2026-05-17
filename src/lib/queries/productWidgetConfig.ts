import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { logFailure } from '../failureLog.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Per-product widget config (lng_product_widget_config).
//
// Keyed on (service_type, product_key) to match the catalogue grain.
// Same-day-appliance has retainer / night_guard / day_guard / aligner /
// missing_tooth / whitening_kit / whitening_tray as products; click-in
// veneers has click_in_veneers as its single product. Services without
// a product axis (denture_repair, impression_appointment, etc.) carry
// no rows here.
//
// Toggles:
//   • request_smile_photos — drives the widget success-screen photo
//     intake AND the staff appointment / visit Smile photos card.
//   • show_upgrades        — gates the widget's Optional extras step
//                            at the product level.
//
// The hooks return a flat Map keyed by `${service_type}|${product_key}`
// so consumers do one cheap lookup per render. configFor() handles
// missing rows by returning the defaults — consumers never null-check.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductWidgetConfig {
  request_smile_photos: boolean;
  show_upgrades: boolean;
}

export const DEFAULT_PRODUCT_CONFIG: ProductWidgetConfig = {
  request_smile_photos: false,
  show_upgrades: true,
};

interface RawRow {
  service_type: string;
  product_key: string;
  request_smile_photos: boolean;
  show_upgrades: boolean;
}

function makeKey(serviceType: string | null | undefined, productKey: string | null | undefined): string {
  return `${serviceType ?? ''}|${productKey ?? ''}`;
}

/** Defaulted lookup. Returns DEFAULT_PRODUCT_CONFIG when no matching
 *  row exists or the service is unknown.
 *
 *  Three lookup shapes:
 *
 *    1. (service_type, product_key) — direct hit. Used by every
 *       multi-product service (same_day_appliance, impression_
 *       appointment, virtual_impression_appointment) where the
 *       widget flow always pins product_key as part of the axis
 *       walk.
 *
 *    2. (service_type, productKey=null) — single-product service
 *       lookup. Click-in veneers declares only the arch axis, so the
 *       widget never pins state.axes.product_key. The catalogue +
 *       product-config rows still carry product_key='click_in_veneers'
 *       (one row per service), so we fall back to the unique row for
 *       this service when productKey isn't supplied. This is what
 *       was missing — the admin toggle was correctly writing
 *       (click_in_veneers, click_in_veneers) but the widget passed
 *       productKey=null and got the default back.
 *
 *    3. Multi-product service called with productKey=null — returns
 *       DEFAULT. We deliberately don't guess a product when the
 *       service has >1 configured entries; the right toggle isn't
 *       knowable without the product axis. The widget flow always
 *       reaches this point with productKey populated, so this branch
 *       is only hit during pre-axis transients.
 */
export function configFor(
  serviceType: string | null | undefined,
  productKey: string | null | undefined,
  map: Record<string, ProductWidgetConfig> | null,
): ProductWidgetConfig {
  if (!serviceType || !map) return DEFAULT_PRODUCT_CONFIG;
  if (productKey) {
    return map[makeKey(serviceType, productKey)] ?? DEFAULT_PRODUCT_CONFIG;
  }
  // No productKey supplied. Walk the map for entries matching this
  // service_type — when exactly one exists, it's the single-product
  // service and we use it. When zero or more than one match, return
  // the default rather than guess.
  const prefix = `${serviceType}|`;
  let only: ProductWidgetConfig | null = null;
  let matches = 0;
  for (const key of Object.keys(map)) {
    if (key.startsWith(prefix)) {
      matches++;
      if (matches > 1) return DEFAULT_PRODUCT_CONFIG;
      only = map[key] ?? null;
    }
  }
  return matches === 1 && only ? only : DEFAULT_PRODUCT_CONFIG;
}

// ── Anon-readable widget consumer ───────────────────────────────────────────

interface PublicResult {
  data: Record<string, ProductWidgetConfig> | null;
  loading: boolean;
  error: string | null;
}

export function useWidgetProductConfig(): PublicResult {
  const [data, setData] = useState<Record<string, ProductWidgetConfig> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('lng_widget_product_config')
        .select('service_type, product_key, request_smile_photos, show_upgrades');
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        await logFailure({
          source: 'widget.product_config',
          severity: 'error',
          message: err.message,
          context: {},
        });
        return;
      }
      const out: Record<string, ProductWidgetConfig> = {};
      for (const row of (rows ?? []) as RawRow[]) {
        out[makeKey(row.service_type, row.product_key)] = {
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

// ── Admin / staff read + write ──────────────────────────────────────────────

interface AdminResult {
  data: Record<string, ProductWidgetConfig> | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useAdminProductConfig(): AdminResult {
  const [data, setData] = useState<Record<string, ProductWidgetConfig> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (tick === 0) setLoading(true);
      const { data: rows, error: err } = await supabase
        .from('lng_product_widget_config')
        .select('service_type, product_key, request_smile_photos, show_upgrades');
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const out: Record<string, ProductWidgetConfig> = {};
      for (const row of (rows ?? []) as RawRow[]) {
        out[makeKey(row.service_type, row.product_key)] = {
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

/** Upsert one product's config. Inserts on first touch, updates
 *  thereafter. The DEFAULT_PRODUCT_CONFIG provides sensible values
 *  for fields the caller didn't touch on a row-creating upsert. */
export async function saveProductConfig(input: {
  service_type: string;
  product_key: string;
  request_smile_photos?: boolean;
  show_upgrades?: boolean;
}): Promise<ProductWidgetConfig> {
  const { data: meId } = await supabase.rpc('auth_account_id');
  const updated_by = (meId as string | null) ?? null;

  const payload = {
    service_type: input.service_type,
    product_key: input.product_key,
    request_smile_photos:
      input.request_smile_photos ?? DEFAULT_PRODUCT_CONFIG.request_smile_photos,
    show_upgrades: input.show_upgrades ?? DEFAULT_PRODUCT_CONFIG.show_upgrades,
    updated_at: new Date().toISOString(),
    updated_by,
  };

  const { data, error } = await supabase
    .from('lng_product_widget_config')
    .upsert(payload, { onConflict: 'service_type,product_key' })
    .select('service_type, product_key, request_smile_photos, show_upgrades')
    .single();

  if (error || !data) {
    throw new Error(`Could not save product config: ${error?.message ?? 'no row returned'}`);
  }
  const row = data as RawRow;
  return {
    request_smile_photos: row.request_smile_photos,
    show_upgrades: row.show_upgrades,
  };
}
