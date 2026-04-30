import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { formatPence } from './carts.ts';
import { useRealtimeRefresh } from '../useRealtimeRefresh.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';

// ─────────────────────────────────────────────────────────────────────────────
// useVisitTimeline — derives a sorted, deduplicated audit-trail event
// stream for a visit by querying the source-of-truth tables in
// parallel and merging them by timestamp. There is no separate
// timeline table; that's a deliberate architectural choice — the
// existing tables already carry the right timestamps and actor FKs
// (lng_visits.receptionist_id, lng_payments.taken_by,
// lng_waiver_signatures.witnessed_by, patient_events.actor_account_id),
// so derive instead of denormalise.
//
// Actor resolution: every fetcher returns a RawEvent that carries the
// actor's account id (when the source row records one). After all
// fetches complete, we batch-load the matching accounts in a single
// round trip and attach `actor` (display name) to each event. This
// keeps the renderer dumb and avoids N+1 queries.
// ─────────────────────────────────────────────────────────────────────────────

export type TimelineEventType =
  | 'appointment_created'
  | 'deposit_paid'
  | 'visit_opened'
  | 'visit_closed'
  | 'jb_assigned'
  | 'jb_freed'
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
  // Display name of the staff member responsible for the event, when
  // the source row records one. The renderer surfaces this as a
  // subtle "by Dylan Lane" suffix beneath the title.
  actor?: string;
  hint: 'calendar' | 'cart' | 'check' | 'signature' | 'card' | 'flag' | 'box';
}

// Internal shape used by the fetchers — same as TimelineEvent but
// carries the actor's raw account id so the resolver can swap it for
// a display name in one batch query.
type RawTimelineEvent = Omit<TimelineEvent, 'actor'> & {
  actorAccountId?: string | null;
};

interface AppointmentRow {
  id: string;
  source: string;
  created_at: string;
  start_at: string;
  calendly_event_uri: string | null;
  deposit_pence: number | null;
  deposit_provider: string | null;
  deposit_paid_at: string | null;
  event_type_label: string | null;
  appointment_ref: string | null;
}

interface VisitRow {
  id: string;
  patient_id: string;
  appointment_id: string | null;
  arrival_type: 'walk_in' | 'scheduled';
  receptionist_id: string | null;
  opened_at: string;
  closed_at: string | null;
  jb_ref: string | null;
}

interface WaiverSignatureRow {
  id: string;
  section_key: string;
  section_version: string;
  signed_at: string;
  witnessed_by: string | null;
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
  line_total_pence: number;
  arch: 'upper' | 'lower' | 'both' | null;
  shade: string | null;
  notes: string | null;
  created_at: string;
}

interface PaymentRow {
  id: string;
  method: string;
  payment_journey: string;
  amount_pence: number;
  status: string;
  succeeded_at: string | null;
  cancelled_at: string | null;
  failure_reason: string | null;
  taken_by: string | null;
  created_at: string;
}

interface PatientEventRow {
  id: string;
  event_type: string;
  notes: string | null;
  payload: Record<string, unknown> | null;
  actor_account_id: string | null;
  created_at: string;
}

interface AccountRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
}

export interface UseVisitTimelineResult {
  events: TimelineEvent[];
  loading: boolean;
  error: string | null;
}

const PENCE = (p: number | null | undefined): string => {
  return formatPence(p ?? 0);
};

const ARCH_LABEL = (a: 'upper' | 'lower' | 'both' | null): string | null => {
  if (a === 'upper') return 'Upper';
  if (a === 'lower') return 'Lower';
  if (a === 'both') return 'Both arches';
  return null;
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  card_terminal: 'card terminal',
  cash: 'cash',
  gift_card: 'gift card',
  account_credit: 'account credit',
};

const PAYMENT_JOURNEY_LABEL: Record<string, string> = {
  standard: 'Standard',
  klarna: 'Klarna',
  clearpay: 'Clearpay',
  klarna_legacy_shopify: 'Klarna (Shopify)',
  clearpay_legacy_shopify: 'Clearpay (Shopify)',
};

