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

// The signed-in staff member's returns authorisation code (the one
// that gets inserted into the message they send). Null when they have
// none set — the send sheet uses this to block before anything is sent.
export async function fetchMyAuthorisationCode(): Promise<string | null> {
  const { data: accId } = await supabase.rpc('auth_account_id');
  if (!accId) return null;
  const { data } = await supabase
    .from('lng_staff_members')
    .select('authorisation_code')
    .eq('account_id', accId as string)
    .maybeSingle();
  const code = (data as { authorisation_code: string | null } | null)?.authorisation_code ?? null;
  return code && code.trim() ? code.trim() : null;
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
