import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { logFailure } from '../failureLog.ts';
import type { AppointmentSource } from './appointments.ts';
import type { AppointmentStatus } from '../../components/AppointmentCard/AppointmentCard.tsx';

// Appointment detail — used by /appointment/:id (the Ledger
// click-through for bookings that don't yet have a visit). Returns a
// hydrated row joining patient identity, location, optional staff,
// and the linked visit if one exists. Walk-ins never land here; they
// always have a visit and route to /visit/:id directly.
//
// The hook resolves to one of three states:
//
//   { ok: 'loaded',        appt }    — render the page
//   { ok: 'redirect',      visitId } — visit was created (mark-arrived
//                                       fired or pre-existing visit
//                                       was found); caller should
//                                       navigate to /visit/:id
//   { ok: 'not_found' }              — appointment id doesn't exist
//                                       (or RLS hides it from this
//                                       JWT). Page shows a sensible
//                                       not-found surface.
//
// Failures during the fetch (network, schema mismatch, missing
// patient) are logged to lng_system_failures with the appointment id
// in context and surfaced via the `error` field. The caller renders
// an error panel and the operator can hit Retry.

export interface AppointmentDetailRow {
  id: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  start_at: string;
  end_at: string;
  event_type_label: string | null;
  appointment_ref: string | null;
  jb_ref: string | null;
  cancel_reason: string | null;
  notes: string | null;
  /** Patient-typed widget note. Distinct from `notes` (staff CS
   *  handoff note). Read-only on the staff side. */
  customer_note: string | null;
  reschedule_to_id: string | null;
  staff_account_id: string | null;
  location_id: string;
  patient_id: string;
  // Catalogue key driving every behaviour decision (virtual vs in-
  // person, fulfilment, etc.). Surfaced here so the Generate Meet
  // link retry knows when to offer itself.
  service_type: string | null;
  /** Catalogue axis pins captured at booking time. Together with
   *  service_type they describe the appliance + arch the patient
   *  booked. Used by formatNativeBookingSummary to compose the
   *  hero title (e.g. "Upper Click-in veneers"). Calendly-imported
   *  rows leave these null; the legacy event_type_label path
   *  handles those. */
  product_key: string | null;
  repair_variant: string | null;
  arch: string | null;
  /** Which storefront the booking came from — 'venneir' or
   *  'denture'. Drives the source badge icon + per-brand chrome
   *  on the appointment hero. */
  brand_id: string | null;
  join_url: string | null;
  meeting_platform: string | null;
  // Per-host Meet integration fields. Populated when the appointment
  // was booked through the manual booking flow with a Meet host
  // selected; null for Calendly-imported rows that still go through
  // the legacy service-account google-meet-create (no attendance
  // available for those — they have join_url but no host).
  meet_host_id: string | null;
  meet_space_id: string | null;
  meet_meeting_code: string | null;
  // Captured from Google's conferenceRecords API when meet-fetch-
  // attendance runs. conference_started_at is the smoking-gun signal
  // the verdict line keys on: NULL after end_at = no one ever connected.
  // Always paired with conference_ended_at because Google publishes
  // them together at conference-record creation time (after the
  // meeting closes).
  conference_started_at: string | null;
  conference_ended_at: string | null;
  // Number of distinct Google conferenceRecord rows logged against
  // this appointment's space. Spaces can host more than one conference
  // (rejoin out-of-window, reschedule on the same link); the
  // attendance card surfaces "(N conferences)" when this is > 1.
  conference_count: number;
  // Number of recordings + transcripts Google published for this
  // conference record. Non-zero is unfakeable proof the call took place.
  // 0 is the default until meet-fetch-attendance has run.
  recording_count: number;
  transcript_count: number;
  // Patient's responseStatus on the Calendar invite, pulled by
  // meet-fetch-attendance. One of "accepted", "declined", "tentative",
  // "needsAction", or NULL when no attendee row matches the patient
  // email (or the row predates the column / a Calendar event wasn't
  // created).
  patient_rsvp_status: 'accepted' | 'declined' | 'tentative' | 'needsAction' | null;
  patient_rsvp_updated_at: string | null;
  // Host's google_email at view time, hydrated from lng_meet_hosts via
  // meet_host_id. Surfaced on the Booking details "Join from" row so
  // the patient + receptionist can see whose calendar owns the Meet.
  // Null for legacy / Calendly-imported rows that ran through the
  // service-account flow (those fall back to clinicSettings.virtualHostEmail).
  meet_host_email: string | null;
  intake: ReadonlyArray<{ question: string; answer: string }> | null;
  // Deposit captured at booking time. Null when no deposit was taken
  // (Calendly event without one, or native booking pre-deposit
  // support). Components consume the four fields together so the
  // shape is denormalised here for ease of access.
  deposit_pence: number | null;
  deposit_currency: string | null;
  deposit_provider: 'paypal' | 'stripe' | null;
  deposit_status: 'paid' | 'failed' | null;
  /** TRUE when the customer paid the full price at booking via
   *  the widget's "Pay now" choice. Distinct from deposit_pence —
   *  AppointmentDetail's hero pill + Deposit card flip from
   *  "Deposit paid" → "Paid in full" when this is true. */
  paid_in_full_at_booking: boolean;
  // Shopify-paid online order linked at booking, surfaced as a
  // hero card on the appointment detail page so the receptionist
  // sees at a glance what the customer's already paid for online.
  // shopify_order_id is the raw Shopify numeric id — used to deep-
  // link straight to the order in Shopify admin.
  shopify_order_id: string | null;
  shopify_order_name: string | null;
  shopify_order_total_pence: number | null;
  // Origin attribution for bookings that didn't come from the
  // Lounge app itself. created_via='checkpoint' bookings are made
  // by staff in Checkpoint's ScanView booker on behalf of the
  // patient; the actor field holds the staff member's display name
  // so AppointmentDetail can render the "Booked through Checkpoint
  // by [name]" line. Both null for in-app NewBookingSheet rows.
  created_via: string | null;
  created_via_actor: string | null;
  patient: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    avatar_data: string | null;
    internal_ref: string | null;
    lwo_ref: string | null;
  };
  location: {
    id: string;
    name: string | null;
    address: string | null;
    city: string | null;
    postcode: string | null;
  } | null;
  staff: {
    id: string;
    first_name: string | null;
    last_name: string | null;
  } | null;
  // The linked visit, if one exists. Booked rows pre-arrival have
  // none; arrived/in_progress/complete rows do. The route checks this
  // to decide whether to render or redirect to /visit/:id.
  visit: {
    id: string;
    opened_at: string;
  } | null;
  // Snapshot of the patient's widget-side picks. Empty arrays for
  // bookings that didn't go through the widget (Calendly imports) and
  // for services that don't expose either picker (most services have
  // no upgrades; only denture_repair has repair items).
  upgrades: AppointmentUpgradeRow[];
  repairItems: AppointmentRepairItemRow[];
}

