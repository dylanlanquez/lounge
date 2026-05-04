import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { axesForService } from './bookingTypeAxes.ts';
import type { BookingServiceType } from './bookingTypes.ts';

// Admin-side reads + writes for the booking widget.
//
// Architecture: the widget renders against existing source-of-truth
// tables. Labels come from `lng_booking_type_config.display_label`,
// prices come from `lwo_catalogue.unit_price` (matched by axes).
// No duplicate columns — the admin tab here flips visibility flags
// and edits widget-only copy (description, deposit), not anything
// the staff app already manages.
//
// This module exposes:
//
//   useWidgetAdminServices()  — every parent booking type with its
//                                widget config + the catalogue
//                                products that belong to it.
//   saveServiceConfig()        — write the widget_visible /
//                                widget_description / widget_deposit
//                                fields back to lng_booking_type_config.
//   saveProductVisibility()    — flip widget_visible on a single
//                                lwo_catalogue row.

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WidgetAdminProduct {
  id: string;
  code: string;
  name: string;
  productKey: string | null;
  repairVariant: string | null;
  unitPricePence: number;
  bothArchesPricePence: number | null;
  archMatch: 'any' | 'single' | 'both';
  widgetVisible: boolean;
}

export interface WidgetAdminService {
  id: string;
  serviceType: string;
  /** display_label, falls back to humanised service_type. */
  label: string;
  durationMinutes: number;
  // Widget-facing fields (live on lng_booking_type_config)
  widgetVisible: boolean;
  widgetDescription: string;
  widgetDepositPence: number;
  /** Axis keys this service supports (registry-driven). Used to
   *  decide whether the product list is even relevant — services
   *  without a product axis don't have a product list. */
  hasProductAxis: boolean;
  /** Catalogue rows for this service. Empty when the service has
   *  no products (e.g. a flat impression appointment). */
  products: WidgetAdminProduct[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Read hook
// ─────────────────────────────────────────────────────────────────────────────

interface ReadResult {
  data: WidgetAdminService[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useWidgetAdminServices(): ReadResult {
  const [data, setData] = useState<WidgetAdminService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // Two reads in parallel: the parent booking-type rows and
      // every catalogue row that COULD belong to one of them.
      // Stitched together below — the catalogue rows are grouped
      // by service_type and attached to the matching service.
      const [btResult, catResult] = await Promise.all([
        supabase
          .from('lng_booking_type_config')
          .select(
            'id, service_type, display_label, duration_default, duration_min, widget_visible, widget_description, widget_deposit_pence',
          )
          .is('repair_variant', null)
          .is('product_key', null)
          .is('arch', null)
          .order('display_label', { ascending: true, nullsFirst: false }),
        supabase
          .from('lwo_catalogue')
          .select(
            'id, code, name, service_type, product_key, repair_variant, unit_price, both_arches_price, arch_match, widget_visible, sort_order',
          )
          .eq('active', true)
          .order('sort_order', { ascending: true })
          .order('name', { ascending: true }),
      ]);
      if (cancelled) return;
      if (btResult.error) {
        setError(btResult.error.message);
        setLoading(false);
        return;
      }
      if (catResult.error) {
        setError(catResult.error.message);
        setLoading(false);
        return;
      }

      // Group catalogue by service_type for O(1) lookup.
      const catByService = new Map<string, WidgetAdminProduct[]>();
      for (const row of (catResult.data ?? []) as Array<{
        id: string;
        code: string;
        name: string;
        service_type: string | null;
        product_key: string | null;
        repair_variant: string | null;
        unit_price: number;
        both_arches_price: number | null;
        arch_match: 'any' | 'single' | 'both';
        widget_visible: boolean;
      }>) {
        if (!row.service_type) continue;
        const list = catByService.get(row.service_type) ?? [];
        list.push({
          id: row.id,
          code: row.code,
          name: row.name,
          productKey: row.product_key,
          repairVariant: row.repair_variant,
          unitPricePence: Math.round(Number(row.unit_price) * 100),
          bothArchesPricePence:
            row.both_arches_price === null ? null : Math.round(Number(row.both_arches_price) * 100),
          archMatch: row.arch_match,
          widgetVisible: row.widget_visible,
        });
        catByService.set(row.service_type, list);
      }

      const services: WidgetAdminService[] = (btResult.data ?? []).map((bt) => {
        const serviceType = (bt.service_type as string) ?? '';
        const axes = axesForService(serviceType as BookingServiceType);
        const hasProductAxis = axes.some((a) => a.key === 'product_key');
        const allProducts = catByService.get(serviceType) ?? [];
        // For services where the axis registry asks for a product,
        // the catalogue row set is THE product list. Services
        // without a product axis (denture_repair has variants;
        // click_in_veneers has just arch; impression has nothing)
        // get an empty product list — the catalogue rows there
        // aren't a "menu of products" the patient picks from,
        // they're the row that gets matched after axes are pinned.
        const products = hasProductAxis ? allProducts : [];
        return {
          id: bt.id as string,
          serviceType,
          label:
            ((bt.display_label as string | null) ?? '').trim() ||
            humanise(serviceType),
          durationMinutes:
            ((bt.duration_default as number | null) ?? (bt.duration_min as number | null) ?? 30),
          widgetVisible: (bt.widget_visible as boolean) ?? false,
          widgetDescription: (bt.widget_description as string | null) ?? '',
          widgetDepositPence: (bt.widget_deposit_pence as number) ?? 0,
          hasProductAxis,
          products,
        };
      });

      setData(services);
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

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

export async function saveServiceConfig(input: {
  id: string;
  widgetVisible: boolean;
  widgetDescription: string;
  widgetDepositPence: number;
}): Promise<void> {
  const { error } = await supabase
    .from('lng_booking_type_config')
    .update({
      widget_visible: input.widgetVisible,
      widget_description: input.widgetDescription.trim() || null,
      widget_deposit_pence: input.widgetDepositPence,
    })
    .eq('id', input.id);
  if (error) throw new Error(`Couldn't save: ${error.message}`);
}

export async function saveProductVisibility(input: {
  id: string;
  widgetVisible: boolean;
}): Promise<void> {
  const { error } = await supabase
    .from('lwo_catalogue')
    .update({ widget_visible: input.widgetVisible })
    .eq('id', input.id);
  if (error) throw new Error(`Couldn't save: ${error.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function humanise(s: string): string {
  if (!s) return 'Untitled';
  return s
    .split('_')
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}
