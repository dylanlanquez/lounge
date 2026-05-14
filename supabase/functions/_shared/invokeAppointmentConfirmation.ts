// invokeAppointmentConfirmation
//
// Shared helper used by the three widget edge functions
// (widget-create-appointment, widget-reschedule-booking,
// widget-cancel-booking) to invoke `send-appointment-confirmation`
// reliably from inside Supabase's Edge Runtime.
//
// Why this exists, in one paragraph:
//
//   The previous pattern was
//
//     supabase.functions.invoke('send-appointment-confirmation', { body })
//
//   with a service-role supabase-js client, and the receiver checked
//   `userJwt === Bearer ${SUPABASE_SERVICE_ROLE_KEY}` to recognise
//   the internal call. That worked until the project moved to the
//   sb_publishable_* / sb_secret_* key model: the legacy JWT
//   service_role key is still listed in the dashboard, but the
//   platform-injected `SUPABASE_SERVICE_ROLE_KEY` env var on the
//   function side and the Bearer header supabase-js was sending no
//   longer matched, so `isInternal` flipped to false, `getUser()`
//   returned no user, and every booking failed silently with
//   "Edge Function returned a non-2xx status code" / "Not signed in".
//
//   Rather than chase whichever key format the platform is
//   currently translating Authorization through, this helper makes
//   the contract explicit: it sends the service-role key both as
//   the standard Bearer (so the platform's `verify_jwt = true`
//   check still passes) AND as a custom `X-Lng-Internal-Token`
//   header that the receiver compares against its own env var.
//   Custom non-Supabase headers aren't subject to platform-level
//   transformation, so as long as both functions are in the same
//   project (same env), the comparison is stable.
//
// Returns a structured result so the caller can log the actual
// response body and status when something fails — the previous
// `supabase.functions.invoke` failure log only carried the
// generic "non-2xx" message, which made post-mortem diagnosis
// impossible.

export interface ConfirmationInvocation {
  appointmentId: string;
  oldAppointmentIdToCancel?: string | null;
  intent?: 'confirmation' | 'cancellation';
}

export interface ConfirmationResult {
  /** True when the function returned 2xx with `{ok: true}` in body. */
  ok: boolean;
  /** HTTP status the function (or platform) returned. */
  status: number;
  /** Parsed JSON body when content-type was application/json, else
   *  the raw text. */
  body: unknown;
  /** Short description suitable for failure-log message strings. */
  error?: string;
}

const INTERNAL_TOKEN_HEADER = 'x-lng-internal-token';

export async function invokeAppointmentConfirmation(
  args: ConfirmationInvocation,
): Promise<ConfirmationResult> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: 'SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY env unset',
    };
  }

  const url = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/send-appointment-confirmation`;
  const payload: Record<string, unknown> = {
    appointmentId: args.appointmentId,
  };
  if (args.oldAppointmentIdToCancel) {
    payload.oldAppointmentIdToCancel = args.oldAppointmentIdToCancel;
  }
  if (args.intent) {
    payload.intent = args.intent;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        // Use the anon JWT for Authorization. This satisfies the
        // platform's `verify_jwt = true` (legacy anon is a valid
        // signed JWT). The earlier revision sent the service-role
        // key here, but on projects that have moved to the new
        // sb_publishable_*/sb_secret_* key model the platform-
        // injected SUPABASE_SERVICE_ROLE_KEY is an opaque token,
        // NOT a JWT — so the gateway rejected it with
        // `UNAUTHORIZED_INVALID_JWT_FORMAT` before the receiver
        // function ever ran.
        Authorization: `Bearer ${anonKey}`,
        apikey: anonKey,
        // The actual internal-auth channel — the receiver compares
        // this against its own SUPABASE_SERVICE_ROLE_KEY env var,
        // which both functions get from the same Supabase project
        // and therefore always match. Custom headers aren't
        // subject to the platform's JWT-format check, so the
        // service-role-secret value flows through untouched.
        [INTERNAL_TOKEN_HEADER]: serviceRoleKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: `fetch threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const contentType = res.headers.get('content-type') ?? '';
  let body: unknown;
  if (contentType.includes('application/json')) {
    try {
      body = await res.json();
    } catch (e) {
      body = { parse_error: e instanceof Error ? e.message : String(e) };
    }
  } else {
    body = await res.text().catch(() => '');
  }

  // The function returns 200 with `{ok: false}` for non-fatal
  // delivery failures (paused template, no patient email, etc).
  // Treat those as not-ok so the caller can log the reason.
  const bodyOk =
    body && typeof body === 'object' && 'ok' in body
      ? Boolean((body as { ok: unknown }).ok)
      : res.ok;

  return {
    ok: res.ok && bodyOk,
    status: res.status,
    body,
    error: !res.ok
      ? `HTTP ${res.status}`
      : !bodyOk && body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : undefined,
  };
}

/** Header name receivers should check against their own
 *  SUPABASE_SERVICE_ROLE_KEY env var. Exported so the receiver
 *  imports the same constant rather than hardcoding the string. */
export const LNG_INTERNAL_TOKEN_HEADER = INTERNAL_TOKEN_HEADER;