const HUMAN_PROVIDER = (p: string | null | undefined): string => {
  if (!p) return '';
  if (p === 'stripe') return 'Stripe';
  if (p === 'paypal') return 'PayPal';
  return p;
};

// Patient_events titles. Anything that already gets surfaced by a
// dedicated stream (deposit_paid, walk_in_arrived) is filtered out
// in fetchPatientEvents — these labels apply to the rest.
const HUMAN_PATIENT_EVENT = (et: string): string => {
  switch (et) {
    case 'patient_registered_from_shopify':
      return 'Patient registered from venneir.com';
    case 'deposit_failed':
      return 'Deposit failed';
    case 'patient_unsuitable_recorded':
      return 'Marked unsuitable';
    case 'patient_unsuitable_reversed':
      return 'Unsuitable reversed';
    case 'cart_line_removed':
      return 'Cart line removed';
    case 'visit_ended_early':
      return 'Visit ended early';
    default:
      return et.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
};

function accountDisplayName(a: AccountRow): string {
  const fn = a.first_name?.trim();
  const ln = a.last_name?.trim();
  if (fn && ln) return `${fn} ${ln}`;
  if (fn) return fn;
  if (ln) return ln;
  return a.name?.trim() ?? '';
}

function joinDetail(...bits: Array<string | null | undefined>): string | undefined {
  const filtered = bits.filter((b): b is string => !!b && b.trim().length > 0);
  return filtered.length > 0 ? filtered.join(' · ') : undefined;
}

// Format the visit's appointment time for the booking-row detail.
// The booking row's *timestamp* is when the booking was created on
// Calendly; the appointment's *start_at* is when the patient is
// expected to arrive — that's the contextually useful fact, so we
// include it in the detail line.
function formatAppointmentSlot(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function useVisitTimeline(visitId: string | null): UseVisitTimelineResult {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading(visitId);

  useEffect(() => {
    if (!visitId) {
      setEvents([]);
      settle();
      setError(null);
      return;
    }
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        // Step 1: fetch the visit row to know its patient + appointment +
        // receptionist (for the arrival event's actor).
        const { data: visitRaw, error: visitErr } = await supabase
          .from('lng_visits')
          .select(
            'id, patient_id, appointment_id, arrival_type, receptionist_id, opened_at, closed_at, jb_ref'
          )
          .eq('id', visitId)
          .maybeSingle();
        if (visitErr) throw new Error(visitErr.message);
        if (!visitRaw) {
          if (!cancelled) {
            setEvents([]);
            settle();
          }
          return;
        }
        const visit = visitRaw as VisitRow;

        // Step 2: fetch every supporting source in parallel. Each
        // promise resolves to its own array of RawTimelineEvent.
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

        // Step 3: visit-level events (open / close + JB lifecycle).
        const visitOwnEvents: RawTimelineEvent[] = [
          {
            id: `visit-${visit.id}-opened`,
            type: 'visit_opened',
            timestamp: visit.opened_at,
            title:
              visit.arrival_type === 'walk_in'
                ? 'Walk-in arrived'
                : 'Patient checked in',
            actorAccountId: visit.receptionist_id,
            hint: 'check',
          },
        ];
        // JB lifecycle. The visit's jb_ref column is captured at
        // insert time and is immutable, so it survives the
        // close-time clearing of the source rows. Render an
        // "assigned" event at the visit's open and (when the visit
        // is closed) a matching "freed" event at the close, so
        // staff can read the JB's whole lifetime in one pass.
        if (visit.jb_ref) {
          visitOwnEvents.push({
            id: `visit-${visit.id}-jb-assigned`,
            type: 'jb_assigned',
            timestamp: visit.opened_at,
            title: 'Job box assigned',
            detail: `JB${visit.jb_ref}`,
            hint: 'box',
          });
          if (visit.closed_at) {
            visitOwnEvents.push({
              id: `visit-${visit.id}-jb-freed`,
              type: 'jb_freed',
              timestamp: visit.closed_at,
              title: 'Job box freed',
              detail: `JB${visit.jb_ref} is available again`,
              hint: 'box',
            });
          }
        }
        if (visit.closed_at) {
          visitOwnEvents.push({
            id: `visit-${visit.id}-closed`,
            type: 'visit_closed',
            timestamp: visit.closed_at,
            title: 'Visit closed',
            hint: 'flag',
          });
        }

        const allRaw: RawTimelineEvent[] = [
          ...appointmentEvents,
          ...visitOwnEvents,
          ...waiverEvents,
          ...cartItemEvents,
          ...paymentEvents,
          ...patientEvents,
        ];

        // Step 4: resolve actor names in one batched query, then attach.
        const actorIds = Array.from(
          new Set(
            allRaw
              .map((e) => e.actorAccountId)
              .filter((id): id is string => !!id)
          )
        );
        const nameById = await fetchAccountNames(actorIds);

        const resolved: TimelineEvent[] = allRaw.map((raw) => {
          const { actorAccountId, ...rest } = raw;
          const actor = actorAccountId ? nameById.get(actorAccountId) : undefined;
          return actor ? { ...rest, actor } : rest;
        });

        resolved.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        if (!cancelled) {
          setEvents(resolved);
          settle();
        }
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load timeline');
        settle();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visitId, tick, settle]);

  // Visit timeline aggregates from many sources. We don't try to be
  // surgical here — any change to any source table refetches and
  // re-merges. lng_visits covers JB lifecycle + close; lng_payments
  // covers terminal events; lng_cart_items covers line edits; the
  // patient_events table covers waiver/deposit/no-show events; and
  // lng_appointments covers status flips that the timeline surfaces
  // as "Booked" / "Rescheduled" entries.
  useRealtimeRefresh(
    visitId
      ? [
          { table: 'lng_visits', filter: `id=eq.${visitId}` },
          { table: 'lng_payments' },
          { table: 'lng_cart_items' },
          { table: 'patient_events' },
          { table: 'lng_appointments' },
          { table: 'lng_waiver_signatures' },
        ]
      : [],
    refresh,
  );

  return { events, loading, error };
}

async function fetchAccountNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { data, error: err } = await supabase
    .from('accounts')
    .select('id, first_name, last_name, name')
    .in('id', ids);
  if (err) throw new Error(err.message);
  for (const row of (data ?? []) as AccountRow[]) {
    const display = accountDisplayName(row);
    if (display) out.set(row.id, display);
  }
  return out;
}

async function fetchAppointmentEvents(
  visit: VisitRow
): Promise<RawTimelineEvent[]> {
  if (!visit.appointment_id) return [];
  const { data, error: err } = await supabase
    .from('lng_appointments')
    .select(
      'id, source, created_at, start_at, calendly_event_uri, deposit_pence, deposit_provider, deposit_paid_at, event_type_label, appointment_ref'
    )
    .eq('id', visit.appointment_id)
    .maybeSingle();
  if (err) throw new Error(err.message);
  if (!data) return [];
  const appt = data as AppointmentRow;
  const out: RawTimelineEvent[] = [];
  out.push({
    id: `appt-${appt.id}-created`,
    type: 'appointment_created',
    timestamp: appt.created_at,
    title: appt.calendly_event_uri
      ? 'Appointment booked on Calendly'
      : 'Appointment created',
    detail: joinDetail(
      appt.event_type_label,
      `scheduled ${formatAppointmentSlot(appt.start_at)}`,
      appt.appointment_ref
    ),
    hint: 'calendar',
  });
  if (appt.deposit_paid_at && appt.deposit_pence) {
    out.push({
      id: `appt-${appt.id}-deposit`,
      type: 'deposit_paid',
      timestamp: appt.deposit_paid_at,
      title: 'Deposit paid',
      detail: joinDetail(
        PENCE(appt.deposit_pence),
        appt.deposit_provider ? `via ${HUMAN_PROVIDER(appt.deposit_provider)}` : null
      ),
      hint: 'card',
    });
  }
  return out;
}

async function fetchWaiverEvents(visit: VisitRow): Promise<RawTimelineEvent[]> {
  // Waiver signatures are scoped to patient + visit. Pull every signature
  // for this patient since the visit opened (covers signatures captured
  // during arrival even though visit_id might be null on the row at sign
  // time — Lounge writes both patient_id and visit_id).
  const { data: sigs, error: sigErr } = await supabase
    .from('lng_waiver_signatures')
    .select('id, section_key, section_version, signed_at, witnessed_by')
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
    detail: joinDetail(
      titleByKey.get(s.section_key) ?? s.section_key,
      `version ${s.section_version}`
    ),
    actorAccountId: s.witnessed_by,
    hint: 'signature' as const,
  }));
}

