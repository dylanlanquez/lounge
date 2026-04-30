import { supabase } from '../supabase.ts';

// Send a signed waiver PDF to a recipient via the email-waiver
// Meridian function. Mirrors staffUpdatePatient's posture: any
// transport error or ok:false response throws with the detail
// already logged to lng_system_failures by the function. The
// thrown error carries an `errorKind` tag so the caller's UI can
// show the same kind code that appears in the failures table.

export interface EmailWaiverInput {
  visitId: string;
  recipientEmail: string;
  pdfBase64: string;
  fileName: string;
  subject?: string;
  message?: string;
}

export interface EmailWaiverResult {
  resendId: string | null;
}

export async function emailWaiver(input: EmailWaiverInput): Promise<EmailWaiverResult> {
  const { data, error } = await supabase.functions.invoke('email-waiver', {
    body: {
      visit_id: input.visitId,
      recipient_email: input.recipientEmail,
      pdf_base64: input.pdfBase64,
      file_name: input.fileName,
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.message ? { message: input.message } : {}),
    },
  });
  if (error) {
    // eslint-disable-next-line no-console
    console.error('[email-waiver] transport error', error);
    throw new Error(error.message);
  }
  if (!data?.ok) {
    // eslint-disable-next-line no-console
    console.error('[email-waiver] rejected', data);
    const err = new Error(data?.detail ?? data?.error ?? 'email_failed');
    (err as Error & { errorKind?: string }).errorKind =
      typeof data?.error === 'string' ? data.error : 'email_failed';
    throw err;
  }
  return { resendId: typeof data?.resend_id === 'string' ? data.resend_id : null };
}
