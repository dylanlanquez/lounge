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
      : config.duration_default;
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
    })
    .select('id')
    .single();
  if (insertErr || !insertedRaw) {
    throw new Error(`Couldn't create appointment: ${insertErr?.message ?? 'unknown error'}`);
  }
  const appointmentId = (insertedRaw as { id: string }).id;

  // ── 5. patient_events ──────────────────────────────────────────
  // Best-effort — failure here doesn't unwind the booking.
  const { data: actorAccountIdRaw } = await supabase.rpc('auth_account_id');
  const actorAccountId = (actorAccountIdRaw as string | null) ?? null;
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

  // ── 6. Confirmation email (opt-in) ─────────────────────────────
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

  return { appointmentId, emailSent, emailReason };
}

// Human-readable label for a service. The schedule card + email
// rendering both fall back to event_type_label when present, so we
// always populate it on insert from the service type if the caller
// didn't provide one.
function labelForService(s: BookingServiceType): string {
  const found = BOOKING_SERVICE_TYPES.find((b) => b.value === s);
  return found?.label ?? 'Appointment';
}
