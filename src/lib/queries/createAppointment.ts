import { supabase } from '../supabase.ts';
import {
  type BookingServiceType,
  BOOKING_SERVICE_TYPES,
  resolveBookingTypeConfig,
} from './bookingTypes.ts';
import {
  type RescheduleConflict,
  RescheduleConflictError,
  mapConflictRow,
  OVERLAP_GUARD_SQLSTATE,
  throwOverlapAsConflictError,
} from './rescheduleAppointment.ts';
import { sendAppointmentConfirmation } from './sendAppointmentConfirmation.ts';

// Native "book a new appointment" helper. Mirrors rescheduleAppointment
// but for the brand-new case: tap an empty slot in the schedule, pick
// patient + service + time, save.
//
// Order of operations:
//
//   1. Validate the inputs (patient + location + service + start are
//      required; duration falls back to the booking type config).
//   2. Resolve the booking type to know the duration to apply.
//   3. Run lng_booking_check_conflict against the candidate slot.
//   4. Insert the appointment row (source='manual', status='booked').
//   5. Emit a patient_events row so the timeline picks it up.
//   6. Best-effort sendAppointmentConfirmation if the caller asked
//      for it AND the patient has an email on file.
//
// Conflict races are surfaced as RescheduleConflictError (re-using
// the type since the conflict shape is identical to a reschedule).
// Failure after insert is loud — we don't try to roll the row back
// because the DB state is internally consistent and the operator can
// see the appointment in the schedule.

export interface CreateAppointmentResult {
  appointmentId: string;
  emailSent: boolean;
  emailReason: string | null;
  // Non-null when this was a virtual_impression_appointment and the
  // Meet link creation call failed. The booking row still saved, but
  // join_url is empty so the appointment surfaces will not show the
  // Join button until the receptionist retries from the appointment
  // detail page's Generate Meet link action.
  meetCreateError?: string | null;
}

