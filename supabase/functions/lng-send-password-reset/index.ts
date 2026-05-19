// lng-send-password-reset
//
// Issues a one-time password-recovery link for the target staff
// member and delivers it as a Lounge-branded email via Resend.
// Sibling of lng-create-staff-account — uses the same renderer
// (_shared/emailRenderer.ts) and the same Resend pipeline.
//
// Recipient flow: receives the email, clicks the button, lands on
// /welcome with type=recovery in the URL hash, the Welcome component
// shows the "Choose a new password" form, auth.updateUser is called,
// they're bounced into /schedule.
//
// Why generateLink({ type: 'recovery' }) and our own email instead of
// supabase.auth.resetPasswordForEmail: the resetPasswordForEmail
// primitive triggers the project-global "Reset password" auth
// template, which is shared with Meridian. Generating the link
// ourselves and rendering the Lounge password_reset template lets us
// brand and edit it independently. Same architectural reasoning as
// lng-create-staff-account.
//
// Auth: Bearer JWT (anon key). Caller must be an active Lounge admin
// (lng_staff_members.is_admin = true).
//
// Body: { staff_member_id: string }
//
// Returns: {
//   ok: true,
//   email_sent: boolean,
//   manual_recovery_link?: string,  // when email_sent === false
//   email_error?: string,
// }

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { loadBrand, loadTemplate, renderAndSend } from '../_shared/emailRenderer.ts';
import { getEmailSenderHeaders } from '../_shared/emailSender.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const REDIRECT_TO =
  Deno.env.get('LNG_RECOVERY_REDIRECT_URL') ?? 'https://lounge.venneir.com/welcome';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const LOUNGE_PUBLIC_URL = (
  Deno.env.get('LOUNGE_PUBLIC_URL') ?? 'https://lounge.venneir.com'
).replace(/\/+$/, '');

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

  // Caller must be an active Lounge admin.
  const { data: callerRaw, error: callerErr } = await admin
    .from('accounts')
    .select('id, login_email, first_name, last_name, name')
    .eq('auth_user_id', callerAuthId)
    .maybeSingle();
  if (callerErr) return jsonResponse(500, { ok: false, error: callerErr.message });
  if (!callerRaw) return jsonResponse(403, { ok: false, error: 'No account row for caller' });
  const caller = callerRaw as {
    id: string;
    first_name: string | null;
    last_name: string | null;
    name: string | null;
  };
  const callerDisplay =
    [caller.first_name?.trim(), caller.last_name?.trim()].filter(Boolean).join(' ') ||
    caller.name?.trim() ||
    'your administrator';

  const { data: callerStaff } = await admin
    .from('lng_staff_members')
    .select('is_admin, status')
    .eq('account_id', caller.id)
    .maybeSingle();
  if (callerStaff?.is_admin !== true || callerStaff.status !== 'active') {
    return jsonResponse(403, { ok: false, error: 'Lounge admin only' });
  }

  let body: { staff_member_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: 'Invalid JSON' });
  }
  const staffMemberId = body.staff_member_id?.trim() ?? '';
  if (!staffMemberId) {
    return jsonResponse(400, { ok: false, error: 'staff_member_id required' });
  }

  // Resolve the target staff member to an email + first name.
  const { data: targetRaw, error: targetErr } = await admin
    .from('lng_staff_members')
    .select('id, status, account:accounts!account_id(id, login_email, first_name, last_name, name)')
    .eq('id', staffMemberId)
    .maybeSingle();
  if (targetErr) return jsonResponse(500, { ok: false, error: targetErr.message });
  if (!targetRaw) return jsonResponse(404, { ok: false, error: 'Staff member not found' });
  const target = targetRaw as {
    id: string;
    status: 'active' | 'inactive';
    account: {
      id: string;
      login_email: string | null;
      first_name: string | null;
      last_name: string | null;
      name: string | null;
    } | null;
  };
  if (!target.account?.login_email) {
    return jsonResponse(400, { ok: false, error: 'Staff member has no email on file' });
  }
  const recipientEmail = target.account.login_email.trim().toLowerCase();
  const recipientFirstName =
    target.account.first_name?.trim() ||
    target.account.name?.trim()?.split(' ')[0] ||
    'there';
  const recipientLastName = target.account.last_name?.trim() ?? '';

  // Mint the recovery link. generateLink with type=recovery does NOT
  // trigger Supabase to send the project-global recovery template;
  // it just returns the link for us to embed in our own email.
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: recipientEmail,
    options: { redirectTo: REDIRECT_TO },
  });
  if (linkErr || !linkData?.properties?.action_link) {
    return jsonResponse(400, {
      ok: false,
      error: `Recovery link generation failed: ${linkErr?.message ?? 'no link returned'}`,
    });
  }
  const actionUrl = linkData.properties.action_link;

  // Render + send.
  const tpl = await loadTemplate(admin, 'password_reset');
  if (!tpl || !tpl.enabled) {
    await logFailure(admin, {
      message: 'password_reset template missing or disabled',
      context: { staff_member_id: staffMemberId, recipient: recipientEmail },
    });
    return jsonResponse(200, {
      ok: true,
      email_sent: false,
      manual_recovery_link: actionUrl,
      email_error: 'password_reset template missing or disabled',
    });
  }
  const brand = await loadBrand(admin);
  const sender = await getEmailSenderHeaders(admin);
  const result = await renderAndSend({
    apiKey: RESEND_API_KEY,
    from: sender.from,
    replyTo: sender.replyTo,
    to: recipientEmail,
    template: tpl,
    brand,
    variables: {
      firstName: recipientFirstName,
      lastName: recipientLastName,
      actionUrl,
      adminName: callerDisplay,
      loungeUrl: LOUNGE_PUBLIC_URL,
    },
  });

  if (!result.ok) {
    await logFailure(admin, {
      message: `password_reset email send failed: ${result.error}`,
      context: { staff_member_id: staffMemberId, recipient: recipientEmail },
    });
    return jsonResponse(200, {
      ok: true,
      email_sent: false,
      manual_recovery_link: actionUrl,
      email_error: result.error,
    });
  }

  return jsonResponse(200, {
    ok: true,
    email_sent: true,
    message_id: result.messageId,
  });
});

async function logFailure(
  admin: SupabaseClient,
  args: { message: string; context: Record<string, unknown> },
): Promise<void> {
  try {
    await admin.from('lng_system_failures').insert({
      source: 'lng-send-password-reset',
      severity: 'error',
      message: args.message,
      context: args.context,
    });
  } catch {
    // intentionally swallowed
  }
}
