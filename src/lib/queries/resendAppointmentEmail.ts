import { supabase } from '../supabase.ts';

// Resend dispatchers for the Timeline's per-event "Resend" pill.
//
// Two paths:
//   • Per-kind (confirmation / cancellation / reminder) — routes
//     through the bespoke senders so the email is re-rendered against
//     current appointment + patient data. A reschedule between original
//     send and resend produces the right new time, not a stale snapshot.
//   • Generic (anything with a persisted lng_email_messages row, e.g.
//     receipts, dispatch confirmations) — replays the persisted HTML
//     to the patient's CURRENT email via lng-resend-email. Receipts
//     and dispatch notifications are immutable historical records; the
//     only thing that should shift on a resend is the recipient.
//
// Both routes update patients.email lookups at send time, so a resend
// always lands in the patient's most up-to-date address even if the
// original to_email is stale.

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

// Generic email replay used by every timeline row whose origin doesn't
// have a per-kind sender — receipts, dispatch confirmations, anything
// future. The persisted lng_email_messages row is the source of truth
// for subject + html + text; only the recipient is recalculated.
export async function resendEmailByMessageId(
  emailMessageId: string,
): Promise<ResendResult> {
  const { data, error } = await supabase.functions.invoke<unknown>(
    'lng-resend-email',
    { body: { emailMessageId } },
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
