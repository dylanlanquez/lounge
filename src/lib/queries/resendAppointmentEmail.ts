import { supabase } from '../supabase.ts';

// Resend dispatcher for the Timeline's per-event "Resend" pill. Routes
// each kind to the underlying sender, which re-renders against current
// data and reads patients.email at send time — so a resend always
// lands in the patient's most up-to-date address even if the
// historical lng_email_messages.to_email is stale.

export type ResendKind = 'confirmation' | 'cancellation' | 'reminder';

export interface ResendResult {
  ok: boolean;
  recipient: string | null;
  error: string | null;
}

export async function resendAppointmentEmail(args: {
  kind: ResendKind;
  appointmentId: string;
}): Promise<ResendResult> {
  if (args.kind === 'reminder') {
    const { data, error } = await supabase.functions.invoke<unknown>(
      'send-appointment-reminders',
      { body: { appointmentId: args.appointmentId } },
    );
    if (error) return { ok: false, recipient: null, error: error.message };
    const payload = (data ?? {}) as {
      ok?: boolean;
      sent?: number;
      failed?: number;
      error?: string;
      errors?: Array<{ reason?: string }>;
    };
    if (!payload.ok || (payload.sent ?? 0) === 0) {
      const reason =
        payload.errors?.[0]?.reason ?? payload.error ?? 'Reminder delivery failed';
      return { ok: false, recipient: null, error: reason };
    }
    return { ok: true, recipient: null, error: null };
  }

  // confirmation + cancellation share the same edge function; intent
  // tells it which template + .ics to dispatch.
  const intent: 'confirmation' | 'cancellation' =
    args.kind === 'cancellation' ? 'cancellation' : 'confirmation';
  const { data, error } = await supabase.functions.invoke<unknown>(
    'send-appointment-confirmation',
    { body: { appointmentId: args.appointmentId, intent } },
  );
  if (error) return { ok: false, recipient: null, error: error.message };
  const payload = (data ?? {}) as {
    ok?: boolean;
    error?: string;
    recipient?: string;
  };
  if (!payload.ok) {
    return { ok: false, recipient: null, error: payload.error ?? 'Send failed' };
  }
  return { ok: true, recipient: payload.recipient ?? null, error: null };
}
