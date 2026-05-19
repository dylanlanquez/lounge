// _shared/smsRecord.ts
//
// One-call helper that persists every transactional SMS Lounge fires
// via Twilio. Mirrors _shared/emailRecord.ts so the two channels
// have the same shape on disk and the Timeline can swap "View
// email" for "View SMS" without any plumbing divergence.
//
// Edge functions call this immediately AFTER the Twilio send (or
// after capturing the failure) and stamp the returned id onto the
// matching patient_events.payload.sms_message_id, so the Timeline's
// "View SMS" button can fetch the row and pop a faithful preview.
//
// Failure is non-fatal: if the persistence write fails (network,
// RLS, schema drift), the Twilio send itself still succeeded and we
// return null rather than throw. The caller is expected to handle
// null by skipping the patient_events stamp — the underlying SMS
// reached the patient regardless.

type AdminLike = {
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => {
      select: (cols: string) => {
        single: () => Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
};

export interface RecordSmsArgs {
  patient_id?: string | null;
  appointment_id?: string | null;
  visit_id?: string | null;
  location_id?: string | null;
  template_key?: string | null;
  to_phone: string;
  body: string;
  send_status: 'sent' | 'failed' | 'pending';
  send_error?: string | null;
  twilio_message_sid?: string | null;
  sent_by?: string | null;
  sent_at?: string | null;
}

export async function recordSmsMessage(
  admin: AdminLike,
  args: RecordSmsArgs,
): Promise<string | null> {
  try {
    const row = {
      patient_id: args.patient_id ?? null,
      appointment_id: args.appointment_id ?? null,
      visit_id: args.visit_id ?? null,
      location_id: args.location_id ?? null,
      template_key: args.template_key ?? null,
      to_phone: args.to_phone,
      body: args.body,
      send_status: args.send_status,
      send_error: args.send_error ?? null,
      twilio_message_sid: args.twilio_message_sid ?? null,
      sent_by: args.sent_by ?? null,
      sent_at: args.sent_at ?? new Date().toISOString(),
    };
    const { data, error } = await admin
      .from('lng_sms_messages')
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
