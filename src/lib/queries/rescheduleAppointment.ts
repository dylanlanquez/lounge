import { supabase } from '../supabase.ts';
import {
  type BookingServiceType,
  resolveBookingTypeConfig,
} from './bookingTypes.ts';

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
}

// Pre-flight conflict check — used by the reschedule sheet to give
// live feedback before the user submits. Returns the conflicts list
// (empty = slot is free).
export async function checkBookingConflict(args: {
  locationId: string;
  serviceType: BookingServiceType;
  startAt: string; // ISO
  endAt: string;   // ISO
  excludeAppointmentId?: string;
}): Promise<RescheduleConflict[]> {
  const { data, error } = await supabase.rpc('lng_booking_check_conflict', {
    p_location_id: args.locationId,
    p_service_type: args.serviceType,
    p_start_at: args.startAt,
    p_end_at: args.endAt,
    p_exclude_appointment_id: args.excludeAppointmentId ?? null,
  });
  if (error) throw new Error(error.message);
  if (!Array.isArray(data)) return [];
  return data.map((r) => ({
    conflict_kind: r.conflict_kind as RescheduleConflict['conflict_kind'],
    pool_id: r.pool_id ?? null,
    pool_capacity: r.pool_capacity as number,
    current_count: r.current_count as number,
  }));
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
      'id, patient_id, location_id, source, service_type, event_type_label, staff_account_id, status',
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
  const serviceType = (existing.service_type ?? 'other') as BookingServiceType;
  const config = await resolveBookingTypeConfig({ service_type: serviceType });
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

  // ── 7. patient_events audit row ────────────────────────────────
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

  return { newAppointmentId };
}

function describeConflicts(conflicts: RescheduleConflict[]): string {
  return conflicts
    .map((c) => {
      if (c.conflict_kind === 'pool_at_capacity') {
        return `pool "${c.pool_id}" at capacity ${c.pool_capacity} (${c.current_count} already booked)`;
      }
      return `service hits max-concurrent ${c.pool_capacity} (${c.current_count} already booked)`;
    })
    .join('; ');
}
