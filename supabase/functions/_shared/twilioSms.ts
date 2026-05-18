// Twilio Programmable Messaging helper.
//
// Sends an SMS by hitting the Messages REST endpoint with HTTP
// Basic auth (API Key SID as username, API Key Secret as password).
// We always pass MessagingServiceSid as the "From" — the Messaging
// Service routes the message through the best attached sender
// (alphanumeric for UK one-way reminders, long code where alphanum
// isn't supported), so no per-country `From` table to maintain on
// our side.
//
// Required env (Supabase function secrets):
//   TWILIO_ACCOUNT_SID          AC……
//   TWILIO_MESSAGING_SERVICE_SID MG……
//
//   PLUS one of the following auth pairs (API Key preferred):
//     TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET   (scoped, revokable)
//   OR
//     TWILIO_AUTH_TOKEN                            (master Auth Token,
//                                                   fall-back when no
//                                                   scoped key is set)
//
// Optional:
//   TWILIO_STATUS_CALLBACK_URL  webhook for delivery updates. When
//                                set, Twilio POSTs message status
//                                transitions to it (queued → sent →
//                                delivered / failed). We don't have
//                                a receiver yet — leave unset until
//                                we do.
//
// Return shape: { ok, sid?, code?, message? }. On non-2xx Twilio
// returns { code: number, message: string, more_info: string }
// which we surface verbatim so logFailure rows carry the actual
// cause (most often: missing API Key permissions = 70051).

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

export interface SendSmsInput {
  to: string;
  body: string;
}

export interface SendSmsOk {
  ok: true;
  sid: string;
  status: string;
}

export interface SendSmsErr {
  ok: false;
  status: number;
  code: number | null;
  message: string;
}

export type SendSmsResult = SendSmsOk | SendSmsErr;

/** Read + validate all Twilio env vars once per cold start. Throws
 *  on a missing secret so the cron sweep surfaces "Twilio not
 *  configured" in lng_system_failures instead of silently sending
 *  nothing. */
function readTwilioConfig(): {
  accountSid: string;
  authUser: string;
  authPass: string;
  messagingServiceSid: string;
  statusCallbackUrl: string | null;
} {
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
  const apiKeySid = Deno.env.get('TWILIO_API_KEY_SID') ?? '';
  const apiKeySecret = Deno.env.get('TWILIO_API_KEY_SECRET') ?? '';
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
  const messagingServiceSid = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID') ?? '';
  const statusCallbackUrl = Deno.env.get('TWILIO_STATUS_CALLBACK_URL') ?? '';
  // Prefer the scoped API Key pair when both halves are present — a
  // restricted key with the messaging grant is the right long-term
  // shape. Fall back to Account SID + Auth Token (master credential)
  // when no key is configured, so we can stand the integration up
  // before the API key has the right scopes.
  const haveApiKey = apiKeySid.length > 0 && apiKeySecret.length > 0;
  const authUser = haveApiKey ? apiKeySid : accountSid;
  const authPass = haveApiKey ? apiKeySecret : authToken;
  const missing = [
    !accountSid && 'TWILIO_ACCOUNT_SID',
    !authPass && 'TWILIO_API_KEY_SECRET or TWILIO_AUTH_TOKEN',
    !messagingServiceSid && 'TWILIO_MESSAGING_SERVICE_SID',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Twilio not configured: missing ${missing.join(', ')}`);
  }
  return {
    accountSid,
    authUser,
    authPass,
    messagingServiceSid,
    statusCallbackUrl: statusCallbackUrl || null,
  };
}

export async function sendSms({ to, body }: SendSmsInput): Promise<SendSmsResult> {
  let cfg: ReturnType<typeof readTwilioConfig>;
  try {
    cfg = readTwilioConfig();
  } catch (e) {
    return {
      ok: false,
      status: 500,
      code: null,
      message: e instanceof Error ? e.message : String(e),
    };
  }

  // Normalise the recipient before handing to Twilio. UK clinics
  // routinely store phones as `07878 023449` or `+44 7878 023449`
  // (national + spaces) which Twilio rejects with 21211. Canonical
  // here at the SMS boundary so EVERY caller (visit_ready, future
  // reminders) gets the same forgiveness without having to do it
  // themselves. UK-first because that's where the clinic is; any
  // already-E.164 input passes through untouched.
  const normalisedTo = normalisePhone(to);

  const auth = btoa(`${cfg.authUser}:${cfg.authPass}`);
  const form = new URLSearchParams({
    MessagingServiceSid: cfg.messagingServiceSid,
    To: normalisedTo,
    Body: body,
  });
  if (cfg.statusCallbackUrl) form.set('StatusCallback', cfg.statusCallbackUrl);

  const res = await fetch(
    `${TWILIO_BASE}/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    },
  );
  const json = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      code: typeof json?.code === 'number' ? (json.code as number) : null,
      message:
        typeof json?.message === 'string'
          ? (json.message as string)
          : `Twilio HTTP ${res.status}`,
    };
  }
  return {
    ok: true,
    sid: String(json?.sid ?? ''),
    status: String(json?.status ?? 'queued'),
  };
}

