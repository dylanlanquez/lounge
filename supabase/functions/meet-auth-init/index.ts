// meet-auth-init
//
// Returns the Google OAuth consent URL the admin should be redirected
// to. The browser hits this endpoint, gets the URL back, and replaces
// window.location with it; Google handles consent + redirects to
// GOOGLE_REDIRECT_URI with a ?code= parameter that meet-auth-callback
// exchanges for tokens.
//
// Scopes requested:
//   • meetings.space.created   — create + read Meet spaces this app made
//   • calendar.events          — optional, lets a future enhancement
//                                also create a Calendar event so the
//                                host's calendar reflects the booking
//   • drive.readonly           — recording/transcript readback if we
//                                later want to surface them
//
// Auth: signed-in admin only. A receptionist hitting this endpoint
// shouldn't be able to spin up new OAuth grants for the org.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import {
  DEFAULT_OAUTH_CLIENT,
  listConfiguredOAuthClients,
  resolveOAuthClient,
} from '../_shared/meetOAuthClients.ts';
import { validateInviteToken } from '../_shared/meetHostInvite.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const SCOPES = [
  'https://www.googleapis.com/auth/meetings.space.created',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    // Unhandled exception — return 200 with ok:false so the client
    // toast surfaces the real reason instead of a generic non-2xx.
    return new Response(
      JSON.stringify({
        ok: false,
        error: `meet-auth-init crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      }),
      { status: 200, headers: { ...cors(), 'Content-Type': 'application/json' } },
    );
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors() });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Every "expected failure" branch below returns 200 with { ok: false,
  // error: '<reason>' } so the supabase-js client receives the real
  // message in payload.error instead of a generic "non-2xx" wrapper.
  // Only unhandled exceptions land as non-2xx via the try/catch.
  let body: { return_to?: string; client?: string; list?: boolean; token?: string };
  try {
    body = (await req.json()) as { return_to?: string; client?: string; list?: boolean; token?: string };
  } catch {
    body = {};
  }

  const redirectUri = Deno.env.get('GOOGLE_REDIRECT_URI') ?? '';

  // ---- Remote self-connect path -------------------------------------
  // Authorised by a one-time invite token instead of a Lounge admin
  // session, so a host with no Lounge login can connect themselves. The
  // token determines the workspace; we never trust a client field here.
  if (body.token && body.token.trim()) {
    const adminDb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const check = await validateInviteToken(adminDb, body.token.trim());
    if (!check.ok) return json(200, { ok: false, error: check.error });
    const client = resolveOAuthClient(check.invite.oauthClient);
    if (!client) {
      return json(200, { ok: false, error: `The '${check.invite.oauthClient}' workspace OAuth app is not configured.` });
    }
    if (!redirectUri) {
      return json(200, { ok: false, error: 'GOOGLE_REDIRECT_URI is not set in Supabase secrets.' });
    }
    const state = encodeState({ token: body.token.trim(), client: check.invite.oauthClient });
    return json(200, { ok: true, url: buildConsentUrl(client.clientId, redirectUri, state) });
  }

  // ---- Admin-gated path (in-app Connect button + list mode) ----------
  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) return json(200, { ok: false, error: 'Not signed in. Sign in and try again.' });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) return json(200, { ok: false, error: 'Not signed in. Sign in and try again.' });

  const { data: account } = await userClient
    .from('accounts')
    .select('account_types')
    .eq('auth_user_id', who.user.id)
    .maybeSingle();
  const types = ((account as { account_types: string[] | null } | null)?.account_types) ?? [];
  if (!types.some((t) => t === 'admin' || t === 'lng_admin' || t === 'super_admin')) {
    return json(200, { ok: false, error: 'Admin access required to connect a Meet host.' });
  }

  // List mode: the admin UI asks which workspaces are configured so it
  // can offer a chooser.
  if (body.list) {
    return json(200, { ok: true, clients: listConfiguredOAuthClients() });
  }

  // Which OAuth app (workspace) to connect through. Defaults to the
  // original venneir app so the existing button keeps working.
  const clientKey = body.client && body.client.trim() ? body.client.trim() : DEFAULT_OAUTH_CLIENT;
  const client = resolveOAuthClient(clientKey);
  if (!client) {
    return json(200, {
      ok: false,
      error: `The '${clientKey}' workspace OAuth app is not configured. Add its GOOGLE_CLIENT_ID_* and GOOGLE_CLIENT_SECRET_* secrets in Supabase and try again.`,
    });
  }
  if (!redirectUri) {
    return json(200, {
      ok: false,
      error: 'GOOGLE_REDIRECT_URI is not set in Supabase secrets. Add it in Dashboard, Edge Functions, Secrets and try again.',
    });
  }

  // Pass the admin's account id + the chosen client through OAuth state
  // so the callback can attribute the connection and exchange the code
  // with the SAME app's secret. Google round-trips state verbatim and
  // we verify it server-side before persisting tokens.
  const state = encodeState({
    adminAuthUserId: who.user.id,
    returnTo: body.return_to ?? null,
    client: clientKey,
  });
  return json(200, { ok: true, url: buildConsentUrl(client.clientId, redirectUri, state) });
}

// Build the Google consent URL. prompt=consent forces Google to
// re-issue a refresh_token even if the host has authorised before;
// without it a repeat grant returns only an access_token and we lose
// the ability to refresh.
function buildConsentUrl(clientId: string, redirectUri: string, state: string): string {
  return (
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    }).toString()
  );
}

function encodeState(payload: Record<string, unknown>): string {
  return btoa(JSON.stringify(payload));
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
