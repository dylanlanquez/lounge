import { supabase } from '../supabase.ts';

// Thin wrapper around the send-appointment-confirmation edge function.
// Returns the structured outcome the edge function reports so the
// caller can branch on the reason code (e.g. show "no email on file"
// inline instead of treating it as a hard error).
//
// Five intents:
//
//   confirmation  default. Sends a REQUEST .ics for the appointment
//                 — the new-booking and reschedule flows. Reschedule
//                 also passes oldAppointmentIdToCancel so the
//                 patient's calendar removes the old slot via a
//                 paired CANCEL .ics.
//   cancellation  Sends a CANCEL .ics + a "your appointment has
//                 been cancelled" email. Caller is the cancel flow
//                 in cancelAppointment().
//   no_show       Sends a "we missed you" email. No .ics. Fired
//                 best-effort from markNoShow() after the status
//                 flip. Honours the appointment_no_show template's
//                 enabled flag, which ships disabled per booking
//                 type until the admin writes the copy.
//   walk_in       Sends a "thanks for coming in today" email against
//                 the walk-in marker appointment. No .ics: the
//                 patient is already in the building, so there is no
//                 future slot worth putting in their calendar. Fired
//                 best-effort from createWalkInVisit() once the
//                 marker row exists. Pulls walk_in_confirmation.

export type SendConfirmationReason =
  | 'delivery_not_configured'
  | 'no_email_on_patient'
  | 'appointment_not_found'
  | 'template_not_found'
  | 'template_disabled';

export type SendConfirmationKind =
  | 'booking'
  | 'reschedule'
  | 'cancellation'
  | 'no_show'
  | 'walk_in';

export type SendConfirmationResult =
  | {
      ok: true;
      kind: SendConfirmationKind;
      recipient: string;
      messageId: string | null;
    }
  | {
      ok: false;
      error: string;
      reason: SendConfirmationReason | null;
    };

export async function sendAppointmentConfirmation(args: {
  appointmentId: string;
  oldAppointmentIdToCancel?: string | null;
  intent?: 'confirmation' | 'cancellation' | 'no_show' | 'walk_in';
}): Promise<SendConfirmationResult> {
  const { data, error } = await supabase.functions.invoke<unknown>(
    'send-appointment-confirmation',
    {
      body: {
        appointmentId: args.appointmentId,
        oldAppointmentIdToCancel: args.oldAppointmentIdToCancel ?? null,
        intent: args.intent ?? 'confirmation',
      },
    },
  );
  if (error) {
    return { ok: false, error: error.message, reason: null };
  }
  const payload = (data ?? {}) as {
    ok?: boolean;
    error?: string;
    reason?: SendConfirmationReason;
    kind?: SendConfirmationKind;
    recipient?: string;
    messageId?: string | null;
  };
  if (payload.ok) {
    return {
      ok: true,
      kind: payload.kind ?? 'booking',
      recipient: payload.recipient ?? '',
      messageId: payload.messageId ?? null,
    };
  }
  return {
    ok: false,
    error: payload.error ?? 'Unknown delivery error',
    reason: payload.reason ?? null,
  };
}