/** Single-arg sibling of toE164 used by the per-message SMS senders
 *  (visit_ready, future ones). Accepts whatever the patient record
 *  carries — UK national `07878...`, with spaces / hyphens, with the
 *  international `00` prefix, or already-E.164 `+447...` — and emits
 *  the canonical E.164 shape Twilio's Messages API expects. Returns
 *  the raw input untouched on any unrecognised shape so the caller's
 *  error surface still fires (better to send and let Twilio reject
 *  with 21211 than silently drop the message). */
export function normalisePhone(input: string): string {
  const raw = (input ?? '').toString();
  const e164 = toE164(null, raw);
  return e164 ?? raw;
}

/** Normalise a UK number into E.164 (+44……). The widget stores
 *  country + local separately, so most rows already arrive as
 *  "+44 7…" but legacy / Calendly-imported rows can be in any
 *  format. This is a best-effort cleaner; if it can't decide,
 *  it returns null and the caller skips the row rather than
 *  texting the wrong number.
 *
 *  Input formats handled (after stripping spaces / dashes / parens):
 *    07878023449         → +447878023449   (UK national)
 *    447878023449        → +447878023449   (country code, no +)
 *    +447878023449       → +447878023449   (already canonical)
 *    00447878023449      → +447878023449   (international dial prefix)
 *    +44(0)7878023449    → +447878023449   (UK trunk-0 after +44)
 *    +44 7878 023 449    → +447878023449   (spaces) */
export function toE164(country: string | null, local: string | null): string | null {
  let raw = (local ?? '').replace(/[^\d+]/g, '');
  if (!raw) return null;
  // International dial prefix `00` → `+`. Catches the common
  // copy-paste from a contacts list of "00447878023449". Must run
  // before the `0`-leading UK-national branch below, otherwise the
  // first 0 gets eaten and we end up with `+44047878023449`.
  if (raw.startsWith('00')) {
    raw = '+' + raw.slice(2);
  }
  // UK trunk-0 after the country code. People type
  // "+44 (0) 7878 023449" because that's how it appears on
  // letterheads / business cards; the (0) is the UK national
  // dialling prefix that has to be dropped for international. Only
  // strip when the residue is the right length for a UK mobile
  // (+44 + 0 + 10-digit local = 14 chars after the strip), so we
  // don't accidentally chew into a different country's number that
  // happens to have a 0 after the country code.
  if (raw.startsWith('+440') && raw.length === 14) {
    raw = '+44' + raw.slice(4);
  }
  // Already E.164 (or normalised above).
  if (raw.startsWith('+')) return raw;
  // Local already includes a UK country prefix without +
  if (raw.startsWith('44') && raw.length >= 11) return `+${raw}`;
  if (raw.startsWith('0') && (country ?? 'GB') === 'GB') {
    return `+44${raw.slice(1)}`;
  }
  // Generic E.164 attempt for non-UK rows: prepend + and hope the
  // local part already carries the country prefix. Twilio will
  // reject malformed numbers with a 4xx, which the caller logs.
  return raw.startsWith('+') ? raw : `+${raw}`;
}
