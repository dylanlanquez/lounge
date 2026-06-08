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
import { DEFAULT_OAUTH_CLIENT, resolveOAuthClient } from '../_shared/meetOAuthClients.ts';
import { consumeInvite, validateInviteToken } from '../_shared/meetHostInvite.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors() });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Same posture as meet-auth-init: expected failures return 200 with
  // { ok:false, error } so the callback page renders a clear message
  // instead of a generic "non-2xx" wrapper from supabase-js.
  let body: { code?: string; state?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const code = body.code;
  if (!code) return json(200, { ok: false, error: 'Google did not return an authorisation code. Retry.' });

  // Decode the state we issued in meet-auth-init. It carries EITHER an
  // admin-initiated grant (adminAuthUserId) or a remote self-connect via
  // a one-time invite token. The two paths authorise differently. The
  // state also names which OAuth app (workspace) started the flow, so we
  // exchange the code with the SAME app's secret.
  let decoded: { adminAuthUserId?: string; client?: string; token?: string } = {};
  if (body.state) {
    try {
      decoded = JSON.parse(atob(body.state)) as { adminAuthUserId?: string; client?: string; token?: string };
    } catch {
      return json(200, { ok: false, error: 'OAuth state could not be read. Retry.' });
    }
  }

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let clientKey = DEFAULT_OAUTH_CLIENT;
  let connectedByAccountId: string | null = null;
  let inviteId: string | null = null;

  if (decoded.token && decoded.token.trim()) {
    // ---- Remote self-connect: the one-time invite token IS the
    // authorisation. No Lounge session required. ----
    const check = await validateInviteToken(admin, decoded.token.trim());
    if (!check.ok) return json(200, { ok: false, error: check.error });
    inviteId = check.invite.id;
    clientKey = check.invite.oauthClient;
  } else {
    // ---- Admin-initiated: require a signed-in admin whose id matches
    // the one that started the flow. ----
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
    if (decoded.adminAuthUserId && decoded.adminAuthUserId !== who.user.id) {
      return json(200, { ok: false, error: 'OAuth round-trip was started by a different signed-in user. Retry from Admin, Services.' });
    }
    connectedByAccountId = accountRow?.id ?? null;
    if (decoded.client && decoded.client.trim()) clientKey = decoded.client.trim();
  }

  const client = resolveOAuthClient(clientKey);
  const redirectUri = Deno.env.get('GOOGLE_REDIRECT_URI') ?? '';
  if (!client || !redirectUri) {
    return json(200, {
      ok: false,
      error: `OAuth app '${clientKey}' or GOOGLE_REDIRECT_URI is not configured in Supabase secrets.`,
    });
  }

  // 1. Exchange the code for tokens.
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
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

  // 2. Get the host's profile so we can stamp display_name, email, and
  //    Google's stable user resource id. The id is what the Meet REST
  //    API returns as signedinUser.user on conferenceRecord
  //    participants — the un-forgeable signal that "this participant
  //    is genuinely THIS Google account", regardless of what display
  //    name they put in Meet's "your name" prompt. Stored alongside
  //    the email so meet-fetch-attendance can tag is_host without
  //    trusting display_name strings.
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
  const profile = (await profileRes.json()) as { id?: string; email?: string; name?: string };
  if (!profile.email) {
    return json(200, { ok: false, error: 'Profile fetch returned no email' });
  }
  if (!profile.id) {
    return json(200, { ok: false, error: 'Profile fetch returned no user id' });
  }

  // 3. Upsert the host. Service role bypasses RLS.
  const upsertPayload = {
    google_email: profile.email,
    google_user_id: profile.id,
    display_name: profile.name ?? profile.email,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expiry: tokenExpiry,
    is_active: true,
    connected_by_account_id: connectedByAccountId,
    // Remember which app issued these tokens so refresh uses the same
    // client_id/secret. An oauth host is always kind = 'oauth'; set it
    // explicitly so a re-grant of a row that was somehow a staff stub
    // converts cleanly.
    kind: 'oauth',
    oauth_client: clientKey,
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

  // Remote self-connect: burn the one-time invite now that the host
  // exists. Best-effort; the host is already saved, so a failed consume
  // only risks the link being reusable until it expires.
  if (inviteId) {
    await consumeInvite(admin, inviteId, (saved as { id: string }).id, new Date().toISOString());
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