async function fetchCartItemEvents(visitId: string): Promise<RawTimelineEvent[]> {
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
    .select(
      'id, name, quantity, unit_price_pence, line_total_pence, arch, shade, notes, created_at'
    )
    .eq('cart_id', (cart as { id: string }).id)
    .order('created_at', { ascending: true });
  if (itemErr) throw new Error(itemErr.message);
  const rows = (items ?? []) as CartItemEventRow[];
  return rows.map((it) => {
    const archLabel = ARCH_LABEL(it.arch);
    // For multi-quantity items show "£99.00 (2 × £49.50)" so the
    // receptionist can sanity-check both totals at a glance. Shade
    // and arch surface as their own bits; the operator note rides
    // on the end if present, since it's free-text and might be long.
    const totalsBit =
      it.quantity > 1
        ? `${PENCE(it.line_total_pence)} (${it.quantity} × ${PENCE(it.unit_price_pence)})`
        : PENCE(it.line_total_pence);
    return {
      id: `item-${it.id}`,
      type: 'cart_item_added' as const,
      timestamp: it.created_at,
      title: `Added ${it.name}`,
      detail: joinDetail(
        totalsBit,
        archLabel,
        it.shade ? `shade ${it.shade}` : null,
        it.notes
      ),
      hint: 'cart' as const,
    };
  });
}

