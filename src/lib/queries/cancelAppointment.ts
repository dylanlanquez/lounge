import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { logFailure } from '../failureLog.ts';
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
    .select('id, patient_id, location_id, source, status, meet_host_id')
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
    // Per-host bookings need meet-delete-event so the cancellation
    // hits the host's calendar; legacy / service-account bookings use
    // google-meet-delete instead. Both edge functions no-op on rows
    // that have no Calendar event to clean up.
    meet_host_id: string | null;
  };

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

  // Google Meet cleanup — best-effort, two-path routing matching the
  // booking-side split. Per-host appointments route through
  // meet-delete-event so the Calendar event comes off the original
  // host's calendar (Karly's, Lab's, etc.) and the patient receives a
  // proper Google cancellation. Legacy / Calendly-imported appointments
  // keep using google-meet-delete against the service-account calendar.
  if (existing.meet_host_id) {
    void supabase.functions
      .invoke('meet-delete-event', { body: { appointment_id: existing.id } })
      .catch((e: unknown) =>
        console.warn('[cancelAppointment] meet-delete-event failed:', e),
      );
  } else {
    void supabase.functions
      .invoke('google-meet-delete', { body: { appointmentId: existing.id } })
      .catch((e: unknown) =>
        console.warn('[cancelAppointment] google-meet-delete failed:', e),
      );
  }

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

// ── When was it cancelled, and by whom? ──────────────────────────────
// lng_appointments only carries the reason and a status; the moment
// and the actor live on the patient_events audit row written at
// cancellation time. The detail page reads that row so the ribbon can
// say "Cancelled 28 Aug, 14:48 BST by Karly Innes" instead of showing
// a truncated reason with no date, which left Dylan asking "when was
// this cancelled?" (7 Sep 2026).
export interface CancellationRecord {
  cancelled_at: string;
  by_name: string | null;
  email_sent_to: string | null;
}

export function useCancellationRecord(appt: {
  id: string;
  patient_id: string | null;
  status: string;
} | null): CancellationRecord | null {
  const [record, setRecord] = useState<CancellationRecord | null>(null);
  const id = appt?.id ?? null;
  const patientId = appt?.patient_id ?? null;
  const cancelled = appt?.status === 'cancelled';

  useEffect(() => {
    if (!id || !patientId || !cancelled) {
      setRecord(null);
      return;
    }
    let stale = false;
    (async () => {
      const { data, error } = await supabase
        .from('patient_events')
        .select('event_type, actor_account_id, created_at, payload')
        .eq('patient_id', patientId)
        .eq('payload->>appointment_id', id)
        .in('event_type', ['appointment_cancelled', 'appointment_cancellation_sent'])
        .order('created_at', { ascending: false });
      if (stale) return;
      if (error) {
        await logFailure({
          source: 'useCancellationRecord',
          severity: 'warning',
          message: error.message,
          context: { appointmentId: id },
        });
        return;
      }
      const rows = (data ?? []) as Array<{
        event_type: string;
        actor_account_id: string | null;
        created_at: string;
        payload: Record<string, unknown> | null;
      }>;
      const cancelledRow = rows.find((r) => r.event_type === 'appointment_cancelled');
      if (!cancelledRow) return;
      const sentRow = rows.find((r) => r.event_type === 'appointment_cancellation_sent');
      let byName: string | null = null;
      if (cancelledRow.actor_account_id) {
        const { data: actor } = await supabase
          .from('accounts')
          .select('first_name, last_name, name')
          .eq('id', cancelledRow.actor_account_id)
          .maybeSingle();
        if (stale) return;
        const a = actor as { first_name: string | null; last_name: string | null; name: string | null } | null;
        const full = [a?.first_name, a?.last_name].filter(Boolean).join(' ').trim();
        byName = full || a?.name || null;
      }
      const recipient = sentRow?.payload?.recipient;
      setRecord({
        cancelled_at: cancelledRow.created_at,
        by_name: byName,
        email_sent_to: typeof recipient === 'string' ? recipient : null,
      });
    })();
    return () => {
      stale = true;
    };
  }, [id, patientId, cancelled]);

  return record;
}
