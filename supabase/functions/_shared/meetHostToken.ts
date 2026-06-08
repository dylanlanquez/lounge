// _shared/meetHostToken.ts
//
// Shared OAuth-token refresh helper for the Meet host integration.
// Every Meet REST API call goes through getValidAccessToken so an
// expired / about-to-expire access_token is transparently refreshed
// before the call instead of bouncing on a 401.
//
// Tokens that get refreshed are written back to lng_meet_hosts so
// the next call uses the rolled credential. Refresh failures bubble
// up (callers surface them) — a host whose refresh_token is revoked
// needs to reconnect via the OAuth flow.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { DEFAULT_OAUTH_CLIENT, resolveOAuthClient } from './meetOAuthClients.ts';

export interface MeetHostRow {
  id: string;
  display_name: string;
  google_email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: string | null;
  is_active: boolean;
  // Which OAuth app minted this host's tokens. Drives which
  // client_id/secret the refresh below uses. Defaults to venneir for
  // rows that predate the column.
  oauth_client: string | null;
}

export type HostTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; error: string };

const REFRESH_SKEW_MS = 60_000; // refresh 60s before expiry

export async function getValidAccessToken(
  admin: SupabaseClient,
  host: MeetHostRow,
): Promise<HostTokenResult> {
  if (!host.refresh_token) {
    return { ok: false, error: 'Host has no refresh token — reconnect via OAuth.' };
  }
  if (host.access_token && host.token_expiry) {
    const expiryMs = new Date(host.token_expiry).getTime();
    if (Number.isFinite(expiryMs) && expiryMs - Date.now() > REFRESH_SKEW_MS) {
      return { ok: true, accessToken: host.access_token };
    }
  }

  const clientKey = host.oauth_client ?? DEFAULT_OAUTH_CLIENT;
  const client = resolveOAuthClient(clientKey);
  if (!client) {
    return {
      ok: false,
      error: `OAuth client '${clientKey}' is not configured (its GOOGLE_CLIENT_ID*/SECRET* secrets are unset).`,
    };
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: host.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `Google token refresh failed: ${res.status} ${body.slice(0, 200)}` };
  }
  const payload = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
  };
  const accessToken = payload.access_token;
  if (!accessToken) {
    return { ok: false, error: 'Google token refresh returned no access_token' };
  }
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
  const tokenExpiry = new Date(Date.now() + expiresIn * 1000).toISOString();

  await admin
    .from('lng_meet_hosts')
    .update({ access_token: accessToken, token_expiry: tokenExpiry })
    .eq('id', host.id);

  return { ok: true, accessToken };
}
