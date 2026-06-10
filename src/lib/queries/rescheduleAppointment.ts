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
  conflict_kind: 'pool_at_capacity' | 'max_concurrent' | 'min_notice' | 'closed';
  pool_id: string | null;
  // For pool_at_capacity / max_concurrent: the pool's effective
  // capacity. For min_notice: the booking type's notice in minutes
  // (re-used field so callers can read "X minutes" without changing
  // the row shape).
  pool_capacity: number;
  // Null for min_notice (the gate isn't a count of overlapping
  // appointments — it's a time check); always populated for the
  // other kinds.
  current_count: number | null;
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
  // Per-host Meet integration carry-forward. When the old row was
  // booked through the per-host flow, the new row inherits the same
  // host so the Calendar event lands on the original host's calendar
  // (Karly's, Lab's, etc.) and not the service-account fallback.
  meet_host_id: string | null;
  // Virtual impression clinician carried forward across the reschedule.
  clinician_staff_member_id: string | null;
  // Booking-time data the patient has committed to. Reschedule moves
  // the patient to a new slot; everything they were booked in for
  // moves with them — staff at the new appointment see the same
  // notes, deposit credit, online order link, brand, intake answers,
  // and (via the linked-table copies further down) the same
  // upgrades, repair lines, and pre-visit smile photos.
  notes: string | null;
  customer_note: string | null;
  intake: ReadonlyArray<{ question: string; answer: string }> | null;
  brand_id: 'venneir' | 'denture' | null;
  paid_in_full_at_booking: boolean | null;
  deposit_pence: number | null;
  deposit_currency: string | null;
  deposit_provider: 'paypal' | 'stripe' | null;
  deposit_external_id: string | null;
  deposit_paid_at: string | null;
  deposit_status: 'paid' | 'failed' | null;
  shopify_order_id: string | null;
  shopify_order_name: string | null;
  shopify_order_total_pence: number | null;
  shopify_order_currency: string | null;
  shopify_order_linked_at: string | null;
  shopify_order_linked_by: string | null;
}

// Postgres SQLSTATE raised by lng_appointments_overlap_guard when
// the post-insert check finds a collision. The guard is the
// database-level backstop for the rare race between the app's
// pre-check and the actual write; surfacing it as the same
// RescheduleConflictError the pre-check throws means the UI
// presents both kinds of conflict identically.
export const OVERLAP_GUARD_SQLSTATE = '23P01';

