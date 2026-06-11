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

export interface ReturnsPreview {
  ok: boolean;
  preview?: boolean;
  // Whether the signed-in sender has an authorisation code set. When
  // false the sheet blocks sending (the message can't go without one).
  hasAuthCode?: boolean;
  email?: { subject: string; html: string; text: string };
  sms?: { body: string };
  error?: string;
}

// Render the returns email + SMS for an appointment WITHOUT sending, so
// the sheet can show the operator exactly what the patient will get
// (rendered with the real patient name, the sender's code, the link).
export async function previewReturnsInfo(
  appointmentId: string,
  firstName?: string,
): Promise<ReturnsPreview> {
  const { data, error } = await supabase.functions.invoke('send-returns-info', {
    body: { appointment_id: appointmentId, preview: true, first_name: firstName?.trim() || undefined },
  });
  if (error) return { ok: false, error: error.message };
  return (data ?? { ok: false, error: 'No response from server.' }) as ReturnsPreview;
}

export async function sendReturnsInfo(args: {
  appointmentId: string;
  email: boolean;
  sms: boolean;
  // Optional override for the greeting name (e.g. when the patient
  // record holds a placeholder like "Customer").
  firstName?: string;
}): Promise<ReturnsSendResponse> {
  // The edge function always responds 200 (even on a soft failure), so
  // the result lives in `data`; a transport-level error is the only
  // thing surfaced via `error`.
  const { data, error } = await supabase.functions.invoke('send-returns-info', {
    body: {
      appointment_id: args.appointmentId,
      email: args.email,
      sms: args.sms,
      first_name: args.firstName?.trim() || undefined,
    },
  });
  if (error) return { ok: false, error: error.message };
  return (data ?? { ok: false, error: 'No response from server.' }) as ReturnsSendResponse;
}
