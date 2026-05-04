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
//                                widget config, the catalogue products
//                                that belong to it, and each product's
//                                catalogue upgrades.
//   saveServiceConfig()        — write the widget_visible /
//                                widget_description / widget_deposit
//                                fields back to lng_booking_type_config.
//   saveProductVisibility()    — flip widget_visible on a single
//                                lwo_catalogue row.
//   saveUpgradeVisibility()    — flip widget_visible on a single
//                                lng_catalogue_upgrades row.

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WidgetAdminUpgrade {
  id: string;
  code: string;
  name: string;
  description: string;
  unitPricePence: number;
  bothArchesPricePence: number | null;
  widgetVisible: boolean;
}

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
  /** Catalogue upgrades attached to this product, in sort_order. */
  upgrades: WidgetAdminUpgrade[];
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
  /** Whether the admin should see a per-option list. True when the
   *  service has an axis that indexes catalogue rows (`product_key`
   *  for same-day-appliance / virtual-impression, `repair_variant`
   *  for denture-repair). False for services where there's only one
   *  catalogue row covering everything (click-in veneers, plain
   *  impression appointment) — the parent visibility toggle is the
   *  whole switch. */
  hasOptions: boolean;
  /** Patient-facing label for the option group. "Repair types" for
   *  denture_repair, "Products" for product_key axes. */
  optionsLabel: string;
  /** Catalogue rows for this service. Empty when the service has
   *  no axis-indexed rows (a flat single-row service). */
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
      const [btResult, catResult, upgradeResult] = await Promise.all([
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
        supabase
          .from('lng_catalogue_upgrades')
          .select(
            'id, code, name, description, catalogue_id, price, both_arches_price, widget_visible, sort_order',
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
      if (upgradeResult.error) {
        setError(upgradeResult.error.message);
        setLoading(false);
        return;
      }

      // Group upgrades by their parent catalogue row id, so each
      // product gets its upgrade list attached on a single pass.
      const upgradesByCatId = new Map<string, WidgetAdminUpgrade[]>();
      for (const row of (upgradeResult.data ?? []) as Array<{
        id: string;
        code: string;
        name: string;
        description: string | null;
        catalogue_id: string;
        price: number;
        both_arches_price: number | null;
        widget_visible: boolean;
      }>) {
        const list = upgradesByCatId.get(row.catalogue_id) ?? [];
        list.push({
          id: row.id,
          code: row.code,
          name: row.name,
          description: row.description ?? '',
          unitPricePence: Math.round(Number(row.price) * 100),
          bothArchesPricePence:
            row.both_arches_price === null ? null : Math.round(Number(row.both_arches_price) * 100),
          widgetVisible: row.widget_visible,
        });
        upgradesByCatId.set(row.catalogue_id, list);
      }

      // Group catalogue by service_type for O(1) lookup, attaching
      // upgrades to each product as we go.
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
          upgrades: upgradesByCatId.get(row.id) ?? [],
        });
        catByService.set(row.service_type, list);
      }

      const services: WidgetAdminService[] = (btResult.data ?? []).map((bt) => {
        const serviceType = (bt.service_type as string) ?? '';
        const axes = axesForService(serviceType as BookingServiceType);
        // Any axis that drills into catalogue rows — product_key
        // (same-day appliance, virtual impression) or repair_variant
        // (denture repair) — gives the admin a per-option list to
        // tick on/off. arch alone doesn't, because arch is encoded
        // on a single catalogue row via arch_match (the patient
        // picks at booking time, not the admin).
        const catalogueAxis =
          axes.find((a) => a.key === 'product_key') ??
          axes.find((a) => a.key === 'repair_variant') ??
          null;
        const allProducts = catalogueAxis
          ? (catByService.get(serviceType) ?? []).filter((p) =>
              catalogueAxis.key === 'product_key'
                ? p.productKey !== null
                : p.repairVariant !== null,
            )
          : [];
        const hasOptions = allProducts.length > 1;
        const optionsLabel =
          catalogueAxis?.key === 'repair_variant'
            ? 'Repair types'
            : catalogueAxis?.key === 'product_key'
              ? 'Products'
              : 'Options';
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
          hasOptions,
          optionsLabel,
          products: allProducts,
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

export async function saveUpgradeVisibility(input: {
  id: string;
  widgetVisible: boolean;
}): Promise<void> {
  const { error } = await supabase
    .from('lng_catalogue_upgrades')
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
