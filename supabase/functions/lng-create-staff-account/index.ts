// lng-create-staff-account
//
// Provisions a brand-new Lounge staff identity end-to-end:
//
//   1. Mints an auth.users row + invite token via
//      auth.admin.generateLink({ type: 'invite' }). Critically, this
//      DOES NOT trigger Supabase's per-project auth invite email —
//      Supabase only sends if you call inviteUserByEmail. We want to
//      send our own.
//   2. Inserts a public.accounts row (account_type=internal,
//      internal_sub_type=customer_service) so the new identity is
//      tagged as clinic-only and won't be surfaced in Meridian's
//      lab/practice views.
//   3. Inserts a public.lng_staff_members row with the supplied
//      role flags (is_admin / is_manager).
//   4. Renders the staff_invite template from public.lng_email_templates
//      via the shared renderer (_shared/emailRenderer.ts) and
//      delivers the email through Resend.
//
// Why we don't use auth.admin.inviteUserByEmail: that primitive
// triggers Supabase to send the project-global invite template. The
// Supabase project (npuvhxakffxqoszytkxw) is shared with Meridian
// per ADR-001, so re-branding the project's invite template to
// Lounge would also re-brand Meridian's invite emails. Instead, every
// Lounge transactional email is rendered from lng_email_templates
// and shipped via Resend — same architecture as send-appointment-
// reminders / send-appointment-confirmation / lng-send-password-
// reset / lng-send-magic-link. That gives one editing surface
// (Admin → Emails) for every Lounge customer- or staff-facing email.
//
// Auth: Bearer JWT (anon key). Caller must be an active Lounge admin.
// Granting is_admin to the new account is super-admin-only.
//
// Body: { email, first_name, last_name, is_admin?, is_manager? }
//
// Returns: {
//   ok, staff_member_id, account_id, auth_user_id, display_name,
//   email_sent, manual_invite_link?, email_error?
// }

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { loadBrand, loadTemplate, renderAndSend } from '../_shared/emailRenderer.ts';
import { getEmailSenderHeaders } from '../_shared/emailSender.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const REDIRECT_TO =
  Deno.env.get('LNG_INVITE_REDIRECT_URL') ?? 'https://lounge.venneir.com/welcome';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const LOUNGE_PUBLIC_URL = (
  Deno.env.get('LOUNGE_PUBLIC_URL') ?? 'https://lounge.venneir.com'
).replace(/\/+$/, '');
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

  const { data: callerRaw, error: callerErr } = await admin
    .from('accounts')
    .select('id, login_email, first_name, last_name, name')
    .eq('auth_user_id', callerAuthId)
    .maybeSingle();
  if (callerErr) return jsonResponse(500, { ok: false, error: callerErr.message });
  if (!callerRaw) return jsonResponse(403, { ok: false, error: 'No account row for caller' });
  const caller = callerRaw as {
    id: string;
    login_email: string | null;
    first_name: string | null;
    last_name: string | null;
    name: string | null;
  };
  const callerEmail = caller.login_email ?? '';
  const callerIsSuper = callerEmail.toLowerCase() === SUPER_ADMIN_EMAIL;
  const callerDisplay =
    [caller.first_name?.trim(), caller.last_name?.trim()].filter(Boolean).join(' ') ||
    caller.name?.trim() ||
    'the team';

  const { data: callerStaff } = await admin
    .from('lng_staff_members')
    .select('is_admin, status')
    .eq('account_id', caller.id)
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

  // Step 1 — mint the auth user + invite token. generateLink does
  // NOT trigger Supabase's project-global invite email; we render
  // and send our own below.
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'invite',
    email,
    options: {
      redirectTo: REDIRECT_TO,
      data: { first_name: firstName, last_name: lastName, source: 'lounge' },
    },
  });
  if (linkErr || !linkData?.user || !linkData.properties?.action_link) {
    return jsonResponse(400, {
      ok: false,
      error: `Invite link generation failed: ${linkErr?.message ?? 'no link returned'}`,
    });
  }
  const newAuthUserId = linkData.user.id;
  const inviteUrl = linkData.properties.action_link;

  // Step 2 — accounts row.
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
    try { await admin.auth.admin.deleteUser(newAuthUserId); } catch { /* ignore */ }
    return jsonResponse(500, {
      ok: false,
      error: `Account insert failed: ${accErr?.message ?? 'no row returned'}`,
    });
  }
  const accountId = (insertedAccount as { id: string }).id;

  // Step 3 — lng_staff_members row.
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
    try { await admin.from('accounts').delete().eq('id', accountId); } catch { /* ignore */ }
    try { await admin.auth.admin.deleteUser(newAuthUserId); } catch { /* ignore */ }
    return jsonResponse(500, {
      ok: false,
      error: `Staff insert failed: ${staffErr?.message ?? 'no row returned'}`,
    });
  }
  const staffMemberId = (staffRow as { id: string }).id;

  // Step 4 — render and send. Past this point the db rows are in
  // place; on Resend failure we don't roll back, we surface the
  // manual invite link so the admin can deliver it themselves.
  let emailSent = false;
  let emailError: string | null = null;
  const tpl = await loadTemplate(admin, 'staff_invite');
  if (!tpl || !tpl.enabled) {
    emailError = 'staff_invite template missing or disabled';
  } else {
    const brand = await loadBrand(admin);
    const sender = await getEmailSenderHeaders(admin);
    const result = await renderAndSend({
      apiKey: RESEND_API_KEY,
      from: sender.from,
      replyTo: sender.replyTo,
      to: email,
      template: tpl,
      brand,
      variables: {
        firstName,
        lastName,
        inviteUrl,
        adminName: callerDisplay,
        loungeUrl: LOUNGE_PUBLIC_URL,
      },
    });
    if (result.ok) {
      emailSent = true;
    } else {
      emailError = result.error;
    }
  }

  if (!emailSent) {
    try {
      await admin.from('lng_system_failures').insert({
        source: 'lng-create-staff-account',
        severity: 'error',
        message: `staff_invite email send failed: ${emailError ?? 'unknown'}`,
        context: {
          recipient: email,
          new_auth_user_id: newAuthUserId,
          account_id: accountId,
          staff_member_id: staffMemberId,
        },
      });
    } catch { /* ignore */ }
  }

  return jsonResponse(200, {
    ok: true,
    staff_member_id: staffMemberId,
    account_id: accountId,
    auth_user_id: newAuthUserId,
    display_name: composedName,
    email_sent: emailSent,
    ...(emailSent ? {} : { manual_invite_link: inviteUrl, email_error: emailError }),
  });
});
