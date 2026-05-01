import { supabase } from '../supabase.ts';

// Thin wrapper around the send-appointment-confirmation edge function.
// Returns the structured outcome the edge function reports so the
// caller can branch on the reason code (e.g. show "no email on file"
// inline instead of treating it as a hard error).

export type SendConfirmationReason =
  | 'delivery_not_configured'
  | 'no_email_on_patient'
  | 'appointment_not_found';

export type SendConfirmationResult =
  | {
      ok: true;
      kind: 'booking' | 'reschedule';
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
}): Promise<SendConfirmationResult> {
  const { data, error } = await supabase.functions.invoke<unknown>(
    'send-appointment-confirmation',
    {
      body: {
        appointmentId: args.appointmentId,
        oldAppointmentIdToCancel: args.oldAppointmentIdToCancel ?? null,
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
    kind?: 'booking' | 'reschedule';
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
