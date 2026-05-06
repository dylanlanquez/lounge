// lng-create-staff-account
//
// Provisions a brand-new Lounge staff account in one go:
//   1. Creates an auth.users entry via auth.admin.inviteUserByEmail
//      (which sends the styled "You have been invited" email)
//   2. Inserts a public.accounts row with account_type='internal',
//      internal_sub_type='customer_service', linked to the new auth user
//   3. Inserts a public.lng_staff_members row with the supplied flags
//
// Why this exists: Lounge shares the public.accounts table with
// Meridian, but a person who only works the clinic should NOT inherit
// a Meridian account. They sign in to Lounge with a distinct email
// (e.g. dylanlane@venneir.com vs dylan@venneir.com for Meridian) and
// the two are entirely separate auth.users + accounts rows that just
// happen to live in the same table. Anon-key clients cannot insert
// auth users, so this needs the service role.
//
// Auth: Bearer JWT (anon key). Caller must be an active Lounge admin
// (lng_staff_members.is_admin = true). Granting is_admin to the *new*
// account is additionally gated to the super-admin (single email,
// SUPER_ADMIN_EMAIL on the client). Regular admins can create
// non-admin staff; only super-admin can create another admin.
//
// Body: {
//   email: string,
//   first_name: string,
//   last_name: string,
//   is_admin?: boolean,
//   is_manager?: boolean,
// }

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const REDIRECT_TO = Deno.env.get('LNG_INVITE_REDIRECT_URL') ?? 'https://lounge.venneir.com';
const SUPER_ADMIN_EMAIL = 'dylan@lanquez.com';

function corsHeaders() {
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
  if (whoErr || !who?.user) {
    return jsonResponse(401, { ok: false, error: 'Not signed in' });
  }
  const callerAuthId = who.user.id;

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Caller must be an active Lounge admin. Granting the new staff
  // is_admin=true additionally requires the caller to be the super
  // admin (matched by login_email). Identity is read via the
  // service-role client so RLS can't accidentally hide the row.
  const { data: caller, error: callerErr } = await admin
    .from('accounts')
    .select('id, login_email')
    .eq('auth_user_id', callerAuthId)
    .maybeSingle();
  if (callerErr) return jsonResponse(500, { ok: false, error: callerErr.message });
  if (!caller) return jsonResponse(403, { ok: false, error: 'No account row for caller' });
  const callerAccountId = (caller as { id: string }).id;
  const callerEmail = (caller as { login_email: string | null }).login_email ?? '';
  const callerIsSuper = callerEmail.toLowerCase() === SUPER_ADMIN_EMAIL;

  const { data: callerStaff } = await admin
    .from('lng_staff_members')
    .select('is_admin, status')
    .eq('account_id', callerAccountId)
    .maybeSingle();
  const callerIsLoungeAdmin =
    (callerStaff?.is_admin === true && callerStaff?.status === 'active') || callerIsSuper;
  if (!callerIsLoungeAdmin) {
    return jsonResponse(403, { ok: false, error: 'Lounge admin only' });
  }

  let body: {
    email?: string;
    first_name?: string;
    last_name?: string;
    is_admin?: boolean;
    is_manager?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: 'Invalid JSON' });
  }

  const email = body.email?.trim().toLowerCase() ?? '';
  const firstName = body.first_name?.trim() ?? '';
  const lastName = body.last_name?.trim() ?? '';
  if (!email || !email.includes('@')) {
    return jsonResponse(400, { ok: false, error: 'Valid email required' });
  }
  if (!firstName || !lastName) {
    return jsonResponse(400, { ok: false, error: 'First and last name required' });
  }
  const isAdminFlag = body.is_admin === true;
  const isManagerFlag = body.is_manager === true;
  if (isAdminFlag && !callerIsSuper) {
    return jsonResponse(403, { ok: false, error: 'Only the super-admin can create admin accounts' });
  }

  // Hard reject duplicates so we don't pollute Meridian's accounts
  // with half-created rows. The UI already guards this by trying the
  // existing-account path first, but a direct caller of this function
  // still needs the check.
  const { data: dupe } = await admin
    .from('accounts')
    .select('id')
    .ilike('login_email', email)
    .maybeSingle();
  if (dupe) {
    return jsonResponse(409, {
      ok: false,
      error: 'An account with that email already exists. Use the existing-account path instead.',
    });
  }

  // Step 1 — invite. Creates auth.users + sends the styled invite
  // email. Supabase rejects this if the email is already in
  // auth.users, which is what we want.
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: REDIRECT_TO,
    data: { first_name: firstName, last_name: lastName, source: 'lounge' },
  });
  if (inviteErr || !invited?.user) {
    return jsonResponse(400, {
      ok: false,
      error: `Invite failed: ${inviteErr?.message ?? 'no user returned'}`,
    });
  }
  const newAuthUserId = invited.user.id;

  // Step 2 — accounts row. account_type=internal +
  // internal_sub_type=customer_service marks this as a clinic-only
  // person who shouldn't appear in Meridian's lab/practice surfaces.
  const composedName = `${firstName} ${lastName}`.trim();
  const { data: insertedAccount, error: accErr } = await admin
    .from('accounts')
    .insert({
      auth_user_id: newAuthUserId,
      account_type: 'internal',
      internal_sub_type: 'customer_service',
      status: 'active',
      name: composedName,
      first_name: firstName,
      last_name: lastName,
      login_email: email,
    })
    .select('id')
    .single();
  if (accErr || !insertedAccount) {
    // Roll back the auth user so a re-try with the same email works.
    await admin.auth.admin.deleteUser(newAuthUserId).catch(() => {});
    return jsonResponse(500, {
      ok: false,
      error: `Account insert failed: ${accErr?.message ?? 'no row returned'}`,
    });
  }
  const accountId = (insertedAccount as { id: string }).id;

  // Step 3 — lng_staff_members row. is_admin/is_manager from caller.
  const { data: staffRow, error: staffErr } = await admin
    .from('lng_staff_members')
    .insert({
      account_id: accountId,
      is_admin: isAdminFlag,
      is_manager: isManagerFlag,
    })
    .select('id')
    .single();
  if (staffErr || !staffRow) {
    // Best-effort cleanup so the next attempt isn't blocked.
    try { await admin.from('accounts').delete().eq('id', accountId); } catch { /* ignore */ }
    try { await admin.auth.admin.deleteUser(newAuthUserId); } catch { /* ignore */ }
    return jsonResponse(500, {
      ok: false,
      error: `Staff insert failed: ${staffErr?.message ?? 'no row returned'}`,
    });
  }

  return jsonResponse(200, {
    ok: true,
    staff_member_id: (staffRow as { id: string }).id,
    account_id: accountId,
    auth_user_id: newAuthUserId,
    display_name: composedName,
  });
});
