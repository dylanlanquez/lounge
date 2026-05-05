import { supabase } from '../supabase.ts';
import {
  type BookingServiceType,
  resolveBookingTypeConfig,
} from './bookingTypes.ts';
import { sendAppointmentConfirmation } from './sendAppointmentConfirmation.ts';

// Reschedule helper for native Lounge bookings.
//
// What it does (in this exact order):
//
//   1. Reads the existing appointment (location, patient, service,
//      source, etc.).
//   2. Refuses for Calendly-sourced rows — per the working
//      agreement with Dylan, those reschedule on Calendly itself
//      until Calendly is decommissioned.
//   3. Resolves the booking type's duration to know how long the
//      new slot needs to be.
//   4. Runs the DB conflict checker against the candidate slot,
//      excluding the original appointment id (so a same-time
//      reschedule doesn't conflict with itself).
//   5. Inserts a new lng_appointments row (source='manual',
//      status='booked', service_type carried over).
//   6. Marks the old row 'rescheduled', writes the
//      reschedule_to_id chain, and stamps cancel_reason.
//   7. Emits a patient_events row so the timeline + reports both
//      see the move.
//
// On any failure after step 5 the inserted row is left in place
// for the operator to clean up. We don't wrap the writes in a
// transaction because the Supabase JS client doesn't expose one;
// the cost of a partial failure is one orphan booked row, which
// is recoverable. (When this is converted to an RPC in a follow-up,
// the whole block will run in a single PL/pgSQL transaction.)

export interface RescheduleConflict {
  conflict_kind: 'pool_at_capacity' | 'max_concurrent';
  pool_id: string | null;
  pool_capacity: number;
  current_count: number;
  // Phase-aware fields populated by the phase-aware conflict checker
  // (M5). For pool_at_capacity, names the candidate's phase that hit
  // the limit and the time window of that phase. Null for
  // max_concurrent (which is whole-appointment, not per-phase).
  phase_index: number | null;
  phase_label: string | null;
  conflict_start_at: string | null; // ISO timestamptz
  conflict_end_at: string | null;   // ISO timestamptz
}

export class RescheduleConflictError extends Error {
  conflicts: RescheduleConflict[];
  constructor(conflicts: RescheduleConflict[]) {
    super(`Slot conflicts: ${describeConflicts(conflicts)}`);
    this.name = 'RescheduleConflictError';
    this.conflicts = conflicts;
  }
}

interface RescheduleResult {
  newAppointmentId: string;
}

interface AppointmentRowMin {
  id: string;
  patient_id: string;
  location_id: string;
  source: 'calendly' | 'manual' | 'native';
  service_type: string | null;
  event_type_label: string | null;
  staff_account_id: string | null;
  repair_variant: string | null;
  product_key: string | null;
  arch: 'upper' | 'lower' | 'both' | null;
}

// Pre-flight conflict check — used by the reschedule sheet to give
// live feedback before the user submits. Returns the conflicts list
// (empty = slot is free). Optional axis pins are forwarded to the RPC
// so the conflict-checker resolves the right child config (durations
// can shift between the parent row and a (product, arch) override).
export async function checkBookingConflict(args: {
  locationId: string;
  serviceType: BookingServiceType;
  startAt: string; // ISO
  endAt: string;   // ISO
  excludeAppointmentId?: string;
  repairVariant?: string | null;
  productKey?: string | null;
  arch?: 'upper' | 'lower' | 'both' | null;
}): Promise<RescheduleConflict[]> {
  const { data, error } = await supabase.rpc('lng_booking_check_conflict', {
    p_location_id: args.locationId,
    p_service_type: args.serviceType,
    p_start_at: args.startAt,
    p_end_at: args.endAt,
    p_exclude_appointment_id: args.excludeAppointmentId ?? null,
    p_repair_variant: args.repairVariant ?? null,
    p_product_key: args.productKey ?? null,
    p_arch: args.arch ?? null,
  });
  if (error) throw new Error(error.message);
  if (!Array.isArray(data)) return [];
  return data.map((r) => mapConflictRow(r));
}

