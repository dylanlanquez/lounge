import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import type {
  AppointmentRepairItemRow,
  AppointmentUpgradeRow,
} from './appointmentDetail.ts';

// useAppointmentExtras — read the patient's widget-side picks (upgrades
// + denture-repair line items) for a given appointment. Mirrors the
// shape useAppointmentDetail already returns inside its bigger row, so
// surfaces that don't otherwise need the full appointment row (most
// notably VisitDetail, which has its own visit-centric fetch) can pull
// just the snapshot tables without rewiring an unrelated query.
//
// Empty arrays for any appointment that didn't ship through the widget,
// or any service that doesn't expose either picker. The mounting
// component (AppointmentExtras) renders nothing in that case.

export interface UseAppointmentExtrasResult {
  upgrades: AppointmentUpgradeRow[];
  repairItems: AppointmentRepairItemRow[];
  loading: boolean;
  error: string | null;
}

export function useAppointmentExtras(
  appointmentId: string | null | undefined,
): UseAppointmentExtrasResult {
  const [upgrades, setUpgrades] = useState<AppointmentUpgradeRow[]>([]);
  const [repairItems, setRepairItems] = useState<AppointmentRepairItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!appointmentId) {
      setUpgrades([]);
      setRepairItems([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const [upRes, repairRes] = await Promise.all([
        supabase
          .from('lng_appointment_upgrade_selections')
          .select('id, upgrade_id, upgrade_code, name, unit_label, unit_price_pence, both_arches_price_pence, resolved_price_pence, created_at')
          .eq('appointment_id', appointmentId)
          .order('created_at', { ascending: true }),
        supabase
          .from('lng_appointment_repair_items')
          .select('id, catalogue_id, code, repair_variant, name, unit_label, arch, quantity, unit_price_pence, both_arches_price_pence, line_total_pence, created_at')
          .eq('appointment_id', appointmentId)
          .order('created_at', { ascending: true }),
      ]);
      if (cancelled) return;
      if (upRes.error || repairRes.error) {
        setError(upRes.error?.message ?? repairRes.error?.message ?? 'Could not load appointment extras');
        setLoading(false);
        return;
      }
      setUpgrades(((upRes.data ?? []) as Array<{
        id: string;
        upgrade_id: string;
        upgrade_code: string;
        name: string;
        unit_label: string | null;
        unit_price_pence: number;
        both_arches_price_pence: number | null;
        resolved_price_pence: number;
        created_at: string;
      }>).map((r) => ({
        id: r.id,
        upgradeId: r.upgrade_id,
        upgradeCode: r.upgrade_code,
        name: r.name,
        unitLabel: r.unit_label,
        unitPricePence: r.unit_price_pence,
        bothArchesPricePence: r.both_arches_price_pence,
        resolvedPricePence: r.resolved_price_pence,
        createdAt: r.created_at,
      })));
      setRepairItems(((repairRes.data ?? []) as Array<{
        id: string;
        catalogue_id: string;
        code: string;
        repair_variant: string;
        name: string;
        unit_label: string | null;
        arch: 'upper' | 'lower' | 'both';
        quantity: number;
        unit_price_pence: number;
        both_arches_price_pence: number | null;
        line_total_pence: number;
        created_at: string;
      }>).map((r) => ({
        id: r.id,
        catalogueId: r.catalogue_id,
        code: r.code,
        repairVariant: r.repair_variant,
        name: r.name,
        unitLabel: r.unit_label,
        arch: r.arch,
        quantity: r.quantity,
        unitPricePence: r.unit_price_pence,
        bothArchesPricePence: r.both_arches_price_pence,
        lineTotalPence: r.line_total_pence,
        createdAt: r.created_at,
      })));
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [appointmentId]);

  return { upgrades, repairItems, loading, error };
}
