import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useRealtimeRefresh } from '../useRealtimeRefresh.ts';

// useLatestSmsForVisit — resolves the most recent SMS row for a
// (visit, template_key) pair so the Patient Comms card can show the
// actual delivery state for whichever template the receptionist has
// selected. Replaces the old visit_ready-only hook; the card now
// switches templates inline.
//
// Realtime subscription on lng_sms_messages keeps the row fresh
// the moment Twilio's status callback flips 'pending' → 'sent' /
// 'failed'. Without realtime the receptionist would see "Sending"
// indefinitely or have to refresh manually after a delivery
// receipt — which is exactly the friction that lets a "bad number"
// situation walk in the door.

export interface VisitSmsRow {
  id: string;
  template_key: string | null;
  to_phone: string;
  body: string;
  send_status: 'pending' | 'sent' | 'failed';
  send_error: string | null;
  twilio_message_sid: string | null;
  sent_at: string;
}

// Legacy alias kept so existing import sites don't have to update
// in this same diff. Prefer VisitSmsRow in new code.
export type VisitReadySmsRow = VisitSmsRow;

interface State {
  data: VisitSmsRow | null;
  loading: boolean;
  error: string | null;
}

export function useLatestSmsForVisit(
  visitId: string | null,
  templateKey: string | null,
): State & {
  refresh: () => void;
} {
  const [state, setState] = useState<State>({
    data: null,
    loading: !!(visitId && templateKey),
    error: null,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!visitId || !templateKey) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      const { data, error } = await supabase
        .from('lng_sms_messages')
        .select('id, template_key, to_phone, body, send_status, send_error, twilio_message_sid, sent_at')
        .eq('visit_id', visitId)
        .eq('template_key', templateKey)
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setState({ data: null, loading: false, error: error.message });
        return;
      }
      setState({ data: (data as VisitSmsRow | null) ?? null, loading: false, error: null });
    })();
    return () => {
      cancelled = true;
    };
  }, [visitId, templateKey, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Realtime: any change on lng_sms_messages for this visit triggers
  // a refetch. Filter is broad (any row whose visit_id matches) — the
  // SELECT above narrows to the most recent row for the selected
  // template, so an unrelated SMS firing on the same visit will also
  // bump this hook, which is fine; refetch is cheap and idempotent.
  useRealtimeRefresh(
    visitId ? [{ table: 'lng_sms_messages', filter: `visit_id=eq.${visitId}` }] : [],
    refresh,
  );

  return { ...state, refresh };
}

// ─────────────────────────────────────────────────────────────────
// Twilio carrier error code → human-readable description
//
// Surfaces on the Patient Comms card when send_status='failed'. The
// receptionist sees "30005 Unknown destination handset", which is
// accurate but useless to a non-Twilio expert. This dictionary
// translates the most common errors into "what actually happened +
// what to do" sentences.
//
// Source: https://www.twilio.com/docs/api/errors — refreshed by
// hand when we encounter codes we haven't seen before. Codes not in
// this map fall through to a generic "Twilio reported it failed"
// line plus the raw code so the receptionist can paste it into a
// support ticket.
// ─────────────────────────────────────────────────────────────────

interface ErrorExplain {
  /** What went wrong, in one sentence. */
  what: string;
  /** What the receptionist should do next, in one sentence. */
  fix: string;
}

const ERROR_MAP: Record<string, ErrorExplain> = {
  '30003': {
    what: "The patient's phone is unreachable (off, out of coverage, or rejecting messages).",
    fix: 'Call them, or try again later. If it keeps failing, double-check the number on their profile.',
  },
  '30004': {
    what: "The number is blocked from receiving SMS (the patient opted out via STOP, or the carrier flagged us).",
    fix: 'Call the patient instead — automated SMS will keep being blocked until they reply START.',
  },
  '30005': {
    what: "The carrier couldn't find the patient's handset — number is wrong, deactivated, or not in service.",
    fix: 'Verify the number on the patient profile and resend. If correct, the SIM may be dead.',
  },
  '30006': {
    what: 'The number is a landline or VoIP line that does not accept SMS.',
    fix: 'Call the patient — SMS will never deliver to this number.',
  },
  '30007': {
    what: "The carrier filtered the message as spam.",
    fix: 'Try once more; if it keeps failing the carrier may need our sender ID whitelisted.',
  },
  '30008': {
    what: 'Unknown error from the carrier.',
    fix: 'Resend; if it keeps failing, call the patient and flag it on the daily handover.',
  },
  '30009': {
    what: 'Carrier filter blocked the message body (e.g. content matched a spam rule).',
    fix: 'Try rewording the visit_ready template in Admin → Emails & SMS, or call the patient.',
  },
  '21211': {
    what: "Twilio rejected the number format — the value on the patient profile isn't a valid phone number.",
    fix: 'Fix the number on the patient profile (UK mobiles look like +447xxxxxxxxx).',
  },
  '21408': {
    what: 'Twilio account is in trial mode and the patient number isn\'t on the verified list.',
    fix: "Upgrade the Twilio account, or add the patient's number to Twilio's Verified Caller IDs.",
  },
  '21610': {
    what: 'The patient has opted out of SMS (replied STOP previously).',
    fix: 'Call them — they need to reply START to us to re-enable SMS.',
  },
};

// One persisted SMS row, fetched by id for the TimelineCard's "View
// SMS" pill. Mirrors useEmailMessage — same shape, same lifecycle —
// so the timeline pattern reads identically across both channels.
export interface SmsMessageRow {
  id: string;
  patient_id: string | null;
  visit_id: string | null;
  appointment_id: string | null;
  template_key: string | null;
  to_phone: string;
  body: string;
  send_status: 'pending' | 'sent' | 'failed';
  send_error: string | null;
  twilio_message_sid: string | null;
  sent_at: string;
  sent_by: string | null;
}

export function useSmsMessage(id: string | null | undefined): {
  data: SmsMessageRow | null;
  loading: boolean;
  error: string | null;
} {
  const [data, setData] = useState<SmsMessageRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!id);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!id) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const { data: row, error: err } = await supabase
        .from('lng_sms_messages')
        .select(
          'id, patient_id, visit_id, appointment_id, template_key, to_phone, body, send_status, send_error, twilio_message_sid, sent_at, sent_by',
        )
        .eq('id', id)
        .maybeSingle();
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      setData((row as SmsMessageRow | null) ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, tick]);

  // Realtime: status callbacks flip send_status from 'pending' →
  // 'sent' / 'failed' after the modal is already open. Without this
  // the receptionist would see a stale "Sending..." status in the
  // preview even though the message has since delivered.
  useRealtimeRefresh(
    id ? [{ table: 'lng_sms_messages', filter: `id=eq.${id}` }] : [],
    useCallback(() => setTick((t) => t + 1), []),
  );

  return { data, loading, error };
}

/** Look up a Twilio carrier error code in the dictionary and return
 *  a structured explanation. Accepts the raw `send_error` column
 *  value (which is shaped "code message...") OR just the bare
 *  code. Returns null when the input is empty / unparseable so
 *  callers can fall back to a generic message. */
export function explainSmsError(sendError: string | null): ErrorExplain | null {
  if (!sendError) return null;
  // Try to pull a 4–5 digit code out of the prefix.
  const m = sendError.match(/^\s*(\d{4,5})\b/);
  const code = m?.[1];
  if (!code) return null;
  return ERROR_MAP[code] ?? null;
}