export interface AppointmentUpgradeRow {
  id: string;
  upgradeId: string;
  upgradeCode: string;
  name: string;
  unitLabel: string | null;
  unitPricePence: number;
  bothArchesPricePence: number | null;
  resolvedPricePence: number;
  createdAt: string;
}

export interface AppointmentRepairItemRow {
  id: string;
  catalogueId: string;
  code: string;
  repairVariant: string;
  name: string;
  unitLabel: string | null;
  arch: 'upper' | 'lower' | 'both';
  quantity: number;
  unitPricePence: number;
  bothArchesPricePence: number | null;
  lineTotalPence: number;
  createdAt: string;
}

export type AppointmentDetailResult =
  | { state: 'loading'; data: null; error: null }
  | { state: 'loaded'; data: AppointmentDetailRow; error: null }
  | { state: 'not_found'; data: null; error: null }
  | { state: 'error'; data: null; error: string };

export interface UseAppointmentDetailResult {
  result: AppointmentDetailResult;
  refresh: () => void;
}

interface RawAppointment {
  id: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  start_at: string;
  end_at: string;
  event_type_label: string | null;
  appointment_ref: string | null;
  jb_ref: string | null;
  cancel_reason: string | null;
  notes: string | null;
  /** Patient-typed widget note. Distinct from `notes` (staff CS
   *  handoff note). Read-only on the staff side. */
  customer_note: string | null;
  reschedule_to_id: string | null;
  staff_account_id: string | null;
  location_id: string;
  patient_id: string;
  service_type: string | null;
  /** Catalogue axis pins captured at booking time. Used to compose
   *  a human-readable summary like "Upper Click-in veneers" or
   *  "Lower retainer" on the appointment hero. Native widget rows
   *  populate these; Calendly-imported rows leave them null. */
  product_key: string | null;
  repair_variant: string | null;
  arch: string | null;
  /** Which storefront the booking came from — 'venneir' or
   *  'denture'. Drives the source badge icon + transactional
   *  email chrome. Defaults to 'venneir' on rows older than the
   *  brand-id column. */
  brand_id: string | null;
  join_url: string | null;
  meeting_platform: string | null;
  meet_host_id: string | null;
  meet_space_id: string | null;
  meet_meeting_code: string | null;
  conference_started_at: string | null;
  conference_ended_at: string | null;
  conference_count: number | null;
  recording_count: number | null;
  transcript_count: number | null;
  patient_rsvp_status: 'accepted' | 'declined' | 'tentative' | 'needsAction' | null;
  patient_rsvp_updated_at: string | null;
  intake: ReadonlyArray<{ question: string; answer: string }> | null;
  deposit_pence: number | null;
  deposit_currency: string | null;
  deposit_provider: 'paypal' | 'stripe' | null;
  deposit_status: 'paid' | 'failed' | null;
  paid_in_full_at_booking: boolean;
  shopify_order_name: string | null;
  shopify_order_total_pence: number | null;
  created_via: string | null;
  created_via_actor: string | null;
  // Walk-in marker rows store the underlying lng_walk_ins id here.
  // The marker exists only so walk-ins show on Schedule alongside
  // booked appointments; the real entity is the visit. Used here to
  // resolve the visit when no appointment_id-keyed visit row is found.
  walk_in_id: string | null;
}

