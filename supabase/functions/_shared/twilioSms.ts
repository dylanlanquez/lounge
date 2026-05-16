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

  const auth = btoa(`${cfg.authUser}:${cfg.authPass}`);
  const form = new URLSearchParams({
    MessagingServiceSid: cfg.messagingServiceSid,
    To: to,
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

/** Normalise a UK number into E.164 (+44……). The widget stores
 *  country + local separately, so most rows already arrive as
 *  "+44 7…" but legacy / Calendly-imported rows can be in any
 *  format. This is a best-effort cleaner; if it can't decide,
 *  it returns null and the caller skips the row rather than
 *  texting the wrong number. */
export function toE164(country: string | null, local: string | null): string | null {
  const raw = (local ?? '').replace(/[^\d+]/g, '');
  if (raw.startsWith('+')) return raw;
  // Local already includes a UK country prefix without +
  if (raw.startsWith('44') && raw.length >= 11) return `+${raw}`;
  if (raw.startsWith('0') && (country ?? 'GB') === 'GB') {
    return `+44${raw.slice(1)}`;
  }
  if (!raw) return null;
  // Generic E.164 attempt for non-UK rows: prepend + and hope the
  // local part already carries the country prefix. Twilio will
  // reject malformed numbers with a 4xx, which the caller logs.
  return raw.startsWith('+') ? raw : `+${raw}`;
}
