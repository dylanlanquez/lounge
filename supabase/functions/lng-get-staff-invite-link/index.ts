// lng-get-staff-invite-link
//
// Admin-only read of the *currently active* invite link for a staff
// member. Used by the Manage Staff sheet so an admin can copy the
// existing /welcome?invite=<token> URL and hand-deliver it (Slack,
// WhatsApp, SMS) if the staff_invite email never arrived. Calling
// this does NOT mint a new token — that would void the still-valid
// email already sitting in the staff member's inbox. For a fresh
// link with a new 7-day window, the admin clicks Resend invite which
// explicitly mints a new token.
//
// Why an edge function: lng_staff_members.invite_token is sensitive.
// The public RLS read policy on lng_staff_members is `true`
// (everyone authenticated can read every staff row for display
// purposes), so we cannot expose invite_token via PostgREST without
// letting any signed-in non-admin staff read another colleague's
// token and impersonate them via /welcome?invite=<token>. This
// service-role function gates the read behind the admin check.
//
// Body: { staff_member_id: string }
// Returns: {
//   ok: true,
//   invite_url: string | null,
//   has_token: boolean,
//   expired: boolean,
//   accepted: boolean,
//   invite_sent_at: string | null,
//   invite_expires_at: string | null,
// }
// Auth: Bearer JWT, caller must be an active Lounge admin.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const LOUNGE_PUBLIC_URL = (
  Deno.env.get('LOUNGE_PUBLIC_URL') ?? 'https://lounge.venneir.com'
).replace(/\/+$/, '');
const SUPER_ADMIN_EMAIL = 'dylan@lanquez.com';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return jsonResponse(405, { ok: false, error: 'Method not allowed' });

  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) {
    return jsonResponse(401, { ok: false, error: 'No bearer token' });
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who, error: whoErr } = await userClient.auth.getUser();
  if (whoErr || !who?.user) return jsonResponse(401, { ok: false, error: 'Not signed in' });
  const callerAuthId = who.user.id;

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: callerRow } = await admin
    .from('accounts')
    .select('id, login_email')
    .eq('auth_user_id', callerAuthId)
    .maybeSingle();
  if (!callerRow) return jsonResponse(403, { ok: false, error: 'No account row for caller' });
  const caller = callerRow as { id: string; login_email: string | null };
  const callerIsSuper = (caller.login_email ?? '').toLowerCase() === SUPER_ADMIN_EMAIL;
  const { data: callerStaff } = await admin
    .from('lng_staff_members')
    .select('is_admin, status')
    .eq('account_id', caller.id)
    .maybeSingle();
  const callerIsAdmin =
    (callerStaff?.is_admin === true && callerStaff?.status === 'active') || callerIsSuper;
  if (!callerIsAdmin) return jsonResponse(403, { ok: false, error: 'Lounge admin only' });

  let body: { staff_member_id?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const staffId = body.staff_member_id?.trim();
  if (!staffId) return jsonResponse(400, { ok: false, error: 'staff_member_id required' });

  const { data: row, error } = await admin
    .from('lng_staff_members')
    .select('invite_token, invite_sent_at, invite_expires_at, invite_accepted_at')
    .eq('id', staffId)
    .maybeSingle();
  if (error) return jsonResponse(500, { ok: false, error: error.message });
  if (!row) return jsonResponse(404, { ok: false, error: 'Staff member not found' });
  const target = row as {
    invite_token: string | null;
    invite_sent_at: string | null;
    invite_expires_at: string | null;
    invite_accepted_at: string | null;
  };

  const hasToken = !!target.invite_token;
  const accepted = !!target.invite_accepted_at;
  const expiresMs = target.invite_expires_at ? new Date(target.invite_expires_at).getTime() : null;
  const expired = !!(expiresMs && Number.isFinite(expiresMs) && expiresMs < Date.now());
  const inviteUrl =
    hasToken && !accepted ? `${LOUNGE_PUBLIC_URL}/welcome?invite=${target.invite_token}` : null;

  return jsonResponse(200, {
    ok: true,
    invite_url: inviteUrl,
    has_token: hasToken,
    expired,
    accepted,
    invite_sent_at: target.invite_sent_at,
    invite_expires_at: target.invite_expires_at,
  });
});
