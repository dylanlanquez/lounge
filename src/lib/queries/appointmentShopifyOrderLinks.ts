import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Appointment ↔ Shopify order reference links.
//
// A link says "this appointment is about this order". It is NOT a payment
// credit — lng_appointments.shopify_order_* stays the single credited order
// for same-day services (see the migration header for why the two are kept
// apart). Voice calls are today's only consumer: the receptionist picks the
// orders the call concerns at booking time, and either side can be changed
// from the appointment page afterwards.
//
// Every link and unlink writes a patient_events row so the appointment
// timeline carries the trail.
// ─────────────────────────────────────────────────────────────────────────────

export interface AppointmentShopifyOrderLink {
  id: string;
  appointment_id: string;
  shopify_order_id: string;
  shopify_order_name: string;
  total_price_pence: number | null;
  currency: string | null;
  linked_at: string;
  linked_by_account_id: string | null;
}

// What the caller hands us to link. Mirrors the shape the patient's order
// list (usePatientShopifyOrders) already returns, converted to pence.
export interface ShopifyOrderToLink {
  id: string;
  name: string;
  totalPricePence: number | null;
  currency: string | null;
}

const TABLE = 'lng_appointment_shopify_order_links';

// The table is new, so a deploy running against a database that hasn't
// taken the migration yet must degrade to "no links" rather than throw a
// red banner over the whole appointment page. Same posture the patient
// Shopify card already takes for its RPC.
function isMissingTable(code: string | undefined): boolean {
  return code === '42P01' || code === 'PGRST205';
}

export function useAppointmentShopifyOrderLinks(appointmentId: string | null | undefined): {
  data: AppointmentShopifyOrderLink[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [data, setData] = useState<AppointmentShopifyOrderLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading(appointmentId);

  useEffect(() => {
    if (!appointmentId) {
      setData([]);
      setError(null);
      settle();
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from(TABLE)
        .select(
          'id, appointment_id, shopify_order_id, shopify_order_name, total_price_pence, currency, linked_at, linked_by_account_id',
        )
        .eq('appointment_id', appointmentId)
        .order('linked_at', { ascending: true });
      if (cancelled) return;
      if (err) {
        if (isMissingTable((err as { code?: string }).code)) {
          setData([]);
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        return;
      }
      setData((rows ?? []) as AppointmentShopifyOrderLink[]);
      setError(null);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [appointmentId, tick, settle]);

  return { data, loading, error, refresh };
}

async function currentAccountId(): Promise<string | null> {
  const { data } = await supabase.rpc('auth_account_id');
  return (data as string | null) ?? null;
}

// Inserts one row per order. Orders already linked to this appointment are
// skipped by the unique constraint rather than erroring the whole batch, so
// a double-submit is harmless.
export async function linkShopifyOrdersToAppointment(input: {
  appointmentId: string;
  patientId: string;
  orders: ShopifyOrderToLink[];
}): Promise<void> {
  if (input.orders.length === 0) return;
  const actorAccountId = await currentAccountId();
  const { data: inserted, error } = await supabase
    .from(TABLE)
    .upsert(
      input.orders.map((o) => ({
        appointment_id: input.appointmentId,
        shopify_order_id: o.id,
        shopify_order_name: o.name,
        total_price_pence: o.totalPricePence,
        currency: o.currency,
        linked_by_account_id: actorAccountId,
      })),
      { onConflict: 'appointment_id,shopify_order_id', ignoreDuplicates: true },
    )
    .select('shopify_order_id, shopify_order_name');
  if (error) {
    throw new Error(`Couldn't attach the order${input.orders.length > 1 ? 's' : ''}: ${error.message}`);
  }

  // Audit — one event per order actually inserted. Best-effort: the links
  // are committed, so a failed event row must not throw the caller back.
  const rows = (inserted ?? []) as Array<{ shopify_order_id: string; shopify_order_name: string }>;
  if (rows.length === 0) return;
  await supabase.from('patient_events').insert(
    rows.map((r) => ({
      patient_id: input.patientId,
      event_type: 'appointment_shopify_order_linked',
      actor_account_id: actorAccountId,
      payload: {
        appointment_id: input.appointmentId,
        shopify_order_id: r.shopify_order_id,
        shopify_order_name: r.shopify_order_name,
      },
    })),
  );
}

export async function unlinkShopifyOrderFromAppointment(input: {
  linkId: string;
  appointmentId: string;
  patientId: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
}): Promise<void> {
  const actorAccountId = await currentAccountId();
  const { error } = await supabase.from(TABLE).delete().eq('id', input.linkId);
  if (error) throw new Error(`Couldn't remove the order: ${error.message}`);
  await supabase.from('patient_events').insert({
    patient_id: input.patientId,
    event_type: 'appointment_shopify_order_unlinked',
    actor_account_id: actorAccountId,
    payload: {
      appointment_id: input.appointmentId,
      shopify_order_id: input.shopifyOrderId,
      shopify_order_name: input.shopifyOrderName,
    },
  });
}

// Shopify reports order totals as a decimal string / number in the store's
// currency. Every Lounge money value is integer pence, so convert once here
// rather than at each call site. Null stays null: a missing total is missing,
// not zero.
export function orderTotalToPence(total: number | null | undefined): number | null {
  if (total === null || total === undefined) return null;
  if (!Number.isFinite(total)) return null;
  return Math.round(total * 100);
}
