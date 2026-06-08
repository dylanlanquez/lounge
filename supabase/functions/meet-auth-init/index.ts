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

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
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

  let body: { return_to?: string; client?: string; list?: boolean };
  try {
    body = (await req.json()) as { return_to?: string; client?: string; list?: boolean };
  } catch {
    body = {};
  }

  // List mode: the admin UI asks which workspaces are configured so it
  // can offer a chooser. Admin-gated like the connect path.
  if (body.list) {
    return json(200, { ok: true, clients: listConfiguredOAuthClients() });
  }

  // Which OAuth app (workspace) to connect through. Defaults to the
  // original venneir app so the existing button keeps working.
  const clientKey = body.client && body.client.trim() ? body.client.trim() : DEFAULT_OAUTH_CLIENT;
  const client = resolveOAuthClient(clientKey);
  const redirectUri = Deno.env.get('GOOGLE_REDIRECT_URI') ?? '';
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

  const url =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      // prompt=consent forces Google to re-issue a refresh_token even
      // if the host has previously authorised — without this, a
      // second auth attempt by the same Google account returns only
      // an access_token and we lose the ability to refresh.
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    }).toString();

  return json(200, { ok: true, url });
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
