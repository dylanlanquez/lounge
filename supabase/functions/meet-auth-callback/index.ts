// meet-auth-callback
//
// Called by the Lounge frontend's /auth/google/callback page once
// Google has redirected the admin back with a ?code= parameter.
// Exchanges the code for tokens, reads the host's profile, and
// upserts the row into lng_meet_hosts. Returns { ok, host } so the
// callback page can route back to Admin > Services with a toast.
//
// Re-auth flow: if a host with the same google_email already exists,
// we overwrite the tokens so a re-grant cleanly replaces a stale
// refresh_token (e.g. after the host revoked the grant in their
// Google account settings).

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors() });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Same posture as meet-auth-init: expected failures return 200 with
  // { ok:false, error } so the callback page renders a clear message
  // instead of a generic "non-2xx" wrapper from supabase-js.
  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) return json(200, { ok: false, error: 'Not signed in. Sign in and try again.' });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) return json(200, { ok: false, error: 'Not signed in. Sign in and try again.' });

  const { data: account } = await userClient
    .from('accounts')
    .select('id, account_types')
    .eq('auth_user_id', who.user.id)
    .maybeSingle();
  const accountRow = account as { id: string; account_types: string[] | null } | null;
  const types = accountRow?.account_types ?? [];
  if (!types.some((t) => t === 'admin' || t === 'lng_admin' || t === 'super_admin')) {
    return json(200, { ok: false, error: 'Admin access required to finish connecting a Meet host.' });
  }

  let body: { code?: string; state?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const code = body.code;
  if (!code) return json(200, { ok: false, error: 'Google did not return an authorisation code. Retry from Admin, Services.' });

  // Decode + verify the state we issued in meet-auth-init. If the
  // admin who clicked Connect isn't the same person Google redirected
  // back, reject — protects against an external callback hijack.
  if (body.state) {
    try {
      const decoded = JSON.parse(atob(body.state)) as { adminAuthUserId?: string };
      if (decoded.adminAuthUserId && decoded.adminAuthUserId !== who.user.id) {
        return json(200, { ok: false, error: 'OAuth round-trip was started by a different signed-in user. Retry from Admin, Services.' });
      }
    } catch {
      return json(200, { ok: false, error: 'OAuth state could not be read. Retry from Admin, Services.' });
    }
  }

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '';
  const redirectUri = Deno.env.get('GOOGLE_REDIRECT_URI') ?? '';
  if (!clientId || !clientSecret || !redirectUri) {
    return json(200, {
      ok: false,
      error: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or GOOGLE_REDIRECT_URI is not set in Supabase secrets.',
    });
  }

  // 1. Exchange the code for tokens.
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    const errBody = await tokenRes.text().catch(() => '');
    return json(200, { ok: false, error: `Google token exchange failed: ${tokenRes.status} ${errBody.slice(0, 200)}` });
  }
  const tokens = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!tokens.access_token) {
    return json(200, { ok: false, error: 'Google returned no access_token' });
  }
  if (!tokens.refresh_token) {
    // prompt=consent should always issue one; if Google didn't, the
    // host can't be refreshed and the integration is unusable for
    // attendance fetches later. Tell the admin to retry from a
    // disconnected state.
    return json(200, {
      ok: false,
      error: 'Google did not return a refresh_token. Revoke the existing grant in your Google account and retry.',
    });
  }
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600;
  const tokenExpiry = new Date(Date.now() + expiresIn * 1000).toISOString();

  // 2. Get the host's profile so we can stamp display_name + email.
  const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) {
    const errBody = await profileRes.text().catch(() => '');
    return json(200, {
      ok: false,
      error: `Profile fetch failed: ${profileRes.status} ${errBody.slice(0, 200)}`,
    });
  }
  const profile = (await profileRes.json()) as { email?: string; name?: string };
  if (!profile.email) {
    return json(200, { ok: false, error: 'Profile fetch returned no email' });
  }

  // 3. Upsert the host. Service role bypasses RLS.
  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const upsertPayload = {
    google_email: profile.email,
    display_name: profile.name ?? profile.email,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expiry: tokenExpiry,
    is_active: true,
    connected_by_account_id: accountRow?.id ?? null,
  };
  const { data: saved, error: upsertErr } = await admin
    .from('lng_meet_hosts')
    .upsert(upsertPayload, { onConflict: 'google_email' })
    .select('id, display_name, google_email, is_active, created_at')
    .single();
  if (upsertErr || !saved) {
    return json(200, {
      ok: false,
      error: `Could not save host: ${upsertErr?.message ?? 'unknown error'}`,
    });
  }

  return json(200, { ok: true, host: saved });
});

function cors(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(), 'Content-Type': 'application/json' },
  });
}
