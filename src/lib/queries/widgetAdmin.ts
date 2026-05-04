import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// Admin-side reads + writes for the booking-widget config.
//
// Two separate concerns live here:
//
//   1. Read every parent booking type — visible or not — with its
//      widget_* config in tow, so the admin can flip rows on / off
//      and edit copy.
//   2. Save a row's widget_* fields back to lng_booking_type_config.
//      Admin-only; the table already has a `_admin_write` RLS policy
//      that enforces this server-side.
//
// The widget itself reads from the public lng_widget_booking_types
// view (anon-friendly). This module is the OTHER side of that —
// what the staff use to control what the public sees.

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WidgetAdminBookingType {
  id: string;
  serviceType: string;
  /** Operator-side label — falls back when widget_label is empty. */
  displayLabel: string | null;
  durationMinutes: number;
  // Widget-facing fields
  widgetVisible: boolean;
  widgetLabel: string;
  widgetDescription: string;
  widgetPricePence: number | null;
  widgetDepositPence: number;
  widgetAllowStaffPick: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read hook
// ─────────────────────────────────────────────────────────────────────────────

interface ReadResult {
  data: WidgetAdminBookingType[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useWidgetAdminBookingTypes(): ReadResult {
  const [data, setData] = useState<WidgetAdminBookingType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // Parent rows only — child variants / arches don't surface in
      // the widget. Order alphabetically by display label so the
      // admin sees them in a stable order.
      const { data: rows, error: err } = await supabase
        .from('lng_booking_type_config')
        .select(
          'id, service_type, display_label, duration_default, duration_min, widget_visible, widget_label, widget_description, widget_price_pence, widget_deposit_pence, widget_allow_staff_pick',
        )
        .is('repair_variant', null)
        .is('product_key', null)
        .is('arch', null)
        .order('display_label', { ascending: true, nullsFirst: false });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const shaped: WidgetAdminBookingType[] = (rows ?? []).map((r) => ({
        id: r.id as string,
        serviceType: r.service_type as string,
        displayLabel: (r.display_label as string | null) ?? null,
        durationMinutes:
          ((r.duration_default as number | null) ?? (r.duration_min as number | null) ?? 30),
        widgetVisible: (r.widget_visible as boolean) ?? false,
        widgetLabel: (r.widget_label as string | null) ?? '',
        widgetDescription: (r.widget_description as string | null) ?? '',
        widgetPricePence: (r.widget_price_pence as number | null) ?? null,
        widgetDepositPence: (r.widget_deposit_pence as number) ?? 0,
        widgetAllowStaffPick: (r.widget_allow_staff_pick as boolean) ?? true,
      }));
      setData(shaped);
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
// Save
// ─────────────────────────────────────────────────────────────────────────────

export async function saveWidgetBookingType(input: {
  id: string;
  widgetVisible: boolean;
  widgetLabel: string;
  widgetDescription: string;
  widgetPricePence: number | null;
  widgetDepositPence: number;
  widgetAllowStaffPick: boolean;
}): Promise<void> {
  const { error } = await supabase
    .from('lng_booking_type_config')
    .update({
      widget_visible: input.widgetVisible,
      widget_label: input.widgetLabel.trim() || null,
      widget_description: input.widgetDescription.trim() || null,
      widget_price_pence: input.widgetPricePence,
      widget_deposit_pence: input.widgetDepositPence,
      widget_allow_staff_pick: input.widgetAllowStaffPick,
    })
    .eq('id', input.id);
  if (error) throw new Error(`Couldn't save: ${error.message}`);
}
