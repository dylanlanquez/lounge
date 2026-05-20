// lng-accept-invite
//
// Exchanges a custom Lounge invite_token (a UUID we minted at
// lng-create-staff-account time and put in the email link) for a
// fresh Supabase magic-link URL. The client redirects the browser
// to the returned URL; Supabase verifies, signs the user in, and
// lands them back on /welcome with a session hash.
//
// Why this exists:
//
//   Before: lng-create-staff-account called
//   auth.admin.generateLink({type:'invite'}) at creation time and
//   pasted the resulting Supabase action_link into the staff_invite
//   email. The action_link is one-shot — the moment any HTTP GET
//   hits /auth/v1/verify with that token, Supabase marks it used.
//   Outlook ATP / Gmail Safe Links / generic corporate mail
//   scanners issue a GET on every URL to sandbox the page for
//   malware. By the time the real human clicks, the token is gone
//   and they land on "expired".
//
//   After: the email contains a Lounge-hosted URL with a UUID
//   query param (/welcome?invite=<uuid>). Pre-fetchers hitting
//   that URL see an HTML page that does nothing — the actual
//   Supabase session is only minted when this edge function runs.
//   The function is POST-only, so a scanner's GET cannot trigger
//   it. The custom token lives 7 days (set on
//   lng_staff_members.invite_expires_at), the Supabase magic-link
//   the user gets at click-time keeps its standard 1h window.
//
// The token is single-use server-side: the first successful
// acceptance writes invite_accepted_at and clears invite_token.
// Subsequent attempts with the same UUID return "already used".
//
// Body: { invite_token: string }
// Returns: { ok: true, action_link: string }
//        | { ok: false, reason: 'not_found' | 'expired' | 'already_accepted', message: string }
//
// Auth: none. Anyone with a valid invite_token can call this; the
// UUID itself is the credential. The flow ends with a Supabase
// magic-link that further verifies the recipient owns the inbox
// the invite was sent to.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const REDIRECT_TO =
  Deno.env.get('LNG_INVITE_REDIRECT_URL') ?? 'https://lounge.venneir.com/welcome';

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') {
    return jsonResponse(405, { ok: false, reason: 'method_not_allowed' });
  }

  let body: { invite_token?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, reason: 'bad_request', message: 'Invalid JSON' });
  }

  const token = (body.invite_token ?? '').trim();
  if (!UUID_RE.test(token)) {
    return jsonResponse(400, {
      ok: false,
      reason: 'bad_request',
      message: 'Invite token is missing or malformed.',
    });
  }

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Resolve the staff row by token. Includes the joined accounts
  // row so we have login_email + the auth_user_id we need to mint
  // a magic-link against.
  const { data: row, error: lookupErr } = await admin
    .from('lng_staff_members')
    .select(
      'id, invite_token, invite_expires_at, invite_accepted_at, status, account_id, account:accounts!account_id ( id, login_email, auth_user_id )',
    )
    .eq('invite_token', token)
    .maybeSingle();
  if (lookupErr) {
    return jsonResponse(500, {
      ok: false,
      reason: 'server_error',
      message: lookupErr.message,
    });
  }
  if (!row) {
    return jsonResponse(404, {
      ok: false,
      reason: 'not_found',
      message:
        "We could not find this invite. It may have already been used, or the admin may have re-sent a fresh one — open the most recent invite email and click that link.",
    });
  }
  const r = row as {
    id: string;
    invite_token: string | null;
    invite_expires_at: string | null;
    invite_accepted_at: string | null;
    status: string;
    account_id: string;
    account:
      | { id: string; login_email: string | null; auth_user_id: string | null }
      | Array<{ id: string; login_email: string | null; auth_user_id: string | null }>
      | null;
  };
  const account = Array.isArray(r.account) ? r.account[0] ?? null : r.account;

  if (r.status === 'inactive') {
    return jsonResponse(403, {
      ok: false,
      reason: 'inactive',
      message:
        'This staff account has been deactivated. Speak to your administrator to be reactivated before signing in.',
    });
  }

  if (r.invite_accepted_at) {
    return jsonResponse(410, {
      ok: false,
      reason: 'already_accepted',
      message:
        'This invite has already been accepted. Use the regular sign-in page with the password you set during setup.',
    });
  }

  if (r.invite_expires_at) {
    const expires = new Date(r.invite_expires_at).getTime();
    if (Number.isFinite(expires) && expires < Date.now()) {
      return jsonResponse(410, {
        ok: false,
        reason: 'expired',
        message:
          'This invite has expired. Ask your administrator to resend a fresh invite from the Staff tab.',
      });
    }
  }

  if (!account?.login_email) {
    return jsonResponse(500, {
      ok: false,
      reason: 'server_error',
      message: 'Account row is missing an email address.',
    });
  }

  // Mint a fresh Supabase magic-link at this very moment. The
  // resulting action_link is single-shot in the standard Supabase
  // way, but its TTL only starts now — no risk of a pre-fetch
  // ever consuming it, because nothing put it on the public
  // internet ahead of the click.
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: account.login_email,
    options: { redirectTo: REDIRECT_TO },
  });
  if (linkErr || !linkData?.properties?.action_link) {
    return jsonResponse(500, {
      ok: false,
      reason: 'server_error',
      message: `Could not mint sign-in link: ${linkErr?.message ?? 'no link returned'}`,
    });
  }

  // Mark the invite consumed BEFORE we hand the URL to the
  // client. If the upsert fails we don't hand out the link, so a
  // double-click can't double-mint.
  const { error: markErr } = await admin
    .from('lng_staff_members')
    .update({
      invite_accepted_at: new Date().toISOString(),
      invite_token: null,
    })
    .eq('id', r.id);
  if (markErr) {
    return jsonResponse(500, {
      ok: false,
      reason: 'server_error',
      message: `Could not mark invite accepted: ${markErr.message}`,
    });
  }

  return jsonResponse(200, {
    ok: true,
    action_link: linkData.properties.action_link,
  });
});
