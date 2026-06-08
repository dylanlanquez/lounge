// meet-host-invite
//
// One-time connect links for remote Meet hosts. Two actions:
//
//   • create   (admin only)  -> { ok, url, token, expiresAt, label }
//       An admin picks a workspace + optional label; we mint a token,
//       store it, and return a link to send to the host.
//
//   • validate (public)      -> { ok, label, workspaceKey, workspaceLabel }
//       The /connect-meet-host page calls this to show who the link is
//       for and which workspace, and to reject expired / used links
//       before the host bothers with Google.
//
// The token is CONSUMED later, in meet-auth-callback, not here.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import {
  DEFAULT_OAUTH_CLIENT,
  isKnownOAuthClient,
  resolveOAuthClient,
} from '../_shared/meetOAuthClients.ts';
import { validateInviteToken } from '../_shared/meetHostInvite.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors() });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body: { action?: string; token?: string; client?: string; label?: string };
  try {
    body = (await req.json()) as { action?: string; token?: string; client?: string; label?: string };
  } catch {
    body = {};
  }

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ---- validate (public, no Lounge auth) ----
  if (body.action === 'validate') {
    const check = await validateInviteToken(admin, body.token ?? '');
    if (!check.ok) return json(200, { ok: false, error: check.error });
    const client = resolveOAuthClient(check.invite.oauthClient);
    return json(200, {
      ok: true,
      label: check.invite.label,
      workspaceKey: check.invite.oauthClient,
      workspaceLabel: client?.label ?? check.invite.oauthClient,
    });
  }

  // ---- create (admin only) ----
  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) return json(200, { ok: false, error: 'Not signed in.' });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) return json(200, { ok: false, error: 'Not signed in.' });
  const { data: account } = await userClient
    .from('accounts')
    .select('id, account_types')
    .eq('auth_user_id', who.user.id)
    .maybeSingle();
  const accountRow = account as { id: string; account_types: string[] | null } | null;
  const types = accountRow?.account_types ?? [];
  if (!types.some((t) => t === 'admin' || t === 'lng_admin' || t === 'super_admin')) {
    return json(200, { ok: false, error: 'Admin access required to create a connect link.' });
  }

  const clientKey = body.client && body.client.trim() ? body.client.trim() : DEFAULT_OAUTH_CLIENT;
  if (!isKnownOAuthClient(clientKey)) {
    return json(200, { ok: false, error: `Unknown workspace '${clientKey}'.` });
  }
  if (!resolveOAuthClient(clientKey)) {
    return json(200, {
      ok: false,
      error: `The '${clientKey}' workspace OAuth app is not configured. Add its secrets and try again.`,
    });
  }

  const token = randomToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const label = (body.label ?? '').trim() || null;

  const { error: insErr } = await admin.from('lng_meet_host_invites').insert({
    token,
    oauth_client: clientKey,
    label,
    created_by_account_id: accountRow?.id ?? null,
    expires_at: expiresAt,
  });
  if (insErr) return json(200, { ok: false, error: `Could not create the link: ${insErr.message}` });

  const redirectUri = Deno.env.get('GOOGLE_REDIRECT_URI') ?? '';
  let origin = '';
  try {
    origin = new URL(redirectUri).origin;
  } catch {
    origin = '';
  }
  if (!origin) {
    return json(200, { ok: false, error: 'GOOGLE_REDIRECT_URI is not configured, cannot build the link.' });
  }
  const url = `${origin}/connect-meet-host?token=${encodeURIComponent(token)}`;

  return json(200, { ok: true, url, token, expiresAt, label });
});

// 32 random bytes, base64url. Opaque + unguessable; only ever compared
// for equality against the stored value.
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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
