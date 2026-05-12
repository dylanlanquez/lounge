// _shared/emailRecord.ts
//
// One-call helper that persists the rendered HTML of every transactional
// email Lounge sends. Every send-* edge function calls this BEFORE / AFTER
// the Resend dispatch; the returned id is then placed onto the matching
// patient_events.payload.email_message_id so the Timeline's "View email"
// button can fetch the row and pop a faithful preview.
//
// Failure is non-fatal: if the persistence write fails (network, RLS,
// schema drift), the send itself still succeeded and we return null
// rather than throw. Loud-failure rule applies — the caller is expected
// to fall back to logFailure when this returns null AND the surrounding
// send succeeded, so the missing audit row never goes unnoticed.

type AdminLike = {
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => {
      select: (cols: string) => {
        single: () => Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
};

export interface RecordEmailArgs {
  patient_id?: string | null;
  appointment_id?: string | null;
  visit_id?: string | null;
  location_id?: string | null;
  template_key?: string | null;
  kind: string;
  subject: string;
  html: string;
  body_text?: string | null;
  to_email: string;
  from_email?: string | null;
  reply_to?: string | null;
  provider?: string;
  provider_message_id?: string | null;
  send_status?: 'sent' | 'failed';
  send_error?: string | null;
  sent_by_account_id?: string | null;
  sent_at?: string | null;
}

export async function recordEmailMessage(
  admin: AdminLike,
  args: RecordEmailArgs,
): Promise<string | null> {
  try {
    const row = {
      patient_id: args.patient_id ?? null,
      appointment_id: args.appointment_id ?? null,
      visit_id: args.visit_id ?? null,
      location_id: args.location_id ?? null,
      template_key: args.template_key ?? null,
      kind: args.kind,
      subject: args.subject,
      html: args.html,
      body_text: args.body_text ?? null,
      to_email: args.to_email,
      from_email: args.from_email ?? null,
      reply_to: args.reply_to ?? null,
      provider: args.provider ?? 'resend',
      provider_message_id: args.provider_message_id ?? null,
      send_status: args.send_status ?? 'sent',
      send_error: args.send_error ?? null,
      sent_by_account_id: args.sent_by_account_id ?? null,
      sent_at: args.sent_at ?? new Date().toISOString(),
    };
    const { data, error } = await admin
      .from('lng_email_messages')
      .insert(row)
      .select('id')
      .single();
    if (error || !data) return null;
    const id = (data as { id?: string }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
