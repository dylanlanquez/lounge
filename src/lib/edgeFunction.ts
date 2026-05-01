import { supabase } from './supabase.ts';

// Edge-function caller with automatic auth-refresh retry.
//
// Why this exists:
//   • Most Lounge edge functions verify the user's JWT server-side
//     (e.g. checkpoint-jb-check, geocode-address, terminal-*).
//   • The frontend gets the JWT from `supabase.auth.getSession()`,
//     which returns the *locally stored* session.
//   • Background tabs and OS sleep can throttle the JS client's
//     auto-refresh timer. The local token can quietly drift past
//     its `expires_at` while the refresh token is still valid.
//   • Result: the function gets a stale JWT, returns 401, and the
//     UI surfaces an "auth_invalid" error even though the user is
//     legitimately signed in.
//
// callEdgeFunction is a thin wrapper that:
//   1. Reads the current session token.
//   2. Calls the function.
//   3. On a 401, calls `supabase.auth.refreshSession()` to mint a
//      fresh JWT and retries exactly once.
//   4. If the second attempt still 401s, surfaces the failure to
//      the caller — at that point the session is genuinely expired
//      and the user needs to sign back in.
//
// The retry is server-aware: 401 is the only code that triggers it.
// Any other 4xx / 5xx surfaces immediately so legitimate function-
// level errors aren't masked behind a refresh attempt.

export interface EdgeFunctionResult<T> {
  ok: boolean;
  status: number;
  body: T;
}

export async function callEdgeFunction<T = Record<string, unknown>>(
  name: string,
  body: unknown,
): Promise<EdgeFunctionResult<T>> {
  const projectRef = supabaseProjectRef();
  const url = `https://${projectRef}.functions.supabase.co/${name}`;

  const attempt = async (): Promise<Response> => {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) throw new Error('Not signed in');
    return fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  };

  let response = await attempt();
  if (response.status === 401) {
    // Stale-token recovery: ask the client to mint a fresh JWT and
    // retry once. If refreshSession itself fails (e.g. refresh
    // token also expired) the next attempt will throw "Not signed
    // in" from the no-token check above and the caller can
    // surface a sign-in prompt.
    await supabase.auth.refreshSession();
    response = await attempt();
  }

  let parsed: T;
  try {
    parsed = (await response.json()) as T;
  } catch {
    parsed = {} as T;
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

function supabaseProjectRef(): string {
  const url = new URL(import.meta.env.VITE_SUPABASE_URL);
  return url.hostname.split('.')[0]!;
}
