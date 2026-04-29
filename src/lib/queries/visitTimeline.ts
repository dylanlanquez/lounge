import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// ─────────────────────────────────────────────────────────────────────────────
// useVisitTimeline — derives a sorted, deduplicated audit-trail event
// stream for a visit by querying the source-of-truth tables in
// parallel and merging them by timestamp. There is no separate
// timeline table; that's a deliberate architectural choice — the
// existing tables already carry the right timestamps (appointment
// created_at, visit opened_at, waiver signatures, cart items,
// payments, patient_events), so derive instead of denormalise.
// ─────────────────────────────────────────────────────────────────────────────

export type TimelineEventType =
  | 'appointment_created'
  | 'deposit_paid'
  | 'visit_opened'
  | 'visit_closed'
  | 'waiver_signed'
  | 'cart_item_added'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'patient_event';

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  timestamp: string; // ISO
  title: string;
  detail?: string;
  // Light metadata for the UI to pick an icon / accent. Keeps
  // rendering decisions out of the data layer.
  hint?: 'calendar' | 'cart' | 'check' | 'signature' | 'card' | 'flag';
}

interface AppointmentRow {
  id: string;
  patient_id: string;
  source: string;
  created_at: string;
  start_at: string;
  calendly_event_uri: string | null;
  deposit_pence: number | null;
  deposit_provider: string | null;
  deposit_paid_at: string | null;
  event_type_label: string | null;
}

interface VisitRow {
  id: string;
  patient_id: string;
  appointment_id: string | null;
  arrival_type: 'walk_in' | 'scheduled';
  opened_at: string;
  closed_at: string | null;
}

interface WaiverSignatureRow {
  id: string;
  section_key: string;
  section_version: string;
  signed_at: string;
}

interface WaiverSectionRow {
  key: string;
  title: string;
}

interface CartItemEventRow {
  id: string;
  name: string;
  quantity: number;
  unit_price_pence: number;
  arch: 'upper' | 'lower' | 'both' | null;
  shade: string | null;
  created_at: string;
}

interface PaymentRow {
  id: string;
  method: string;
  amount_pence: number;
  status: string;
  succeeded_at: string | null;
  cancelled_at: string | null;
  failure_reason: string | null;
  created_at: string;
}

interface PatientEventRow {
  id: string;
  event_type: string;
  notes: string | null;
  payload: unknown;
  created_at: string;
}

export interface UseVisitTimelineResult {
  events: TimelineEvent[];
  loading: boolean;
  error: string | null;
}

const PENCE = (p: number | null | undefined): string => {
  if (p == null) return '£0.00';
  return `£${(p / 100).toFixed(2)}`;
};

const ARCH_LABEL = (a: 'upper' | 'lower' | 'both' | null): string | null => {
  if (a === 'upper') return 'Upper';
  if (a === 'lower') return 'Lower';
  if (a === 'both') return 'Both arches';
  return null;
};

const HUMAN_PROVIDER = (p: string | null | undefined): string => {
  if (!p) return '';
  if (p === 'stripe') return 'Stripe';
  if (p === 'paypal') return 'PayPal';
  return p;
};

