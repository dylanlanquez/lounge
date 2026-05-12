import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';

// One persisted transactional email row, populated by every send-* edge
// function that records via `_shared/emailRecord.ts`. The Timeline's
// "View email" button hands an id to this hook and pops a faithful
// preview of the exact bytes the patient received (subject + html + the
// dispatch metadata Resend needed to deliver it).

export interface EmailMessageRow {
  id: string;
  created_at: string;
  sent_at: string | null;
  patient_id: string | null;
  appointment_id: string | null;
  visit_id: string | null;
  location_id: string | null;
  template_key: string | null;
  kind: string | null;
  subject: string;
  html: string;
  body_text: string | null;
  to_email: string;
  from_email: string | null;
  reply_to: string | null;
  provider: string;
  provider_message_id: string | null;
  send_status: 'sent' | 'failed';
  send_error: string | null;
  sent_by_account_id: string | null;
}

interface Result {
  data: EmailMessageRow | null;
  loading: boolean;
  error: string | null;
}

export function useEmailMessage(id: string | null | undefined): Result {
  const [data, setData] = useState<EmailMessageRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { loading, settle } = useStaleQueryLoading(`email-message|${id ?? ''}`);

  useEffect(() => {
    if (!id) {
      setData(null);
      setError(null);
      settle();
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: row, error: err } = await supabase
        .from('lng_email_messages')
        .select(
          'id, created_at, sent_at, patient_id, appointment_id, visit_id, location_id, template_key, kind, subject, html, body_text, to_email, from_email, reply_to, provider, provider_message_id, send_status, send_error, sent_by_account_id',
        )
        .eq('id', id)
        .maybeSingle();
      if (cancelled) return;
      if (err) {
        setError(err.message);
        settle();
        return;
      }
      setData((row as EmailMessageRow | null) ?? null);
      setError(null);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [id, settle]);

  return { data, loading, error };
}
