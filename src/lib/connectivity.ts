// Decides whether a Supabase / fetch error is a transient connectivity
// failure (Cloudflare 5xx between the device and the Supabase origin,
// the device offline, DNS failure, request aborted) versus a real
// application-level error (auth_invalid, RLS denial, missing column,
// permission failure).
//
// We need this distinction because RequireStaff routes account=null
// to /no-access — that surface tells staff "your account isn't on
// the Lounge staff list," which is *misleading and harmful* when the
// real reason is that auth_account_id couldn't be reached. The fix
// is to detect connectivity errors at the fetch layer and render a
// dedicated "Can't reach Lounge servers" surface with a retry, instead
// of poisoning the routing gate.
//
// Patterns checked, in order:
//
//   1. PostgrestError code 'PGRST301' / network-style status (520-599)
//      surfaced inside `error.status` when supabase-js manages to
//      parse a JSON envelope from the 5xx response.
//   2. The error name is TypeError and message is "Failed to fetch" —
//      that's what fetch throws when the network is unreachable, when
//      a CORS check fails, when DNS fails, or when the connection
//      times out. All of those are "can't reach" rather than "denied".
//   3. The error name is AbortError (request aborted by the client).
//   4. Supabase's wrapped `AuthRetryableFetchError` and similar —
//      whose .name string explicitly contains "Retryable".
//   5. The error message contains a known Cloudflare error code
//      string ("522", "521", "502 Bad Gateway", etc.) — sometimes
//      surfaced by supabase-js when the upstream returns an HTML
//      error page that the library can parse a status from.
//
// Anything else is treated as a real application error and bubbles
// up through the existing error paths unchanged.

export interface PossibleSupabaseError {
  name?: string;
  message?: string;
  code?: string;
  status?: number | string;
}

export function isConnectivityError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as PossibleSupabaseError;

  const name = String(e.name ?? '');
  const message = String(e.message ?? '');
  const status = typeof e.status === 'number' ? e.status : Number(e.status ?? 0);

  if (name === 'AbortError') return true;
  if (name === 'TypeError' && /failed to fetch|network ?error|load failed/i.test(message)) return true;
  if (/retryable/i.test(name)) return true;
  if (status >= 500 && status <= 599) return true;
  // Common Cloudflare edge codes that arrive as ERR_FAILED + status
  // surface inside the message or status string on supabase-js v2.
  if (/\b(50[02389]|52[0-9])\b/.test(message)) return true;
  if (/bad gateway|gateway timeout|service unavailable|connection timed out/i.test(message)) return true;
  return false;
}

// Best-effort short label for the surface — "Bad Gateway", "Offline",
// etc. Falls back to a generic phrase. The full error is also logged
// to the console.
export function connectivityErrorLabel(err: unknown): string {
  if (!err || typeof err !== 'object') return 'Can’t reach Lounge';
  const e = err as PossibleSupabaseError;
  const status = typeof e.status === 'number' ? e.status : Number(e.status ?? 0);
  if (status === 502) return 'Bad gateway (502)';
  if (status === 503) return 'Service unavailable (503)';
  if (status === 504) return 'Gateway timeout (504)';
  if (status === 521) return 'Origin down (521)';
  if (status === 522) return 'Origin unreachable (522)';
  if (status === 523) return 'Origin offline (523)';
  if (status === 524) return 'Origin timeout (524)';
  if (status >= 500 && status <= 599) return `Server error (${status})`;
  if (String(e.name) === 'AbortError') return 'Request cancelled';
  return 'Connection problem';
}
