import { supabase } from '../supabase.ts';

// Send a patient their DPD return label + authorisation code via email
// and/or SMS. Backed by the send-returns-info edge function (which uses
// the editable 'returns' templates and the sending staff's code).

export type ReturnsChannelResult =
  | { status: 'sent' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

export interface ReturnsSendResponse {
  ok: boolean;
  error?: string;
  reason?: string;
  email?: ReturnsChannelResult;
  sms?: ReturnsChannelResult;
}

export async function sendReturnsInfo(args: {
  appointmentId: string;
  email: boolean;
  sms: boolean;
}): Promise<ReturnsSendResponse> {
  // The edge function always responds 200 (even on a soft failure), so
  // the result lives in `data`; a transport-level error is the only
  // thing surfaced via `error`.
  const { data, error } = await supabase.functions.invoke('send-returns-info', {
    body: { appointment_id: args.appointmentId, email: args.email, sms: args.sms },
  });
  if (error) return { ok: false, error: error.message };
  return (data ?? { ok: false, error: 'No response from server.' }) as ReturnsSendResponse;
}