// Single mapper for the lng_booking_check_conflict RPC row → typed
// conflict record. Used by both the reschedule and new-booking
// helpers so the row-to-object shape stays in lockstep.
export function mapConflictRow(r: {
  conflict_kind: string;
  pool_id: string | null;
  pool_capacity: number;
  current_count: number;
  phase_index?: number | null;
  phase_label?: string | null;
  conflict_start_at?: string | null;
  conflict_end_at?: string | null;
}): RescheduleConflict {
  return {
    conflict_kind: r.conflict_kind as RescheduleConflict['conflict_kind'],
    pool_id: r.pool_id ?? null,
    pool_capacity: r.pool_capacity,
    current_count: r.current_count,
    phase_index: r.phase_index ?? null,
    phase_label: r.phase_label ?? null,
    conflict_start_at: r.conflict_start_at ?? null,
    conflict_end_at: r.conflict_end_at ?? null,
  };
}

export async function rescheduleAppointment(input: {
  appointmentId: string;
  newStartAt: string; // ISO timestamptz
  reason?: string;
}): Promise<RescheduleResult> {
  // ── 1. Read existing appointment ────────────────────────────────
  const { data: existingRaw, error: readErr } = await supabase
    .from('lng_appointments')
    .select(
      'id, patient_id, location_id, source, service_type, event_type_label, staff_account_id, status, repair_variant, product_key, arch',
    )
    .eq('id', input.appointmentId)
    .maybeSingle();
  if (readErr) throw new Error(`Couldn't read appointment: ${readErr.message}`);
  if (!existingRaw) throw new Error('Appointment not found.');
  const existing = existingRaw as AppointmentRowMin & { status: string };

  // ── 2. Source / status guards ──────────────────────────────────
  if (existing.source === 'calendly') {
    throw new Error(
      'Calendly-sourced bookings reschedule on Calendly. Cancel and rebook on Calendly directly.',
    );
  }
  if (
    existing.status === 'rescheduled' ||
    existing.status === 'cancelled' ||
    existing.status === 'no_show' ||
    existing.status === 'complete'
  ) {
    throw new Error(`Cannot reschedule an appointment with status "${existing.status}".`);
  }

  // ── 3. Resolve booking type to know the new slot's duration ────
  // Pins inherited from the existing row so a (product, arch) override's
  // duration carries through the reschedule rather than collapsing back
  // to the parent's default.
  const serviceType = (existing.service_type ?? 'other') as BookingServiceType;
  const config = await resolveBookingTypeConfig({
    service_type: serviceType,
    repair_variant: existing.repair_variant,
    product_key: existing.product_key,
    arch: existing.arch,
  });
  if (!config) {
    throw new Error(
      `No booking config for service "${serviceType}". Set the parent defaults in Admin → Booking types first.`,
    );
  }
  const durationMin = config.duration_default;
  const newStart = new Date(input.newStartAt);
  if (Number.isNaN(newStart.getTime())) throw new Error('Invalid new-start timestamp.');
  const newEnd = new Date(newStart.getTime() + durationMin * 60_000);

  // ── 4. Conflict check ─────────────────────────────────────────
  const conflicts = await checkBookingConflict({
    locationId: existing.location_id,
    serviceType,
    startAt: newStart.toISOString(),
    endAt: newEnd.toISOString(),
    excludeAppointmentId: existing.id,
    repairVariant: existing.repair_variant,
    productKey: existing.product_key,
    arch: existing.arch,
  });
  if (conflicts.length > 0) {
    throw new RescheduleConflictError(conflicts);
  }

  // ── 5. Insert new appointment row ──────────────────────────────
  const { data: insertedRaw, error: insertErr } = await supabase
    .from('lng_appointments')
    .insert({
      patient_id: existing.patient_id,
      location_id: existing.location_id,
      source: 'manual',
      start_at: newStart.toISOString(),
      end_at: newEnd.toISOString(),
      status: 'booked',
      service_type: serviceType,
      event_type_label: existing.event_type_label,
      staff_account_id: existing.staff_account_id,
      repair_variant: existing.repair_variant,
      product_key: existing.product_key,
      arch: existing.arch,
    })
    .select('id')
    .single();
  if (insertErr || !insertedRaw) {
    throw new Error(`Couldn't create new appointment: ${insertErr?.message ?? 'unknown error'}`);
  }
  const newAppointmentId = (insertedRaw as { id: string }).id;

  // ── 6. Mark old row rescheduled with chain ─────────────────────
  const { error: updateErr } = await supabase
    .from('lng_appointments')
    .update({
      status: 'rescheduled',
      reschedule_to_id: newAppointmentId,
      cancel_reason: input.reason?.trim() ? input.reason.trim() : null,
    })
    .eq('id', existing.id);
  if (updateErr) {
    // Hard error — operator needs to clean up the orphan new row.
    throw new Error(
      `New appointment created (${newAppointmentId}) but couldn't mark the old one rescheduled: ${updateErr.message}. Manual cleanup required.`,
    );
  }

  // ── 7. Google Meet (virtual impression only) ────────────────────
  // Create a fresh Meet for the new slot, then remove the old one.
  // Both are best-effort: if either fails the reschedule stands and
  // the failure is logged server-side in lng_system_failures.
  if (serviceType === 'virtual_impression_appointment') {
    void supabase.functions
      .invoke('google-meet-create', { body: { appointmentId: newAppointmentId } })
      .catch((e: unknown) =>
        console.warn('[rescheduleAppointment] google-meet-create failed:', e),
      );
    void supabase.functions
      .invoke('google-meet-delete', { body: { appointmentId: existing.id } })
      .catch((e: unknown) =>
        console.warn('[rescheduleAppointment] google-meet-delete failed:', e),
      );
  }

  // ── 8. patient_events audit row ────────────────────────────────
  // Best-effort — failure here doesn't unwind the reschedule.
  const { data: actorAccountIdRaw } = await supabase.rpc('auth_account_id');
  const actorAccountId = (actorAccountIdRaw as string | null) ?? null;
  await supabase.from('patient_events').insert({
    patient_id: existing.patient_id,
    event_type: 'appointment_rescheduled',
    actor_account_id: actorAccountId,
    payload: {
      old_appointment_id: existing.id,
      new_appointment_id: newAppointmentId,
      new_start_at: newStart.toISOString(),
      new_end_at: newEnd.toISOString(),
      reason: input.reason?.trim() ?? null,
    },
  });

  // ── 9. Email confirmation (best-effort) ────────────────────────
  // Sends a "your appointment has moved" email with a fresh REQUEST
  // .ics for the new slot AND a CANCEL .ics for the old slot, so
  // the patient's calendar updates instead of accumulating
  // duplicates. Failure here is logged inside the edge function
  // (lng_system_failures) — we don't unwind the reschedule because
  // the DB state is already correct; the operator can manually
  // resend from the Schedule sheet.
  void sendAppointmentConfirmation({
    appointmentId: newAppointmentId,
    oldAppointmentIdToCancel: existing.id,
  }).catch(() => {
    // already logged server-side; nothing to do here
  });

  return { newAppointmentId };
}

function describeConflicts(conflicts: RescheduleConflict[]): string {
  return conflicts
    .map((c) => {
      if (c.conflict_kind === 'pool_at_capacity') {
        const phase = c.phase_label ? ` during ${c.phase_label}` : '';
        return `pool "${c.pool_id}" at capacity ${c.pool_capacity}${phase} (${c.current_count} already booked)`;
      }
      return `service hits max-concurrent ${c.pool_capacity} (${c.current_count} already booked)`;
    })
    .join('; ');
}