async function fetchPaymentEvents(visitId: string): Promise<RawTimelineEvent[]> {
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
      'id, method, payment_journey, amount_pence, status, succeeded_at, cancelled_at, failure_reason, taken_by, created_at'
    )
    .eq('cart_id', (cart as { id: string }).id)
    .order('created_at', { ascending: true });
  if (payErr) throw new Error(payErr.message);
  const rows = (payments ?? []) as PaymentRow[];
  const out: RawTimelineEvent[] = [];
  for (const p of rows) {
    const methodLabel = PAYMENT_METHOD_LABEL[p.method] ?? p.method;
    const journeyLabel = PAYMENT_JOURNEY_LABEL[p.payment_journey] ?? null;
    const journeyBit = journeyLabel && journeyLabel !== 'Standard' ? journeyLabel : null;
    if (p.succeeded_at) {
      out.push({
        id: `payment-${p.id}-success`,
        type: 'payment_succeeded',
        timestamp: p.succeeded_at,
        title: 'Payment captured',
        detail: joinDetail(PENCE(p.amount_pence), `via ${methodLabel}`, journeyBit),
        actorAccountId: p.taken_by,
        hint: 'card',
      });
    } else if (p.cancelled_at) {
      out.push({
        id: `payment-${p.id}-cancelled`,
        type: 'payment_failed',
        timestamp: p.cancelled_at,
        title: 'Payment cancelled',
        detail: joinDetail(PENCE(p.amount_pence), `via ${methodLabel}`, p.failure_reason),
        actorAccountId: p.taken_by,
        hint: 'card',
      });
    } else if (p.status === 'failed') {
      out.push({
        id: `payment-${p.id}-failed`,
        type: 'payment_failed',
        timestamp: p.created_at,
        title: 'Payment failed',
        detail: joinDetail(PENCE(p.amount_pence), `via ${methodLabel}`, p.failure_reason),
        actorAccountId: p.taken_by,
        hint: 'card',
      });
    }
    // Pending payments aren't surfaced — the timeline shows what
    // happened, not what's in flight.
  }
  return out;
}