export async function createAppointment(input: {
  patientId: string;
  locationId: string;
  serviceType: BookingServiceType;
  startAt: string; // ISO timestamptz
  // When omitted, falls back to the booking type's duration_default.
  // The caller can let the user override (e.g. "this one's a quick
  // 20-min check") by passing a number here.
  durationMinutes?: number;
  staffAccountId?: string | null;
  notes?: string;
  sendEmail?: boolean;
  // Optional override of the human-readable event label written to
  // the row. When omitted we derive from the service type so
  // schedule cards / emails still read sensibly.
  eventTypeLabel?: string;
  // Booking-type axis pins. Forwarded into resolveBookingTypeConfig
  // and the conflict check so child overrides apply (e.g. a different
  // duration for "Whitening Tray, Upper" than the same-day-appliance
  // parent default), and persisted on the appointment row so reschedule
  // and visit detail can use them later.
  repairVariant?: string | null;
  productKey?: string | null;
  arch?: 'upper' | 'lower' | 'both' | null;
  // Per-host Meet integration. Set on virtual appointments so the
  // Meet space gets created under THIS host's OAuth grant (and so
  // attendance can be fetched later via the Meet REST API). Omitting
  // it for a virtual appointment falls back to the legacy service-
  // account google-meet-create — used today by Calendly imports
  // and any service that hasn't been wired through the new flow yet.
  meetHostId?: string | null;
  // Shopify-paid services attach a resolved order at booking time.
  // The order's total credits against the cart at checkout, the
  // same way a Calendly deposit currently does. Null when the
  // service isn't sold on venneir.com.
  shopifyOrder?: {
    id: string;
    name: string;
    totalPricePence: number;
    currency: string | null;
  } | null;
}): Promise<CreateAppointmentResult> {
  // ── 1. Input validation ────────────────────────────────────────
  if (!input.patientId) throw new Error('Pick a patient first.');
  if (!input.locationId) throw new Error('Missing location.');
  if (!input.serviceType) throw new Error('Pick a service.');
  const start = new Date(input.startAt);
  if (Number.isNaN(start.getTime())) throw new Error('Invalid start time.');

  // ── 2. Resolve duration ────────────────────────────────────────
  const config = await resolveBookingTypeConfig({
    service_type: input.serviceType,
    repair_variant: input.repairVariant ?? null,
    product_key: input.productKey ?? null,
    arch: input.arch ?? null,
  });
  if (!config) {
    throw new Error(
      `No booking config for service "${input.serviceType}". Set the parent defaults in Admin, Booking types first.`,
    );
  }
  const durationMin =
    typeof input.durationMinutes === 'number' && input.durationMinutes > 0
      ? input.durationMinutes
      : (config.duration_default ?? config.block_duration_minutes ?? 0);
  const end = new Date(start.getTime() + durationMin * 60_000);

  // ── 3. Conflict check ──────────────────────────────────────────
  // Same RPC the reschedule sheet hits — passing no exclude id
  // because there's no existing row to ignore.
  const { data: conflictData, error: conflictErr } = await supabase.rpc(
    'lng_booking_check_conflict',
    {
      p_location_id: input.locationId,
      p_service_type: input.serviceType,
      p_start_at: start.toISOString(),
      p_end_at: end.toISOString(),
      p_exclude_appointment_id: null,
      p_repair_variant: input.repairVariant ?? null,
      p_product_key: input.productKey ?? null,
      p_arch: input.arch ?? null,
    },
  );
  if (conflictErr) throw new Error(conflictErr.message);
  const conflicts: RescheduleConflict[] = Array.isArray(conflictData)
    ? conflictData.map((r) => mapConflictRow(r))
    : [];
  if (conflicts.length > 0) throw new RescheduleConflictError(conflicts);

  // ── 4. Insert row ──────────────────────────────────────────────
  const eventLabel =
    input.eventTypeLabel?.trim() || labelForService(input.serviceType);
  const { data: actorAccountIdRaw } = await supabase.rpc('auth_account_id');
  const actorAccountIdEarly = (actorAccountIdRaw as string | null) ?? null;
  const { data: insertedRaw, error: insertErr } = await supabase
    .from('lng_appointments')
    .insert({
      patient_id: input.patientId,
      location_id: input.locationId,
      source: 'manual',
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      status: 'booked',
      service_type: input.serviceType,
      event_type_label: eventLabel,
      staff_account_id: input.staffAccountId ?? null,
      notes: input.notes?.trim() || null,
      repair_variant: input.repairVariant ?? null,
      product_key: input.productKey ?? null,
      arch: input.arch ?? null,
      // Shopify order credit. Attached at booking time so the cart
      // total at checkout already reflects what the customer paid
      // online. Currency stays as Shopify reports it (string) — we
      // don't currently support non-GBP at the till, but keeping the
      // field lets us surface the original currency on the waiver
      // for an audit trail.
      shopify_order_id: input.shopifyOrder?.id ?? null,
      shopify_order_name: input.shopifyOrder?.name ?? null,
      shopify_order_total_pence: input.shopifyOrder?.totalPricePence ?? null,
      shopify_order_currency: input.shopifyOrder?.currency ?? null,
      shopify_order_linked_at: input.shopifyOrder ? new Date().toISOString() : null,
      shopify_order_linked_by: input.shopifyOrder ? actorAccountIdEarly : null,
    })
    .select('id')
    .single();
  if (insertErr || !insertedRaw) {
    // SQLSTATE 23P01 = the database-level overlap guard caught a
    // race that slipped past the pre-check above. Re-fetch the
    // conflicts so the UI shows the same banner the pre-check
    // would have shown.
    if ((insertErr as { code?: string } | null)?.code === OVERLAP_GUARD_SQLSTATE) {
      await throwOverlapAsConflictError({
        locationId: input.locationId,
        serviceType: input.serviceType,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        repairVariant: input.repairVariant,
        productKey: input.productKey,
        arch: input.arch,
      });
    }
    throw new Error(`Couldn't create appointment: ${insertErr?.message ?? 'unknown error'}`);
  }
  const appointmentId = (insertedRaw as { id: string }).id;

  // ── 5. patient_events ──────────────────────────────────────────
  // Best-effort — failure here doesn't unwind the booking. Re-uses
  // the actor id resolved above so we don't burn a second RPC.
  const actorAccountId = actorAccountIdEarly;
  await supabase.from('patient_events').insert({
    patient_id: input.patientId,
    event_type: 'appointment_booked',
    actor_account_id: actorAccountId,
    payload: {
      appointment_id: appointmentId,
      service_type: input.serviceType,
      repair_variant: input.repairVariant ?? null,
      product_key: input.productKey ?? null,
      arch: input.arch ?? null,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      duration_minutes: durationMin,
      staff_account_id: input.staffAccountId ?? null,
    },
  });

  // ── 6. Google Meet link (virtual impression only) ──────────────
  // Two-path routing:
  //   • meetHostId set     → meet-create-space (per-host OAuth, lets
  //                          us pull Meet attendance later).
  //   • no meetHostId      → legacy google-meet-create (service-account
  //                          flow, still used by Calendly imports and
  //                          any caller that hasn't wired the host
  //                          dropdown yet). No attendance available.
  //
  // The appointment ROW is already committed at this point, so a Meet
  // creation failure can't unwind it. Instead we surface the reason
  // back to the caller via meetCreateError so the NewBookingSheet
  // can render a soft warning ("Booking saved, Meet link needs a
  // retry from the appointment page") and the user can hit the
  // Generate Meet link button on AppointmentDetail. Previously this
  // path swallowed every error to console.warn, leaving the booking
  // looking non-virtual to the page (no join_url → no Join button)
  // with no signal to the receptionist that anything went wrong.
  let meetCreateError: string | null = null;
  if (input.serviceType === 'virtual_impression_appointment') {
    try {
      if (input.meetHostId) {
        const { data, error } = await supabase.functions.invoke<unknown>(
          'meet-create-space',
          { body: { appointment_id: appointmentId, host_id: input.meetHostId } },
        );
        if (error) {
          meetCreateError = error.message;
        } else {
          const payload = (data ?? {}) as { ok?: boolean; error?: string };
          if (!payload.ok) {
            meetCreateError = payload.error ?? 'Meet space could not be created.';
          }
        }
      } else {
        const { data, error } = await supabase.functions.invoke<unknown>(
          'google-meet-create',
          { body: { appointmentId } },
        );
        if (error) {
          meetCreateError = error.message;
        } else {
          const payload = (data ?? {}) as { ok?: boolean; error?: string };
          if (payload.ok === false) {
            meetCreateError = payload.error ?? 'Meet link could not be created.';
          }
        }
      }
    } catch (e) {
      meetCreateError = e instanceof Error ? e.message : String(e);
    }
  }

  // ── 7. Confirmation email (opt-in) ─────────────────────────────
  let emailSent = false;
  let emailReason: string | null = null;
  if (input.sendEmail) {
    try {
      const result = await sendAppointmentConfirmation({ appointmentId });
      if (result.ok) {
        emailSent = true;
      } else {
        emailReason = result.reason ?? result.error;
      }
    } catch (e) {
      // The edge function logs to lng_system_failures internally;
      // we just record the human-friendly reason for the toast.
      emailReason = e instanceof Error ? e.message : 'send_failed';
    }
  }

  return { appointmentId, emailSent, emailReason, meetCreateError };
}

// Human-readable label for a service. The schedule card + email
// rendering both fall back to event_type_label when present, so we
// always populate it on insert from the service type if the caller
// didn't provide one.
function labelForService(s: BookingServiceType): string {
  const found = BOOKING_SERVICE_TYPES.find((b) => b.value === s);
  return found?.label ?? 'Appointment';
}
