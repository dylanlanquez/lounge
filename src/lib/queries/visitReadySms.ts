import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useRealtimeRefresh } from '../useRealtimeRefresh.ts';

// useLatestVisitReadySms — resolves the most recent visit_ready SMS
// row for a visit so the Patient Comms card can show the actual
// delivery state instead of forgetting after the receptionist
// dismisses the success toast.
//
// Realtime subscription on lng_sms_messages keeps the row fresh
// the moment Twilio's status callback flips 'pending' → 'sent' /
// 'failed'. Without realtime the receptionist would see "Sending"
// indefinitely or have to refresh manually after a delivery
// receipt — which is exactly the friction that lets a "bad number"
// situation walk in the door.

export interface VisitReadySmsRow {
  id: string;
  to_phone: string;
  body: string;
  send_status: 'pending' | 'sent' | 'failed';
  send_error: string | null;
  twilio_message_sid: string | null;
  sent_at: string;
}

interface State {
  data: VisitReadySmsRow | null;
  loading: boolean;
  error: string | null;
}

export function useLatestVisitReadySms(visitId: string | null): State & {
  refresh: () => void;
} {
  const [state, setState] = useState<State>({ data: null, loading: !!visitId, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!visitId) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      const { data, error } = await supabase
        .from('lng_sms_messages')
        .select('id, to_phone, body, send_status, send_error, twilio_message_sid, sent_at')
        .eq('visit_id', visitId)
        .eq('template_key', 'visit_ready')
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setState({ data: null, loading: false, error: error.message });
        return;
      }
      setState({ data: (data as VisitReadySmsRow | null) ?? null, loading: false, error: null });
    })();
    return () => {
      cancelled = true;
    };
  }, [visitId, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Realtime: any change on the latest lng_sms_messages row for
  // this visit triggers a refetch. Filter is broad (any row whose
  // visit_id matches) — the SELECT above narrows to the most recent
  // visit_ready row, so an unrelated SMS template firing on the
  // same visit would also bump this hook, which is fine; refetch
  // is cheap and the result is identical.
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
