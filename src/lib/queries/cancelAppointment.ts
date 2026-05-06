import { supabase } from '../supabase.ts';
import { sendAppointmentConfirmation } from './sendAppointmentConfirmation.ts';

// Cancel a native (manual / native-source) Lounge appointment.
//
// Order of operations:
//
//   1. Read the existing row (location, patient, source, status).
//   2. Source guard — Calendly-source rows can't be cancelled here;
//      that has to happen on Calendly. The reschedule helper has the
//      same guard for the same reason. Surfaces a clear error so
//      staff don't expect the cancel to flow through.
//   3. Status guard — already-terminal rows are no-ops; an arrived
//      booking has a live visit, staff should void the cart there
//      instead. Allowed start state: booked.
//   4. Update the row: status='cancelled', cancel_reason.
//   5. Emit patient_events 'appointment_cancelled' for the timeline.
//   6. Best-effort: send a cancellation email + CANCEL .ics so the
//      patient's calendar removes the slot. Failure here doesn't
//      unwind the cancellation — the row is already cancelled and
//      the operator can resend manually if needed.
//
// On any post-step-4 failure the cancellation persists (DB state is
// internally consistent). The patient_events insert and the email
// are both best-effort.

export interface CancelAppointmentResult {
  ok: true;
  emailSent: boolean;
  emailReason: string | null;
}

export async function cancelAppointment(input: {
  appointmentId: string;
  reason?: string;
  // Defaults to true. The UI always offers staff the choice; passing
  // false skips the email entirely (useful when the patient has
  // already been informed by phone, or when staff prefers to phrase
  // the cancellation themselves).
  notifyPatient?: boolean;
}): Promise<CancelAppointmentResult> {
  const { data: existingRaw, error: readErr } = await supabase
    .from('lng_appointments')
    .select('id, patient_id, location_id, source, status')
    .eq('id', input.appointmentId)
    .maybeSingle();
  if (readErr) throw new Error(`Couldn't read appointment: ${readErr.message}`);
  if (!existingRaw) throw new Error('Appointment not found.');
  const existing = existingRaw as {
    id: string;
    patient_id: string;
    location_id: string;
    source: 'calendly' | 'manual' | 'native';
    status: string;
  };

  // Note: google_calendar_event_id is checked inside google-meet-delete
  // so we don't need to read it here — the edge function no-ops on rows
  // that have no calendar event.

  if (existing.source === 'calendly') {
    throw new Error(
      'Calendly-sourced bookings cancel on Calendly. Cancel from the Calendly dashboard directly.',
    );
  }
  if (
    existing.status === 'cancelled' ||
    existing.status === 'no_show' ||
    existing.status === 'complete' ||
    existing.status === 'rescheduled'
  ) {
    throw new Error(`Can't cancel an appointment with status "${existing.status}".`);
  }
  // 'arrived' / 'joined' bookings are active. Cancelling here would
  // orphan any in-progress work; void from the visit page instead.
  if (existing.status === 'arrived' || existing.status === 'joined') {
    throw new Error(
      'This visit is in progress. Void the cart from the visit page instead of cancelling here.',
    );
  }

  const { error: updateErr } = await supabase
    .from('lng_appointments')
    .update({
      status: 'cancelled',
      cancel_reason: input.reason?.trim() ? input.reason.trim() : null,
    })
    .eq('id', existing.id);
  if (updateErr) throw new Error(`Couldn't cancel appointment: ${updateErr.message}`);

  // Google Meet cleanup — best-effort. The edge function is a no-op
  // on non-virtual appointments and on rows that have no event_id.
  void supabase.functions
    .invoke('google-meet-delete', { body: { appointmentId: existing.id } })
    .catch((e: unknown) =>
      console.warn('[cancelAppointment] google-meet-delete failed:', e),
    );

  // patient_events audit row — best-effort, doesn't unwind the
  // cancellation if it fails.
  const { data: actorAccountIdRaw } = await supabase.rpc('auth_account_id');
  const actorAccountId = (actorAccountIdRaw as string | null) ?? null;
  await supabase.from('patient_events').insert({
    patient_id: existing.patient_id,
    event_type: 'appointment_cancelled',
    actor_account_id: actorAccountId,
    payload: {
      appointment_id: existing.id,
      reason: input.reason?.trim() ?? null,
      previous_status: existing.status,
    },
  });

  // Cancellation email — best-effort. The edge function logs to
  // lng_system_failures internally; we just record the human-friendly
  // reason for the toast.
  let emailSent = false;
  let emailReason: string | null = null;
  if (input.notifyPatient !== false) {
    try {
      const result = await sendAppointmentConfirmation({
        appointmentId: existing.id,
        intent: 'cancellation',
      });
      if (result.ok) {
        emailSent = true;
      } else {
        emailReason = result.reason ?? result.error;
      }
    } catch (e) {
      emailReason = e instanceof Error ? e.message : 'send_failed';
    }
  }

  return { ok: true, emailSent, emailReason };
}

// Reverses a cancellation. Used by AppointmentDetail when staff
// realise they cancelled the wrong row, or the patient changed their
// mind in time. Clears cancel_reason and flips status back to
// 'booked'. Symmetrical with reverseNoShow in visits.ts.
//
// Notify-patient is opt-in via notifyPatient=true (default off): we
// don't want to spam confirmation emails by default for an internal
// correction. When the caller asks for it, we route through the
// same confirmation path used at booking time.
export async function reverseCancellation(input: {
  appointmentId: string;
  notifyPatient?: boolean;
}): Promise<{ ok: true; emailSent: boolean; emailReason: string | null }> {
  const { data: existingRaw, error: readErr } = await supabase
    .from('lng_appointments')
    .select('id, patient_id, status')
    .eq('id', input.appointmentId)
    .maybeSingle();
  if (readErr) throw new Error(`Couldn't read appointment: ${readErr.message}`);
  if (!existingRaw) throw new Error('Appointment not found.');
  const existing = existingRaw as { id: string; patient_id: string; status: string };
  if (existing.status !== 'cancelled') {
    throw new Error(`Only cancelled appointments can be reversed (current status: ${existing.status}).`);
  }

  const { error: updateErr } = await supabase
    .from('lng_appointments')
    .update({ status: 'booked', cancel_reason: null })
    .eq('id', existing.id);
  if (updateErr) {
    throw new Error(`Couldn't reverse cancellation: ${updateErr.message}`);
  }

  // Audit row so the timeline shows the reversal explicitly. Best-
  // effort — the cancel-reverse stands even if the audit insert fails
  // (the lng_appointments status update is the source of truth).
  const { data: actorAccountIdRaw } = await supabase.rpc('auth_account_id');
  const actorAccountId = (actorAccountIdRaw as string | null) ?? null;
  await supabase.from('patient_events').insert({
    patient_id: existing.patient_id,
    event_type: 'appointment_cancellation_reversed',
    actor_account_id: actorAccountId,
    payload: { appointment_id: existing.id },
  });

  let emailSent = false;
  let emailReason: string | null = null;
  if (input.notifyPatient === true) {
    try {
      const result = await sendAppointmentConfirmation({
        appointmentId: existing.id,
        intent: 'confirmation',
      });
      if (result.ok) {
        emailSent = true;
      } else {
        emailReason = result.reason ?? result.error;
      }
    } catch (e) {
      emailReason = e instanceof Error ? e.message : 'send_failed';
    }
  }

  return { ok: true, emailSent, emailReason };
}
