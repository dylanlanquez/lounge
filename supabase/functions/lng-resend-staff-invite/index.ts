// lng-resend-staff-invite
//
// Admin re-sends the staff_invite email to a staff member who never
// accepted (or whose previous token expired). Mints a NEW
// invite_token + new 7-day expiry on lng_staff_members so the
// previous email's link stops working — the most recent send is
// always the only valid one — and re-renders + re-ships the same
// staff_invite template.
//
// Refuses to resend if the staff member already accepted (use
// "Send password reset" instead) or is deactivated.
//
// Body: { staff_member_id: string }
// Returns: {
//   ok: true,
//   email_sent: boolean,
//   manual_invite_link?: string,
//   email_error?: string,
// }
// Auth: Bearer JWT, caller must be an active Lounge admin.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { loadBrand, loadTemplate, renderAndSend } from '../_shared/emailRenderer.ts';
import { getEmailSenderHeaders } from '../_shared/emailSender.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
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

  // Same admin gate as lng-create-staff-account.
  const { data: callerRow } = await admin
    .from('accounts')
    .select('id, login_email, first_name, last_name, name')
    .eq('auth_user_id', callerAuthId)
    .maybeSingle();
  if (!callerRow) return jsonResponse(403, { ok: false, error: 'No account row for caller' });
  const caller = callerRow as {
    id: string;
    login_email: string | null;
    first_name: string | null;
    last_name: string | null;
    name: string | null;
  };
  const callerEmail = (caller.login_email ?? '').toLowerCase();
  const callerIsSuper = callerEmail === SUPER_ADMIN_EMAIL;
  const callerDisplay =
    [caller.first_name?.trim(), caller.last_name?.trim()].filter(Boolean).join(' ') ||
    caller.name?.trim() ||
    'the team';
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
  if (!staffId) {
    return jsonResponse(400, { ok: false, error: 'staff_member_id required' });
  }

  const { data: targetRow, error: targetErr } = await admin
    .from('lng_staff_members')
    .select(
      'id, status, invite_accepted_at, account:accounts!account_id ( login_email, first_name, last_name )',
    )
    .eq('id', staffId)
    .maybeSingle();
  if (targetErr) return jsonResponse(500, { ok: false, error: targetErr.message });
  if (!targetRow) return jsonResponse(404, { ok: false, error: 'Staff member not found' });
  const target = targetRow as {
    id: string;
    status: string;
    invite_accepted_at: string | null;
    account:
      | { login_email: string | null; first_name: string | null; last_name: string | null }
      | Array<{ login_email: string | null; first_name: string | null; last_name: string | null }>
      | null;
  };
  if (target.status === 'inactive') {
    return jsonResponse(409, {
      ok: false,
      error: 'Cannot resend invite — the staff account is deactivated. Reactivate first.',
    });
  }
  if (target.invite_accepted_at) {
    return jsonResponse(409, {
      ok: false,
      error:
        'This staff member has already accepted their invite. Use Send password reset instead if they cannot sign in.',
    });
  }
  const account = Array.isArray(target.account) ? target.account[0] ?? null : target.account;
  if (!account?.login_email) {
    return jsonResponse(500, { ok: false, error: 'Account row is missing an email address.' });
  }

  // Mint a fresh token + expiry; clears the previous token so any
  // older invite email stops working immediately.
  const inviteToken = crypto.randomUUID();
  const inviteSentAt = new Date();
  const inviteExpiresAt = new Date(inviteSentAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { error: updErr } = await admin
    .from('lng_staff_members')
    .update({
      invite_token: inviteToken,
      invite_sent_at: inviteSentAt.toISOString(),
      invite_expires_at: inviteExpiresAt.toISOString(),
    })
    .eq('id', staffId);
  if (updErr) return jsonResponse(500, { ok: false, error: updErr.message });

  const inviteUrl = `${LOUNGE_PUBLIC_URL}/welcome?invite=${inviteToken}`;
  const firstName = (account.first_name ?? '').trim();
  const lastName = (account.last_name ?? '').trim();

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
      to: account.login_email,
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
        source: 'lng-resend-staff-invite',
        severity: 'warning',
        message: `staff_invite resend failed: ${emailError ?? 'unknown'}`,
        context: { staff_member_id: staffId, recipient: account.login_email },
      });
    } catch { /* ignore */ }
  }

  // invite_url is always returned, even on email_sent: true. Resend
  // sometimes accepts a send and the message still doesn't reach the
  // recipient (corporate filters, broken DKIM on the destination
  // domain, ATP quarantines). Admins need the fresh URL on every
  // resend so they can hand-deliver via Slack/WhatsApp if the email
  // doesn't arrive. email_error stays gated on !emailSent.
  return jsonResponse(200, {
    ok: true,
    email_sent: emailSent,
    invite_url: inviteUrl,
    ...(emailSent ? {} : { manual_invite_link: inviteUrl, email_error: emailError }),
  });
});
