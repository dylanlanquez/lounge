import { supabase } from '../supabase.ts';

// Edit a native (manual / native-source) Lounge appointment in
// place. For changes to the field set below; everything else has
// its own dedicated flow:
//
//   time / date            → rescheduleAppointment (conflict check
//                            against the new slot, paired CANCEL +
//                            REQUEST email)
//   service type           → reschedule (changes conflict semantics
//                            via the booking type's pool list)
//   status                 → markNoShow / arrival flow / cancel
//   patient                → no flow; cancel + rebook if wrong
//   staff notes            → StaffNotesCard + appointmentStaffNotes
//                            (multi-note table with author + audit)
//
// Editable fields (v1):
//
//   staff_account_id       optional FK to accounts.id; null clears
//                          the assignment
//
// Notes used to live here too. They moved to a dedicated multi-note
// table with author byline and soft-delete + audit on 21 May 2026
// (lng_appointment_staff_notes). Anything that needs to write a
// note goes through appointmentStaffNotes.addStaffNote / amendStaffNote /
// deleteStaffNote.

export interface EditAppointmentResult {
  ok: true;
}

export async function editAppointment(input: {
  appointmentId: string;
  staffAccountId?: string | null;
}): Promise<EditAppointmentResult> {
  const { data: existingRaw, error: readErr } = await supabase
    .from('lng_appointments')
    .select('id, patient_id, source, status, staff_account_id')
    .eq('id', input.appointmentId)
    .maybeSingle();
  if (readErr) throw new Error(`Couldn't read appointment: ${readErr.message}`);
  if (!existingRaw) throw new Error('Appointment not found.');
  const existing = existingRaw as {
    id: string;
    patient_id: string;
    source: 'calendly' | 'manual' | 'native';
    status: string;
    staff_account_id: string | null;
  };

  const patch: Record<string, unknown> = {};
  if (input.staffAccountId !== undefined) {
    patch.staff_account_id = input.staffAccountId || null;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: true };
  }

  if (existing.source === 'calendly') {
    throw new Error(
      "Calendly-sourced bookings can't be edited here. The source of truth is Calendly itself.",
    );
  }
  if (
    existing.status === 'cancelled' ||
    existing.status === 'no_show' ||
    existing.status === 'complete' ||
    existing.status === 'rescheduled'
  ) {
    throw new Error(`Can't edit an appointment with status "${existing.status}".`);
  }

  const { error: updateErr } = await supabase
    .from('lng_appointments')
    .update(patch)
    .eq('id', existing.id);
  if (updateErr) throw new Error(`Couldn't update appointment: ${updateErr.message}`);

  // patient_events audit row — best-effort, doesn't unwind the
  // edit if it fails. Records the diff so the timeline shows what
  // actually changed.
  const { data: actorAccountIdRaw } = await supabase.rpc('auth_account_id');
  const actorAccountId = (actorAccountIdRaw as string | null) ?? null;
  await supabase.from('patient_events').insert({
    patient_id: existing.patient_id,
    event_type: 'appointment_edited',
    actor_account_id: actorAccountId,
    payload: {
      appointment_id: existing.id,
      changes: {
        staff_account_id:
          'staff_account_id' in patch
            ? {
                from: existing.staff_account_id,
                to: patch.staff_account_id ?? null,
              }
            : undefined,
      },
    },
  });

  return { ok: true };
}
