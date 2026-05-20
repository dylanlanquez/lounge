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
//
// Editable fields (v1):
//
//   notes                  free text shown on the schedule card
//                          and the patient profile
//   staff_account_id       optional FK to accounts.id; null clears
//                          the assignment
//
// Why no email on edit: the patient doesn't need to know about
// internal note edits, and a staff reassignment isn't visible on
// their side. If the operator wants to communicate a change they
// can resend the confirmation manually from the same detail card.

export interface EditAppointmentResult {
  ok: true;
}

export async function editAppointment(input: {
  appointmentId: string;
  notes?: string | null;
  staffAccountId?: string | null;
}): Promise<EditAppointmentResult> {
  const { data: existingRaw, error: readErr } = await supabase
    .from('lng_appointments')
    .select('id, patient_id, source, status, notes, staff_account_id')
    .eq('id', input.appointmentId)
    .maybeSingle();
  if (readErr) throw new Error(`Couldn't read appointment: ${readErr.message}`);
  if (!existingRaw) throw new Error('Appointment not found.');
  const existing = existingRaw as {
    id: string;
    patient_id: string;
    source: 'calendly' | 'manual' | 'native';
    status: string;
    notes: string | null;
    staff_account_id: string | null;
  };

  // Build the patch first so we can scope the source/status gates to
  // the fields that actually conflict with them.
  // Undefined means "leave it alone"; null is a deliberate clear.
  const patch: Record<string, unknown> = {};
  if (input.notes !== undefined) {
    const trimmed = input.notes?.trim() ?? '';
    patch.notes = trimmed.length === 0 ? null : trimmed;
  }
  if (input.staffAccountId !== undefined) {
    patch.staff_account_id = input.staffAccountId || null;
  }

  // Source and status gates only apply to fields that conflict with
  // them. Notes are a Lounge-internal field — Calendly doesn't carry
  // them, and a completed / cancelled visit can still legitimately
  // need notes added (a hand-off comment, a follow-up reminder for
  // next time the patient comes in). staff_account_id changes still
  // need an active appointment whose source we own.
  const isNotesOnly =
    'notes' in patch && !('staff_account_id' in patch);
  if (!isNotesOnly) {
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
  }

  if (Object.keys(patch).length === 0) {
    // Nothing to write. Treat as ok rather than throwing — the
    // caller's "Save" button shouldn't error just because the
    // operator opened then closed without changing anything.
    return { ok: true };
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
        notes:
          'notes' in patch
            ? { from: existing.notes, to: patch.notes ?? null }
            : undefined,
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
