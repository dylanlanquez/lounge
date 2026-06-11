import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// useAppointmentItems — read the multi-item product bag a Checkpoint
// booking attached to an appointment (lng_appointment_items + their
// per-item upgrades). Empty for widget bookings and any appointment that
// wasn't booked through Checkpoint's bag flow.
//
// Two consumers:
//   • Arrival — prefills the staging basket so the booked bag flows
//     straight into the cart when the customer is marked arrived,
//     instead of the receptionist re-picking every line by hand.
//   • AppointmentDetail — renders the planned bag for the floor team.

export interface AppointmentItemUpgradeRow {
  id: string;
  upgradeId: string;
  upgradeCode: string;
  name: string;
  unitPricePence: number;
  bothArchesPricePence: number | null;
  resolvedPricePence: number;
}

export interface AppointmentItemRow {
  id: string;
  catalogueId: string | null;
  serviceType: string;
  productKey: string | null;
  name: string;
  arch: 'upper' | 'lower' | 'both' | null;
  shade: string | null;
  thickness: string | null;
  quantity: number;
  unitPricePence: number;
  lineTotalPence: number;
  priceShown: boolean;
  sortOrder: number;
  upgrades: AppointmentItemUpgradeRow[];
}

const ITEMS_SELECT =
  'id, catalogue_id, service_type, product_key, name, arch, shade, thickness, quantity, unit_price_pence, line_total_pence, price_shown, sort_order, ' +
  'upgrades:lng_appointment_item_upgrades ( id, upgrade_id, upgrade_code, name, unit_price_pence, both_arches_price_pence, resolved_price_pence )';

interface RawItem {
  id: string;
  catalogue_id: string | null;
  service_type: string;
  product_key: string | null;
  name: string;
  arch: 'upper' | 'lower' | 'both' | null;
  shade: string | null;
  thickness: string | null;
  quantity: number;
  unit_price_pence: number;
  line_total_pence: number;
  price_shown: boolean;
  sort_order: number;
  upgrades:
    | Array<{
        id: string;
        upgrade_id: string;
        upgrade_code: string;
        name: string;
        unit_price_pence: number;
        both_arches_price_pence: number | null;
        resolved_price_pence: number;
      }>
    | null;
}

function mapItem(r: RawItem): AppointmentItemRow {
  return {
    id: r.id,
    catalogueId: r.catalogue_id,
    serviceType: r.service_type,
    productKey: r.product_key,
    name: r.name,
    arch: r.arch,
    shade: r.shade,
    thickness: r.thickness,
    quantity: r.quantity,
    unitPricePence: r.unit_price_pence,
    lineTotalPence: r.line_total_pence,
    priceShown: r.price_shown,
    sortOrder: r.sort_order,
    upgrades: (r.upgrades ?? []).map((u) => ({
      id: u.id,
      upgradeId: u.upgrade_id,
      upgradeCode: u.upgrade_code,
      name: u.name,
      unitPricePence: u.unit_price_pence,
      bothArchesPricePence: u.both_arches_price_pence,
      resolvedPricePence: u.resolved_price_pence,
    })),
  };
}

export interface UseAppointmentItemsResult {
  items: AppointmentItemRow[];
  loading: boolean;
  error: string | null;
}

export function useAppointmentItems(
  appointmentId: string | null | undefined,
): UseAppointmentItemsResult {
  const [items, setItems] = useState<AppointmentItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!appointmentId) {
      setItems([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error: err } = await supabase
        .from('lng_appointment_items')
        .select(ITEMS_SELECT)
        .eq('appointment_id', appointmentId)
        .order('sort_order', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setItems([]);
        setLoading(false);
        return;
      }
      setItems(((data ?? []) as unknown as RawItem[]).map(mapItem));
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [appointmentId]);

  return { items, loading, error };
}