// Helper: when an insert into lng_appointments fails with the guard
// SQLSTATE, re-run the conflict checker to fetch the precise
// conflicts list and throw RescheduleConflictError. Falls back to a
// generic "slot just got taken" RescheduleConflictError if the
// re-check itself fails or returns nothing (which would be unusual
// — a race so fast the conflict cleared between insert + re-check).
export async function throwOverlapAsConflictError(args: {
  locationId: string;
  serviceType: BookingServiceType;
  startAt: string;
  endAt: string;
  excludeAppointmentId?: string;
  repairVariant?: string | null;
  productKey?: string | null;
  arch?: 'upper' | 'lower' | 'both' | null;
}): Promise<never> {
  let conflicts: RescheduleConflict[] = [];
  try {
    conflicts = await checkBookingConflict({
      locationId: args.locationId,
      serviceType: args.serviceType,
      startAt: args.startAt,
      endAt: args.endAt,
      excludeAppointmentId: args.excludeAppointmentId,
      repairVariant: args.repairVariant,
      productKey: args.productKey,
      arch: args.arch,
    });
  } catch {
    // ignore — fall through to generic conflict below
  }
  if (conflicts.length === 0) {
    // The race-clear case: the colliding booking was cancelled in
    // the same millisecond. Surface a minimal conflict so the user
    // sees "this slot is no longer free" instead of "ok everything's
    // fine"; they can retry the picker and find a real slot.
    conflicts = [
      {
        conflict_kind: 'max_concurrent',
        pool_id: null,
        pool_capacity: 0,
        current_count: 1,
        phase_index: null,
        phase_label: null,
        conflict_start_at: args.startAt,
        conflict_end_at: args.endAt,
      },
    ];
  }
  throw new RescheduleConflictError(conflicts);
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
  current_count: number | null;
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
  // Pulls every column that needs to migrate to the rescheduled
  // booking. Anything purely about the old slot (start_at, end_at,
  // status, reminder_sent_at, conference fields, etc.) is left
  // behind by design — those are moments-in-time facts of the old
  // arrival window and don't make sense on the new one.
  const { data: existingRaw, error: readErr } = await supabase
    .from('lng_appointments')
    .select(
      'id, patient_id, location_id, source, service_type, event_type_label, staff_account_id, status, repair_variant, product_key, arch, meet_host_id, clinician_staff_member_id, notes, customer_note, intake, brand_id, paid_in_full_at_booking, deposit_pence, deposit_currency, deposit_provider, deposit_external_id, deposit_paid_at, deposit_status, shopify_order_id, shopify_order_name, shopify_order_total_pence, shopify_order_currency, shopify_order_linked_at, shopify_order_linked_by',
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
    existing.status === 'complete' ||
    // 'arrived' rejected to mirror the UI policy in
    // appointmentDetail.ts availableActions(): once the patient is
    // physically in clinic the visit is the system of record, not
    // the appointment. The endVisitIfOpen path below stays as
    // defence-in-depth in case anyone ever relaxes this guard, but
    // in normal operation this branch fires first and the visit
    // close path never runs.
    existing.status === 'arrived'
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
  const durationMin = config.duration_default ?? config.block_duration_minutes ?? 0;
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
  // Every booking-time piece of data the patient committed to comes
  // along: notes, intake answers, brand, deposit + paid-in-full
  // flags, the linked Shopify order, and the per-host Meet config.
  // Linked-table data (upgrades, repair lines, smile photos)
  // copies in step 7 once the new appointment id exists.
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
      // Backward pointer to the row this reschedule originated from.
      // The forward chain is set on the old row below; this column
      // lets reports walk the chain in either direction without
      // scanning the table.
      reschedule_from_id: existing.id,
      // Carry the clinician forward so the new row keeps the same
      // virtual impression clinician (the availability + no-double-book
      // key), and meet-create-space resolves the same room owner.
      clinician_staff_member_id: existing.clinician_staff_member_id,
      // Booking-time data the patient committed to. Preserved across
      // the reschedule so the new appointment surfaces the same
      // intake answers, deposit credit (so the till still nets it
      // against the cart), Shopify-paid online order, and brand
      // identity. Staff notes copy separately in
      // carryOverLinkedTables → copyActiveStaffNotes since they
      // now live in lng_appointment_staff_notes.
      customer_note: existing.customer_note,
      intake: existing.intake,
      brand_id: existing.brand_id,
      paid_in_full_at_booking: existing.paid_in_full_at_booking ?? false,
      deposit_pence: existing.deposit_pence,
      deposit_currency: existing.deposit_currency,
      deposit_provider: existing.deposit_provider,
      deposit_external_id: existing.deposit_external_id,
      deposit_paid_at: existing.deposit_paid_at,
      deposit_status: existing.deposit_status,
      shopify_order_id: existing.shopify_order_id,
      shopify_order_name: existing.shopify_order_name,
      shopify_order_total_pence: existing.shopify_order_total_pence,
      shopify_order_currency: existing.shopify_order_currency,
      shopify_order_linked_at: existing.shopify_order_linked_at,
      shopify_order_linked_by: existing.shopify_order_linked_by,
    })
    .select('id')
    .single();
  if (insertErr || !insertedRaw) {
    // SQLSTATE 23P01 surfaces the lng_appointments_overlap_guard
    // trigger catching a race that slipped past the pre-check (or
    // any direct-insert path future-us might add). Re-fetch the
    // conflicts so the UI shows the same banner as the pre-check.
    if ((insertErr as { code?: string } | null)?.code === OVERLAP_GUARD_SQLSTATE) {
      await throwOverlapAsConflictError({
        locationId: existing.location_id,
        serviceType,
        startAt: newStart.toISOString(),
        endAt: newEnd.toISOString(),
        excludeAppointmentId: existing.id,
        repairVariant: existing.repair_variant,
        productKey: existing.product_key,
        arch: existing.arch,
      });
    }
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

  // ── 6.5 Carry over linked-table data ──────────────────────────
  // The new appointment id now exists; copy every row that was
  // attached to the old appointment over to the new one so the
  // patient's commitments (paid upgrades, repair lines, pre-visit
  // smile photos) follow them to the new slot. Best-effort —
  // failures here log but don't unwind the reschedule, since the
  // appointment row is already correct and the operator can re-
  // attach manually if a copy fails. The OLD rows stay in place
  // as a historical record; the new rows duplicate-by-design.
  await carryOverLinkedTables(existing.id, newAppointmentId);

  // ── 6.6 End any open visit attached to the old appointment ─────
  // If the patient has already been marked arrived, the visit IS
  // the historical record of that arrival and shouldn't be moved
  // to the new appointment (the visit's opened_at, JB ref, cart
  // items, payments, waiver signatures all belong to the moment
  // the patient was actually in clinic). Instead, close the visit
  // with reason='rescheduled' so reports can distinguish "visit
  // ended because the booking was wrong" from "visit ended because
  // the appointment was rescheduled". The next arrival on the new
  // slot will spawn a fresh visit. Skipped when there's no visit
  // (typical pre-arrival reschedule).
  await endVisitIfOpen(existing.id, newAppointmentId, input.reason ?? null);

  // ── 7. Google Meet (virtual impression only) ────────────────────
  // Always route through meet-create-space so the new row gets
  // meet_meeting_code + meet_space_id written — the two fields the
  // appointment-detail attendance section gates on. The legacy
  // google-meet-create path only wrote join_url + google_calendar_
  // event_id, which left rescheduled virtual bookings without an
  // attendance section even when one was working on the original
  // booking. Per-host bookings carry their host forward; bookings
  // that originated WITHOUT a host (Calendly, legacy) fall back to
  // the first active host with an OAuth refresh token so the new
  // event still lands on a real calendar that meet-fetch-attendance
  // can later authenticate against.
  //
  // Creation is awaited so join_url is persisted on the new row
  // BEFORE step 9's confirmation email reads it — otherwise the
  // email function sees join_url=null and picks the in-person
  // template instead of the virtual one. Deletion of the old event
  // stays fire-and-forget.
  if (serviceType === 'virtual_impression_appointment') {
    // The new row already carries clinician_staff_member_id (set on the
    // insert above). meet-create-space resolves the room owner from the
    // clinician — their own connected Google account if linked, else the
    // default active OAuth host.
    const clinicianId = existing.clinician_staff_member_id;
    if (clinicianId) {
      try {
        await supabase.functions.invoke('meet-create-space', {
          body: { appointment_id: newAppointmentId, clinician_staff_member_id: clinicianId },
        });
      } catch (e: unknown) {
        console.warn('[rescheduleAppointment] meet-create-space failed:', e);
      }
      // Old event cleanup: delete whichever flavour the original
      // booking used. Both calls are no-ops when the matching ids
      // aren't present on the row, so it's safe to fire both.
      void supabase.functions
        .invoke('meet-delete-event', { body: { appointment_id: existing.id } })
        .catch((e: unknown) =>
          console.warn('[rescheduleAppointment] meet-delete-event failed:', e),
        );
      void supabase.functions
        .invoke('google-meet-delete', { body: { appointmentId: existing.id } })
        .catch((e: unknown) =>
          console.warn('[rescheduleAppointment] google-meet-delete failed:', e),
        );
    } else {
      // No clinician on the row — log loud and skip Meet creation. The
      // booking row still saves; an admin can fix the clinician and
      // re-run meet-create-space.
      await supabase.from('lng_system_failures').insert({
        severity: 'error',
        source: 'rescheduleAppointment',
        message: 'No clinician on rescheduled virtual appointment; Meet room not created',
        context: {
          old_appointment_id: existing.id,
          new_appointment_id: newAppointmentId,
        },
      });
    }
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

  // ── 9. Email confirmation ──────────────────────────────────────
  // Sends a "your appointment has moved" email with a fresh REQUEST
  // .ics for the new slot AND a CANCEL .ics for the old slot, so
  // the patient's calendar updates instead of accumulating
  // duplicates. The reschedule itself does NOT unwind on email
  // failure (the appointment is moved either way), but we DO write
  // a client-side failure row so the receptionist's audit trail
  // surfaces "moved the slot, email didn't go out" instead of going
  // silent. The bare `void .catch(()=>{})` we used before swallowed
  // even the "edge function unreachable" case.
  try {
    const emailResult = await sendAppointmentConfirmation({
      appointmentId: newAppointmentId,
      oldAppointmentIdToCancel: existing.id,
    });
    if (!emailResult.ok) {
      await supabase.from('lng_system_failures').insert({
        severity: 'warning',
        source: 'rescheduleAppointment.email',
        message: `Reschedule moved but confirmation email did not send: ${emailResult.error ?? 'unknown'}`,
        context: {
          appointment_id: newAppointmentId,
          old_appointment_id: existing.id,
          reason: emailResult.reason ?? null,
        },
      });
    }
  } catch (e) {
    await supabase.from('lng_system_failures').insert({
      severity: 'warning',
      source: 'rescheduleAppointment.email',
      message: `Reschedule moved but confirmation invoke threw: ${e instanceof Error ? e.message : String(e)}`,
      context: {
        appointment_id: newAppointmentId,
        old_appointment_id: existing.id,
      },
    });
  }

  return { newAppointmentId };
}

// Copy every row keyed by the old appointment id to the new
// appointment id, across every table that hangs booking-time data
// off the appointment. The OLD rows stay in place — duplicate
// rows are deliberate so the historical record on the rescheduled
// appointment isn't lost. Best-effort: a single failure logs to
// console + lng_system_failures but doesn't unwind the reschedule.
async function carryOverLinkedTables(
  oldAppointmentId: string,
  newAppointmentId: string,
): Promise<void> {
  await Promise.all([
    copyRowsForAppointment({
      table: 'lng_appointment_upgrade_selections',
      cloneColumns: [
        'upgrade_id',
        'upgrade_code',
        'name',
        'unit_label',
        'unit_price_pence',
        'both_arches_price_pence',
        'resolved_price_pence',
      ],
      oldAppointmentId,
      newAppointmentId,
    }),
    copyRowsForAppointment({
      table: 'lng_appointment_repair_items',
      cloneColumns: [
        'catalogue_id',
        'code',
        'repair_variant',
        'name',
        'unit_label',
        'arch',
        'quantity',
        'unit_price_pence',
        'both_arches_price_pence',
        'line_total_pence',
      ],
      oldAppointmentId,
      newAppointmentId,
    }),
    copyRowsForAppointment({
      table: 'lng_booking_intake_photos',
      cloneColumns: ['kind', 'file_path', 'mime_type', 'size_bytes'],
      oldAppointmentId,
      newAppointmentId,
    }),
    copyActiveStaffNotes(oldAppointmentId, newAppointmentId),
  ]);
}

// Staff notes carry forward across a reschedule so the new
// appointment surfaces the same context the team built up on the
// original booking. Only active notes copy — soft-deleted rows are
// part of the OLD appointment's audit trail and have no place on
// the new slot. created_at + author preserve so the timeline
// shows the note in its original light.
async function copyActiveStaffNotes(
  oldAppointmentId: string,
  newAppointmentId: string,
): Promise<void> {
  const { data, error: readErr } = await supabase
    .from('lng_appointment_staff_notes')
    .select('body, author_account_id, created_at')
    .eq('appointment_id', oldAppointmentId)
    .is('deleted_at', null);
  if (readErr) {
    console.warn('[reschedule] read lng_appointment_staff_notes failed:', readErr.message);
    return;
  }
  const rows = (data ?? []) as Array<{
    body: string;
    author_account_id: string | null;
    created_at: string;
  }>;
  if (rows.length === 0) return;
  const inserts = rows.map((r) => ({
    appointment_id: newAppointmentId,
    body: r.body,
    author_account_id: r.author_account_id,
    created_at: r.created_at,
    updated_at: r.created_at,
  }));
  const { error: insertErr } = await supabase
    .from('lng_appointment_staff_notes')
    .insert(inserts);
  if (insertErr) {
    console.warn('[reschedule] copy lng_appointment_staff_notes failed:', insertErr.message);
  }
}

async function copyRowsForAppointment(args: {
  table: string;
  /** Columns to clone from the old rows into the new rows. The
   *  appointment_id pointer + the table's own primary key + audit
   *  timestamps (created_at) are excluded — pk regenerates,
   *  appointment_id swaps to the new value, created_at defaults to
   *  now() on the new row. */
  cloneColumns: string[];
  oldAppointmentId: string;
  newAppointmentId: string;
}): Promise<void> {
  const selectCols = args.cloneColumns.join(', ');
  const { data, error: readErr } = await supabase
    .from(args.table)
    .select(selectCols)
    .eq('appointment_id', args.oldAppointmentId);
  if (readErr) {
    console.warn(`[reschedule] read ${args.table} failed:`, readErr.message);
    return;
  }
  const rows = ((data ?? []) as unknown) as Array<Record<string, unknown>>;
  if (rows.length === 0) return;
  const inserts = rows.map((r) => ({
    ...r,
    appointment_id: args.newAppointmentId,
  }));
  const { error: insertErr } = await supabase.from(args.table).insert(inserts);
  if (insertErr) {
    console.warn(`[reschedule] copy ${args.table} failed:`, insertErr.message);
  }
}

// End any open visit attached to the old appointment. Sets
// status='ended_early' with reason='rescheduled' and a note that
// references the new appointment id so the audit trail is
// traceable. Skipped when the visit is already closed (or doesn't
// exist) — pre-arrival reschedules are the common case.
async function endVisitIfOpen(
  oldAppointmentId: string,
  newAppointmentId: string,
  operatorReason: string | null,
): Promise<void> {
  const { data, error: readErr } = await supabase
    .from('lng_visits')
    .select('id, status')
    .eq('appointment_id', oldAppointmentId)
    .maybeSingle();
  if (readErr) {
    console.warn('[reschedule] visit lookup failed:', readErr.message);
    return;
  }
  if (!data) return;
  const visit = data as { id: string; status: string };
  // Only the live "arrived" status warrants closing on reschedule.
  // 'complete' / 'unsuitable' / 'ended_early' are already terminal;
  // overriding them would lose the original closing reason.
  if (visit.status !== 'arrived') return;
  const note = operatorReason?.trim()
    ? `Rescheduled to appointment ${newAppointmentId}. ${operatorReason.trim()}`
    : `Rescheduled to appointment ${newAppointmentId}.`;
  const { error: updateErr } = await supabase
    .from('lng_visits')
    .update({
      status: 'ended_early',
      visit_end_reason: 'rescheduled',
      visit_end_note: note,
      closed_at: new Date().toISOString(),
    })
    .eq('id', visit.id);
  if (updateErr) {
    console.warn('[reschedule] end visit failed:', updateErr.message);
  }
}

function describeConflicts(conflicts: RescheduleConflict[]): string {
  return conflicts
    .map((c) => {
      if (c.conflict_kind === 'pool_at_capacity') {
        const phase = c.phase_label ? ` during ${c.phase_label}` : '';
        return `pool "${c.pool_id}" at capacity ${c.pool_capacity}${phase} (${c.current_count} already booked)`;
      }
      if (c.conflict_kind === 'min_notice') {
        return `slot inside the ${c.pool_capacity}-minute booking-notice window`;
      }
      return `service hits max-concurrent ${c.pool_capacity} (${c.current_count} already booked)`;
    })
    .join('; ');
}