export function useAppointmentDetail(appointmentId: string | undefined | null): UseAppointmentDetailResult {
  const [result, setResult] = useState<AppointmentDetailResult>({
    state: 'loading',
    data: null,
    error: null,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!appointmentId) {
      setResult({ state: 'not_found', data: null, error: null });
      return;
    }
    setResult({ state: 'loading', data: null, error: null });

    (async () => {
      try {
        const { data: rawAppt, error: apptErr } = await supabase
          .from('lng_appointments')
          .select(
            'id, status, source, start_at, end_at, event_type_label, appointment_ref, jb_ref, cancel_reason, notes, customer_note, reschedule_to_id, staff_account_id, location_id, patient_id, service_type, product_key, repair_variant, arch, brand_id, join_url, meeting_platform, meet_host_id, meet_space_id, meet_meeting_code, conference_started_at, conference_ended_at, conference_count, recording_count, transcript_count, patient_rsvp_status, patient_rsvp_updated_at, intake, deposit_pence, deposit_currency, deposit_provider, deposit_status, paid_in_full_at_booking, shopify_order_id, shopify_order_name, shopify_order_total_pence, created_via, created_via_actor, walk_in_id',
          )
          .eq('id', appointmentId)
          .maybeSingle();

        if (cancelled) return;
        if (apptErr) {
          await logFailure({
            source: 'useAppointmentDetail.appointment',
            severity: 'error',
            message: apptErr.message,
            context: { appointmentId },
          });
          setResult({ state: 'error', data: null, error: apptErr.message });
          return;
        }
        if (!rawAppt) {
          // Either the row doesn't exist or RLS hides it. Either way,
          // the page surfaces a not-found state — never silently fall
          // back to "loading" forever.
          setResult({ state: 'not_found', data: null, error: null });
          return;
        }

        const appt = rawAppt as RawAppointment & { meet_host_id?: string | null };

        // Fetch patient + location + staff + visit + host in parallel
        // so the page paints with everything on first useable render.
        // Host fetch returns null when meet_host_id is unset (legacy /
        // Calendly-imported rows).
        const [patientRes, locationRes, staffRes, visitRes, hostRes, upgradesRes, repairsRes] = await Promise.all([
          supabase
            .from('patients')
            .select('id, first_name, last_name, email, phone, avatar_data, internal_ref, lwo_ref')
            .eq('id', appt.patient_id)
            .maybeSingle(),
          supabase
            .from('locations')
            .select('id, name, address, city, postcode')
            .eq('id', appt.location_id)
            .maybeSingle(),
          appt.staff_account_id
            ? supabase
                .from('accounts')
                .select('id, first_name, last_name')
                .eq('id', appt.staff_account_id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          // Visit lookup. Two shapes:
          //   • Booked-then-arrived appointments are the typical case;
          //     the visit row joins via lng_visits.appointment_id.
          //   • Walk-in markers (manual-source rows tagged with a
          //     walk_in_id) belong to a visit linked via
          //     lng_visits.walk_in_id instead. Without this branch a
          //     Schedule-tap on a walk-in lands on AppointmentDetail
          //     and never redirects to /visit/:id, leaving the user
          //     on a marker row whose real surface lives elsewhere.
          appt.walk_in_id
            ? supabase
                .from('lng_visits')
                .select('id, opened_at')
                .eq('walk_in_id', appt.walk_in_id)
                .maybeSingle()
            : supabase
                .from('lng_visits')
                .select('id, opened_at')
                .eq('appointment_id', appt.id)
                .maybeSingle(),
          appt.meet_host_id
            ? supabase
                .from('lng_meet_hosts')
                .select('google_email')
                .eq('id', appt.meet_host_id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          // Widget-side picks. Empty arrays for bookings that came
          // through Calendly or pre-date the snapshot tables — both
          // surfaces (booking detail card + waiver items) gate on
          // .length so an empty result is invisible UI-side.
          supabase
            .from('lng_appointment_upgrade_selections')
            .select('id, upgrade_id, upgrade_code, name, unit_label, unit_price_pence, both_arches_price_pence, resolved_price_pence, created_at')
            .eq('appointment_id', appt.id)
            .order('created_at', { ascending: true }),
          supabase
            .from('lng_appointment_repair_items')
            .select('id, catalogue_id, code, repair_variant, name, unit_label, arch, quantity, unit_price_pence, both_arches_price_pence, line_total_pence, created_at')
            .eq('appointment_id', appt.id)
            .order('created_at', { ascending: true }),
        ]);
        if (cancelled) return;

        // Patient is non-optional. A missing row here is a data
        // integrity break (the FK forbids it) — log loudly. The page
        // still tries to render but with name fallbacks.
        if (patientRes.error) {
          await logFailure({
            source: 'useAppointmentDetail.patient',
            severity: 'error',
            message: patientRes.error.message,
            context: { appointmentId, patientId: appt.patient_id },
          });
        }
        if (locationRes.error) {
          await logFailure({
            source: 'useAppointmentDetail.location',
            severity: 'warning',
            message: locationRes.error.message,
            context: { appointmentId, locationId: appt.location_id },
          });
        }
        if (staffRes.error) {
          await logFailure({
            source: 'useAppointmentDetail.staff',
            severity: 'warning',
            message: staffRes.error.message,
            context: { appointmentId, staffId: appt.staff_account_id },
          });
        }
        if (visitRes.error) {
          await logFailure({
            source: 'useAppointmentDetail.visit',
            severity: 'warning',
            message: visitRes.error.message,
            context: { appointmentId },
          });
        }

        const patientRow =
          (patientRes.data as {
            id: string;
            first_name: string | null;
            last_name: string | null;
            email: string | null;
            phone: string | null;
            avatar_data: string | null;
            internal_ref: string | null;
            lwo_ref: string | null;
          } | null) ?? {
            id: appt.patient_id,
            first_name: null,
            last_name: null,
            email: null,
            phone: null,
            avatar_data: null,
            internal_ref: null,
            lwo_ref: null,
          };

        const row: AppointmentDetailRow = {
          id: appt.id,
          status: appt.status,
          source: appt.source,
          start_at: appt.start_at,
          end_at: appt.end_at,
          event_type_label: appt.event_type_label,
          appointment_ref: appt.appointment_ref,
          jb_ref: appt.jb_ref,
          cancel_reason: appt.cancel_reason,
          notes: appt.notes,
          customer_note: (appt as RawAppointment & { customer_note?: string | null }).customer_note ?? null,
          reschedule_to_id: appt.reschedule_to_id,
          staff_account_id: appt.staff_account_id,
          location_id: appt.location_id,
          patient_id: appt.patient_id,
          service_type: (appt as RawAppointment & { service_type?: string | null }).service_type ?? null,
          product_key: (appt as RawAppointment & { product_key?: string | null }).product_key ?? null,
          repair_variant: (appt as RawAppointment & { repair_variant?: string | null }).repair_variant ?? null,
          arch: (appt as RawAppointment & { arch?: string | null }).arch ?? null,
          brand_id: (appt as RawAppointment & { brand_id?: string | null }).brand_id ?? null,
          join_url: appt.join_url,
          meeting_platform: appt.meeting_platform,
          meet_host_id: (appt as RawAppointment & { meet_host_id?: string | null }).meet_host_id ?? null,
          meet_space_id: (appt as RawAppointment & { meet_space_id?: string | null }).meet_space_id ?? null,
          meet_meeting_code: (appt as RawAppointment & { meet_meeting_code?: string | null }).meet_meeting_code ?? null,
          conference_started_at: (appt as RawAppointment & { conference_started_at?: string | null }).conference_started_at ?? null,
          conference_ended_at: (appt as RawAppointment & { conference_ended_at?: string | null }).conference_ended_at ?? null,
          conference_count: (appt as RawAppointment & { conference_count?: number | null }).conference_count ?? 0,
          recording_count: (appt as RawAppointment & { recording_count?: number | null }).recording_count ?? 0,
          transcript_count: (appt as RawAppointment & { transcript_count?: number | null }).transcript_count ?? 0,
          patient_rsvp_status: (appt as RawAppointment & { patient_rsvp_status?: 'accepted' | 'declined' | 'tentative' | 'needsAction' | null }).patient_rsvp_status ?? null,
          patient_rsvp_updated_at: (appt as RawAppointment & { patient_rsvp_updated_at?: string | null }).patient_rsvp_updated_at ?? null,
          meet_host_email: (hostRes.data as { google_email?: string | null } | null)?.google_email ?? null,
          intake: appt.intake,
          deposit_pence: appt.deposit_pence,
          deposit_currency: appt.deposit_currency,
          deposit_provider: appt.deposit_provider,
          deposit_status: appt.deposit_status,
          paid_in_full_at_booking:
            (appt as RawAppointment & { paid_in_full_at_booking?: boolean | null })
              .paid_in_full_at_booking ?? false,
          shopify_order_id:
            (appt as RawAppointment & { shopify_order_id?: string | null }).shopify_order_id ?? null,
          shopify_order_name: appt.shopify_order_name,
          shopify_order_total_pence: appt.shopify_order_total_pence,
          created_via: appt.created_via,
          created_via_actor: appt.created_via_actor,
          patient: patientRow,
          location:
            (locationRes.data as { id: string; name: string | null; address: string | null; city: string | null; postcode: string | null } | null) ?? null,
          staff:
            (staffRes.data as { id: string; first_name: string | null; last_name: string | null } | null) ??
            null,
          visit:
            (visitRes.data as { id: string; opened_at: string } | null) ?? null,
          upgrades: ((upgradesRes.data ?? []) as Array<{
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
          })),
          repairItems: ((repairsRes.data ?? []) as Array<{
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
          })),
        };

        setResult({ state: 'loaded', data: row, error: null });
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load appointment';
        await logFailure({
          source: 'useAppointmentDetail.unhandled',
          severity: 'error',
          message,
          context: { appointmentId },
        });
        setResult({ state: 'error', data: null, error: message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [appointmentId, tick]);

  return { result, refresh: () => setTick((t) => t + 1) };
}

// ─────────────────────────────────────────────────────────────────────────────
// availableActions — single source of truth for which actions the
// detail page should offer for any given appointment state. Pulled
// out as a pure function (no React, no Supabase) so the rules can be
// unit-tested and audited in one place. Adding a new status or
// changing a rule means editing here, not chasing if-branches in the
// JSX.
// ─────────────────────────────────────────────────────────────────────────────

export type AppointmentAction =
  | 'view_patient_profile'   // every state
  | 'mark_arrived'           // booked, in-person only
  | 'join_meeting'           // booked, virtual only — first join
  | 'rejoin_meeting'         // arrived, virtual only — reconnect
  | 'mark_no_show'           // booked, past start time
  | 'reschedule'             // booked / joined; native source OR virtual (any source)
  | 'cancel'                 // booked / joined + native source
  | 'resend_confirmation'    // booked / joined + native source + patient has email
  | 'reverse_cancellation'   // cancelled
  | 'reverse_no_show'        // no_show
  | 'view_rescheduled_to'    // rescheduled with a forward link
  | 'view_visit';            // arrived / complete with an in-person visit

export interface AvailableActionsInput {
  status: AppointmentStatus;
  source: AppointmentSource;
  hasPatientEmail: boolean;
  hasVisit: boolean;
  hasRescheduleTarget: boolean;
  isVirtual: boolean;
}

export function availableActions(input: AvailableActionsInput): AppointmentAction[] {
  const out: AppointmentAction[] = ['view_patient_profile'];
  const { status, source, hasPatientEmail, hasVisit, hasRescheduleTarget, isVirtual } = input;
  const isCalendly = source === 'calendly';

  // Reschedule is offered for every non-Calendly booking — Calendly
  // is the source of truth for those, so the reschedule flow stays on
  // their widget. The one exception is virtual appointments: a
  // virtual booking originally placed via Calendly still needs to be
  // movable from Lounge after staff has joined, because the call IS
  // happening here and the staff is the only person in a position to
  // act if the patient asks to be rebooked mid-call. Manual /
  // Checkpoint / venneir.com virtual bookings have always exposed
  // Reschedule; this also turns it on for Calendly virtuals so the
  // affordance is consistent across every source for the same call
  // type.
  const canReschedule = !isCalendly || isVirtual;
  const canCancel = !isCalendly;
  const canResend = !isCalendly && hasPatientEmail;

  if (status === 'booked') {
    // Virtual: Join replaces the arrival wizard; in-person: normal arrival flow.
    out.push(isVirtual ? 'join_meeting' : 'mark_arrived');
    out.push('mark_no_show');
    if (canReschedule) out.push('reschedule');
    if (canCancel) out.push('cancel');
    if (canResend) out.push('resend_confirmation');
  } else if (status === 'cancelled') {
    out.push('reverse_cancellation');
  } else if (status === 'no_show') {
    out.push('reverse_no_show');
  } else if (status === 'rescheduled') {
    if (hasRescheduleTarget) out.push('view_rescheduled_to');
  } else if (status === 'joined') {
    // Staff joined the meeting but the patient may not have connected —
    // every recovery path stays open. Rejoin lets them reconnect,
    // no_show covers a true no-show, and reschedule stays available
    // on virtual rows regardless of source so the operator can move
    // the call live (per Dylan's call — once a virtual is in
    // progress, staff is the only one who can act on it).
    out.push('rejoin_meeting');
    out.push('mark_no_show');
    if (canReschedule) out.push('reschedule');
    if (canCancel) out.push('cancel');
    if (canResend) out.push('resend_confirmation');
  } else if (status === 'arrived' || status === 'complete') {
    // Virtual appointments never produce a visit row, so offer Rejoin instead.
    if (isVirtual) out.push('rejoin_meeting');
    else if (hasVisit) out.push('view_visit');
  }

  return out;
}