const HUMAN_PATIENT_EVENT = (et: string): string => {
  switch (et) {
    case 'patient_registered_from_shopify':
      return 'Patient registered from venneir.com';
    case 'walk_in_arrived':
      return 'Walk-in marked as arrived';
    case 'deposit_paid':
      return 'Deposit recorded';
    case 'deposit_failed':
      return 'Deposit failed';
    default:
      return et.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
};

export function useVisitTimeline(visitId: string | null): UseVisitTimelineResult {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visitId) {
      setEvents([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // Step 1: fetch the visit row to know its patient + appointment.
        const { data: visitRaw, error: visitErr } = await supabase
          .from('lng_visits')
          .select('id, patient_id, appointment_id, arrival_type, opened_at, closed_at')
          .eq('id', visitId)
          .maybeSingle();
        if (visitErr) throw new Error(visitErr.message);
        if (!visitRaw) {
          if (!cancelled) {
            setEvents([]);
            setLoading(false);
          }
          return;
        }
        const visit = visitRaw as VisitRow;

        // Step 2: fetch every supporting source in parallel. Each
        // promise resolves to its own array of TimelineEvent.
        const [
          appointmentEvents,
          waiverEvents,
          cartItemEvents,
          paymentEvents,
          patientEvents,
        ] = await Promise.all([
          fetchAppointmentEvents(visit),
          fetchWaiverEvents(visit),
          fetchCartItemEvents(visit.id),
          fetchPaymentEvents(visit.id),
          fetchPatientEvents(visit),
        ]);

        if (cancelled) return;

        // Step 3: visit-level events (open / close).
        const visitOwnEvents: TimelineEvent[] = [
          {
            id: `visit-${visit.id}-opened`,
            type: 'visit_opened',
            timestamp: visit.opened_at,
            title:
              visit.arrival_type === 'walk_in'
                ? 'Walk-in arrived'
                : 'Patient arrived',
            hint: 'check',
          },
        ];
        if (visit.closed_at) {
          visitOwnEvents.push({
            id: `visit-${visit.id}-closed`,
            type: 'visit_closed',
            timestamp: visit.closed_at,
            title: 'Visit closed',
            hint: 'flag',
          });
        }

        const merged = [
          ...appointmentEvents,
          ...visitOwnEvents,
          ...waiverEvents,
          ...cartItemEvents,
          ...paymentEvents,
          ...patientEvents,
        ];
        merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        if (!cancelled) {
          setEvents(merged);
          setLoading(false);
        }
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load timeline');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visitId]);

  return { events, loading, error };
}

async function fetchAppointmentEvents(visit: VisitRow): Promise<TimelineEvent[]> {
  if (!visit.appointment_id) return [];
  const { data, error: err } = await supabase
    .from('lng_appointments')
    .select(
      'id, patient_id, source, created_at, start_at, calendly_event_uri, deposit_pence, deposit_provider, deposit_paid_at, event_type_label'
    )
    .eq('id', visit.appointment_id)
    .maybeSingle();
  if (err) throw new Error(err.message);
  if (!data) return [];
  const appt = data as AppointmentRow;
  const out: TimelineEvent[] = [];
  out.push({
    id: `appt-${appt.id}-created`,
    type: 'appointment_created',
    timestamp: appt.created_at,
    title: appt.calendly_event_uri
      ? 'Appointment booked on Calendly'
      : 'Appointment created',
    detail: appt.event_type_label ?? undefined,
    hint: 'calendar',
  });
  if (appt.deposit_paid_at && appt.deposit_pence) {
    out.push({
      id: `appt-${appt.id}-deposit`,
      type: 'deposit_paid',
      timestamp: appt.deposit_paid_at,
      title: 'Deposit paid',
      detail: `${PENCE(appt.deposit_pence)} via ${HUMAN_PROVIDER(appt.deposit_provider)}`.trim(),
      hint: 'card',
    });
  }
  return out;
}

async function fetchWaiverEvents(visit: VisitRow): Promise<TimelineEvent[]> {
  // Waiver signatures are scoped to patient + visit. Pull every signature
  // for this patient since the visit opened (covers signatures captured
  // during arrival even though visit_id might be null on the row at sign
  // time — Lounge writes both patient_id and visit_id).
  const { data: sigs, error: sigErr } = await supabase
    .from('lng_waiver_signatures')
    .select('id, section_key, section_version, signed_at')
    .eq('patient_id', visit.patient_id)
    .gte('signed_at', visit.opened_at)
    .order('signed_at', { ascending: true });
  if (sigErr) throw new Error(sigErr.message);
  const sigRows = (sigs ?? []) as WaiverSignatureRow[];
  if (sigRows.length === 0) return [];

  // Resolve section titles in one round trip.
  const keys = Array.from(new Set(sigRows.map((s) => s.section_key)));
  const { data: sections, error: secErr } = await supabase
    .from('lng_waiver_sections')
    .select('key, title')
    .in('key', keys);
  if (secErr) throw new Error(secErr.message);
  const titleByKey = new Map<string, string>();
  for (const s of (sections ?? []) as WaiverSectionRow[]) {
    titleByKey.set(s.key, s.title);
  }

  return sigRows.map((s) => ({
    id: `waiver-${s.id}`,
    type: 'waiver_signed' as const,
    timestamp: s.signed_at,
    title: 'Waiver signed',
    detail: `${titleByKey.get(s.section_key) ?? s.section_key} (v ${s.section_version})`,
    hint: 'signature' as const,
  }));
}

async function fetchCartItemEvents(visitId: string): Promise<TimelineEvent[]> {
  // The cart belongs to the visit (1:1). Resolve its id, then list items.
  const { data: cart, error: cartErr } = await supabase
    .from('lng_carts')
    .select('id')
    .eq('visit_id', visitId)
    .maybeSingle();
  if (cartErr) throw new Error(cartErr.message);
  if (!cart) return [];

  const { data: items, error: itemErr } = await supabase
    .from('lng_cart_items')
    .select('id, name, quantity, unit_price_pence, arch, shade, created_at')
    .eq('cart_id', (cart as { id: string }).id)
    .order('created_at', { ascending: true });
  if (itemErr) throw new Error(itemErr.message);
  const rows = (items ?? []) as CartItemEventRow[];
  return rows.map((it) => {
    const archLabel = ARCH_LABEL(it.arch);
    const detailBits = [
      it.quantity > 1 ? `${it.quantity} ×` : null,
      archLabel,
      it.shade ?? null,
      PENCE(it.unit_price_pence * it.quantity),
    ].filter((b): b is string => !!b);
    return {
      id: `item-${it.id}`,
      type: 'cart_item_added' as const,
      timestamp: it.created_at,
      title: `Added ${it.name}`,
      detail: detailBits.length > 0 ? detailBits.join(' · ') : undefined,
      hint: 'cart' as const,
    };
  });
}

async function fetchPaymentEvents(visitId: string): Promise<TimelineEvent[]> {
  const { data: cart, error: cartErr } = await supabase
    .from('lng_carts')
    .select('id')
    .eq('visit_id', visitId)
    .maybeSingle();
  if (cartErr) throw new Error(cartErr.message);
  if (!cart) return [];

  const { data: payments, error: payErr } = await supabase
    .from('lng_payments')
    .select(
      'id, method, amount_pence, status, succeeded_at, cancelled_at, failure_reason, created_at'
    )
    .eq('cart_id', (cart as { id: string }).id)
    .order('created_at', { ascending: true });
  if (payErr) throw new Error(payErr.message);
  const rows = (payments ?? []) as PaymentRow[];
  const out: TimelineEvent[] = [];
  for (const p of rows) {
    if (p.succeeded_at) {
      out.push({
        id: `payment-${p.id}-success`,
        type: 'payment_succeeded',
        timestamp: p.succeeded_at,
        title: 'Payment captured',
        detail: `${PENCE(p.amount_pence)} via ${HUMAN_PROVIDER(p.method)}`.trim(),
        hint: 'card',
      });
    } else if (p.cancelled_at) {
      out.push({
        id: `payment-${p.id}-cancelled`,
        type: 'payment_failed',
        timestamp: p.cancelled_at,
        title: 'Payment cancelled',
        detail: p.failure_reason ?? undefined,
        hint: 'card',
      });
    } else if (p.status === 'failed') {
      out.push({
        id: `payment-${p.id}-failed`,
        type: 'payment_failed',
        timestamp: p.created_at,
        title: 'Payment failed',
        detail: p.failure_reason ?? undefined,
        hint: 'card',
      });
    }
    // Pending payments aren't surfaced — the timeline shows what
    // happened, not what's in flight.
  }
  return out;
}

async function fetchPatientEvents(visit: VisitRow): Promise<TimelineEvent[]> {
  // Catch-all stream of patient_events fired by other surfaces
  // (deposit_paid, deposit_failed, walk_in_arrived, registrations).
  // Filter to the visit window: from the visit's opened_at minus a
  // small buffer (so a deposit recorded shortly before arrival is
  // included) onwards.
  const buffer = new Date(visit.opened_at).getTime() - 1000 * 60 * 60 * 24 * 90;
  const sinceISO = new Date(buffer).toISOString();
  const { data, error: err } = await supabase
    .from('patient_events')
    .select('id, event_type, notes, payload, created_at')
    .eq('patient_id', visit.patient_id)
    .gte('created_at', sinceISO)
    .order('created_at', { ascending: true });
  if (err) throw new Error(err.message);
  const rows = (data ?? []) as PatientEventRow[];
  // De-dup against the dedicated event types we already emit (deposit
  // paid, walk-in arrived) — surfacing them twice would be noisy.
  const skip = new Set([
    'deposit_paid',
    'walk_in_arrived',
    // patient_registered_from_shopify is a real first-time event we
    // do want to show once, since nothing else surfaces it.
  ]);
  return rows
    .filter((r) => !skip.has(r.event_type))
    .map((r) => ({
      id: `patient-event-${r.id}`,
      type: 'patient_event' as const,
      timestamp: r.created_at,
      title: HUMAN_PATIENT_EVENT(r.event_type),
      detail: r.notes ?? undefined,
      hint: 'flag' as const,
    }));
}