async function fetchPatientEvents(visit: VisitRow): Promise<RawTimelineEvent[]> {
  // Catch-all stream of patient_events fired by other surfaces
  // (deposit_paid, deposit_failed, walk_in_arrived, registrations).
  // Filter to a 90-day buffer so a deposit recorded long before
  // arrival still shows; older noise is cut off.
  const buffer = new Date(visit.opened_at).getTime() - 1000 * 60 * 60 * 24 * 90;
  const sinceISO = new Date(buffer).toISOString();
  const { data, error: err } = await supabase
    .from('patient_events')
    .select('id, event_type, notes, payload, actor_account_id, created_at')
    .eq('patient_id', visit.patient_id)
    .gte('created_at', sinceISO)
    .order('created_at', { ascending: true });
  if (err) throw new Error(err.message);
  const rows = (data ?? []) as PatientEventRow[];
  // De-dup against the dedicated event types we already emit:
  //   • deposit_paid    -> via lng_appointments.deposit_paid_at
  //   • walk_in_arrived -> via lng_visits.opened_at + arrival_type
  //   • visit_closed    -> via lng_visits.closed_at
  // The patient_events writes for these still happen (Meridian and
  // other off-app consumers depend on them); we just don't surface
  // them in the timeline twice.
  const skip = new Set(['deposit_paid', 'walk_in_arrived', 'visit_closed']);
  return rows
    .filter((r) => !skip.has(r.event_type))
    .map((r) => ({
      id: `patient-event-${r.id}`,
      type: 'patient_event' as const,
      timestamp: r.created_at,
      title: HUMAN_PATIENT_EVENT(r.event_type),
      detail: composePatientEventDetail(r),
      actorAccountId: r.actor_account_id,
      hint: 'flag' as const,
    }));
}

// Compose the detail line for a generic patient_events row. Where
// the payload has structured fields, prefer those over the verbose
// `notes` text — the actor name will be rendered separately as a
// "by Dylan Lane" suffix, so a notes string like "Dylan Lane
// registered Shopify customer X as a new patient" would just
// duplicate it.
function composePatientEventDetail(row: PatientEventRow): string | undefined {
  const payload = row.payload ?? {};
  if (row.event_type === 'patient_registered_from_shopify') {
    const id = typeof payload.shopify_customer_id === 'string'
      ? payload.shopify_customer_id
      : null;
    return id ? `Shopify customer ${id}` : undefined;
  }
  if (row.event_type === 'patient_unsuitable_recorded') {
    // Reason is the headline information here; the row.notes column
    // also carries it so a downstream consumer that ignores the
    // payload still has the text.
    const reason = typeof payload.reason === 'string' ? payload.reason : row.notes ?? null;
    return reason && reason.trim().length > 0 ? reason : undefined;
  }
  if (row.event_type === 'visit_ended_early') {
    // Surface the reason category as the headline detail. Note text
    // (when present) follows.
    const reason = typeof payload.reason === 'string' ? payload.reason : null;
    const label =
      reason === 'patient_declined'
        ? 'Patient declined'
        : reason === 'patient_walked_out'
          ? 'Patient walked out'
          : reason === 'wrong_booking'
            ? 'Wrong booking'
            : reason === 'other'
              ? 'Other'
              : null;
    const note = typeof payload.note === 'string' && payload.note.trim().length > 0 ? payload.note : null;
    if (label && note) return `${label}. ${note}`;
    return label ?? note ?? undefined;
  }
  if (row.event_type === 'cart_line_removed') {
    // Surface the reason category and any free-text note so the
    // timeline reads as the audit it is. Categories: mistake,
    // changed_mind, unsuitable. Free-text note appended when present.
    const reason = typeof payload.reason === 'string' ? payload.reason : null;
    const label =
      reason === 'mistake'
        ? 'Added by mistake'
        : reason === 'changed_mind'
          ? 'Patient changed mind'
          : reason === 'unsuitable'
            ? 'Patient unsuitable'
            : null;
    const note = typeof payload.note === 'string' && payload.note.trim().length > 0 ? payload.note : null;
    if (label && note) return `${label}. ${note}`;
    if (label) return label;
    return note ?? undefined;
  }
  // Fall back to the row's free-text notes for unrecognised events.
  return row.notes ?? undefined;
}
