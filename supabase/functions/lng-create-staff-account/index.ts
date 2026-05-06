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
//      (admin-editable; same surface as the appointment-reminder
//      and booking-event templates) and delivers the email via Resend
//      with the freshly-minted invite link substituted in.
//
// Why we don't use auth.admin.inviteUserByEmail: that primitive
// triggers Supabase to send the project-global invite template. The
// Supabase project (npuvhxakffxqoszytkxw) is shared with Meridian
// per ADR-001, so re-branding the project's invite template to
// Lounge would also re-brand Meridian's invite emails. Instead, every
// Lounge transactional email is rendered from lng_email_templates
// and shipped via Resend — the same architecture
// send-appointment-reminders / send-appointment-confirmation already
// use. That gives Dylan one editing surface (Admin → Emails) for
// every Lounge customer- or staff-facing email and keeps Meridian's
// auth emails untouched.
//
// Why two distinct sign-ins per human: the same person can have a
// Meridian account (e.g. dylan@venneir.com) AND a Lounge-only account
// (e.g. dylanlane@venneir.com). They're two separate accounts /
// auth.users rows with two separate passwords. The shared accounts
// table is an implementation detail; from the user's perspective the
// two systems are independent.
//
// Auth: Bearer JWT (anon key). Caller must be an active Lounge admin
// (lng_staff_members.is_admin = true). Granting is_admin to the new
// account is additionally gated to the super-admin (single email,
// matched against SUPER_ADMIN_EMAIL). Regular admins can create
// non-admin staff; only super-admin can create another admin.
//
// Body: {
//   email: string,
//   first_name: string,
//   last_name: string,
//   is_admin?: boolean,
//   is_manager?: boolean,
// }
//
// Returns on success: {
//   ok: true,
//   staff_member_id, account_id, auth_user_id, display_name,
//   email_sent: boolean,
//   manual_invite_link?: string,  // present iff email_sent === false
// }
//
// On Resend failure we still return ok: true with email_sent: false
// and the invite link, because the staff identity IS valid — the
// admin can copy the link and deliver it manually rather than us
// rolling back a complete provisioning. This is logged to
// lng_system_failures for ops visibility.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { iconSvg as _iconSvg } from '../_shared/emailIcons.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const REDIRECT_TO =
  Deno.env.get('LNG_INVITE_REDIRECT_URL') ?? 'https://lounge.venneir.com/welcome';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_FROM =
  Deno.env.get('LNG_INVITE_FROM') ??
  Deno.env.get('RESEND_FROM_BOOKING') ??
  'Venneir Lounge <lounge@venneir.com>';
const RESEND_REPLY_TO =
  Deno.env.get('LNG_INVITE_REPLY_TO') ??
  Deno.env.get('RESEND_REPLY_TO_BOOKING') ??
  'lounge@venneir.com';
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

  // Caller identity. Read via service-role so RLS can't hide the row.
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

  // Hard-reject emails that already have an accounts row. The Admin
  // sheet's submitAdd already tries the existing-account path first;
  // a direct caller of this function still needs the safety net.
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

  // Step 1 — mint the auth user + invite token.
  // generateLink({ type: 'invite' }) creates auth.users AND returns
  // properties.action_link, but does NOT send Supabase's per-project
  // invite email. We send our own through Resend below.
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
    // Roll back the auth user so a re-try with the same email works.
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
    // Best-effort cleanup.
    try { await admin.from('accounts').delete().eq('id', accountId); } catch { /* ignore */ }
    try { await admin.auth.admin.deleteUser(newAuthUserId); } catch { /* ignore */ }
    return jsonResponse(500, {
      ok: false,
      error: `Staff insert failed: ${staffErr?.message ?? 'no row returned'}`,
    });
  }
  const staffMemberId = (staffRow as { id: string }).id;

  // Step 4 — render and send the invite email.
  // Past this point, db rows are all in place. If the email send
  // fails we don't roll back the user — they have a valid identity
  // and the admin can copy the link to deliver manually. We do log
  // to lng_system_failures so ops sees the gap.
  let emailSent = false;
  let emailError: string | null = null;
  try {
    const tplRow = await loadTemplate(admin, 'staff_invite');
    if (!tplRow || !tplRow.enabled) {
      emailError = 'staff_invite template missing or disabled';
    } else if (!RESEND_API_KEY) {
      emailError = 'RESEND_API_KEY not configured';
    } else {
      const brand = await loadBrand(admin);
      const variables: Record<string, string> = {
        firstName,
        lastName,
        inviteUrl,
        adminName: callerDisplay,
        loungeUrl: LOUNGE_PUBLIC_URL,
      };
      const subject = substituteVariables(tplRow.subject, variables);
      const bodyAfterVars = substituteVariables(tplRow.body_syntax, variables);
      const bodyHtml = parseFormatting(bodyAfterVars);
      const html = wrapInLoungeShell(bodyHtml, brand);
      const text = bodyToText(bodyAfterVars);
      const send = await sendEmail({ to: email, subject, html, text });
      if (!send.ok) {
        emailError = send.error;
      } else {
        emailSent = true;
      }
    }
  } catch (e) {
    emailError = `Render or send threw: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (!emailSent) {
    await logFailure(admin, {
      message: `staff_invite email send failed: ${emailError ?? 'unknown'}`,
      context: {
        recipient: email,
        new_auth_user_id: newAuthUserId,
        account_id: accountId,
        staff_member_id: staffMemberId,
      },
    });
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

// ─────────────────────────────────────────────────────────────────────────────
// Template + branding loaders
// ─────────────────────────────────────────────────────────────────────────────

interface TemplateRow {
  subject: string;
  body_syntax: string;
  enabled: boolean;
}

async function loadTemplate(
  admin: SupabaseClient,
  key: string,
): Promise<TemplateRow | null> {
  const { data, error } = await admin
    .from('lng_email_templates')
    .select('subject, body_syntax, enabled')
    .eq('key', key)
    .maybeSingle();
  if (error || !data) return null;
  return data as TemplateRow;
}

interface BrandSettings {
  logoUrl: string;
  logoShow: boolean;
  logoMaxWidth: number;
  accentColor: string;
  companyNumber: string;
  vatNumber: string;
  registeredAddress: string;
}

const EMPTY_BRAND: BrandSettings = {
  logoUrl: '',
  logoShow: false,
  logoMaxWidth: 120,
  accentColor: '#0E1414',
  companyNumber: '',
  vatNumber: '',
  registeredAddress: '',
};

async function loadBrand(admin: SupabaseClient): Promise<BrandSettings> {
  const { data: rows, error } = await admin
    .from('lng_settings')
    .select('key, value')
    .or('key.like.email.%,key.like.legal.%')
    .is('location_id', null);
  if (error || !rows) return EMPTY_BRAND;
  const map = new Map<string, unknown>();
  for (const r of rows as Array<{ key: string; value: unknown }>) map.set(r.key, r.value);
  const get = <T>(k: string, fallback: T): T => {
    const v = map.get(k);
    return v === undefined || v === null ? fallback : (v as T);
  };
  return {
    logoUrl: get<string>('email.brand_logo_url', ''),
    logoShow: get<boolean>('email.brand_logo_show', true),
    logoMaxWidth: get<number>('email.brand_logo_max_width', 120),
    accentColor: get<string>('email.brand_accent_color', '#0E1414'),
    companyNumber: get<string>('legal.company_number', ''),
    vatNumber: get<string>('legal.vat_number', ''),
    registeredAddress: get<string>('legal.registered_address', ''),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resend
// ─────────────────────────────────────────────────────────────────────────────

async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
  let r: Response;
  try {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [args.to],
        reply_to: RESEND_REPLY_TO,
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
    });
  } catch (e) {
    return {
      ok: false,
      error: `Resend network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const respBody = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: `Resend ${r.status}: ${JSON.stringify(respBody)}` };
  return { ok: true, messageId: (respBody as { id?: string }).id };
}

async function logFailure(
  admin: SupabaseClient,
  args: { message: string; context: Record<string, unknown> },
): Promise<void> {
  try {
    await admin.from('lng_system_failures').insert({
      source: 'lng-create-staff-account',
      severity: 'error',
      message: args.message,
      context: args.context,
    });
  } catch {
    // intentionally swallowed — failure-logging failure shouldn't crash the response
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Email parser — Deno copy of src/lib/emailRenderer.ts. Kept in sync
// by hand because Deno can't import from src/ directly. If you change
// one, change every other inlined copy AND extend
// src/lib/emailRenderer.test.ts to cover the new behaviour. The four
// functions that currently inline this renderer are
// send-appointment-reminders, send-appointment-confirmation,
// send-template-test, and this one.
// ─────────────────────────────────────────────────────────────────────────────

function substituteVariables(template: string, variables: Record<string, string>): string {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (full, key: string) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      return variables[key] ?? '';
    }
    return full;
  });
}

const _BLOCK_MB = '0 0 8px 0';
const _STYLE_PARA = `margin:${_BLOCK_MB}`;
const _STYLE_H1 = `font-size:28px;font-weight:700;margin:${_BLOCK_MB};color:#0E1414;letter-spacing:-0.02em`;
const _STYLE_H2 = `font-size:20px;font-weight:600;margin:${_BLOCK_MB};color:#0E1414;letter-spacing:-0.01em`;
const _STYLE_H3 = `font-size:16px;font-weight:600;margin:${_BLOCK_MB};color:#0E1414;letter-spacing:-0.01em`;
const _STYLE_H4 = `font-size:13px;font-weight:600;margin:${_BLOCK_MB};color:#0E1414;letter-spacing:0.02em;text-transform:uppercase`;
const _STYLE_HR = `border:none;border-top:1px solid #E5E2DC;margin:${_BLOCK_MB}`;
const _STYLE_IMG = `max-width:100%;border-radius:8px;margin:${_BLOCK_MB};display:block`;
const _STYLE_LIST = `margin:${_BLOCK_MB}`;
const _STYLE_LI = 'display:block;padding-left:16px;position:relative;margin:0';
const _STYLE_BUL = 'position:absolute;left:0;top:0;color:#0E1414';

function _applyInlines(text: string): string {
  let out = text;
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/\{color:([^}]+)\}(.+?)\{\/color\}/g, '<span style="color:$1">$2</span>');
  out = out.replace(/\{w:([^}]+)\}(.+?)\{\/w\}/g, '<span style="font-weight:$1">$2</span>');
  out = out.replace(
    /\[button:(.+?)(?:\|([^|<>\]"(]*)\|([^|<>\]"(]*)\|([^|<>\]"(]*)\|([^|<>\]"(]*)\|([^|<>\]"(]*)(?:\|([^|<>\]"(]*)\|([^|<>\]"(]*)\|([^|<>\]"(]*))?)?\]\(([^)]+)\)/g,
    (
      _: string,
      label: string,
      bg: string | undefined,
      tc: string | undefined,
      rad: string | undefined,
      mt: string | undefined,
      mb: string | undefined,
      bw: string | undefined,
      bc: string | undefined,
      icon: string | undefined,
      url: string,
    ) => {
      const bgC = bg || '#0E1414';
      const tcC = tc || '#FFFFFF';
      const radC = rad || '999';
      const mtC = mt || '12';
      const mbC = mb || '12';
      const bwNum = Number(bw || '0');
      const bcC = bc || '#0E1414';
      const iconHtml = icon ? _iconSvg(icon, tcC, 16) : '';
      const border = bwNum > 0 ? `border:${bwNum}px solid ${bcC};` : '';
      return `<a href="${url}" style="display:inline-block;padding:12px 28px;background:${bgC};color:${tcC};text-decoration:none;border-radius:${radC}px;font-weight:600;font-size:14px;margin:${mtC}px 0 ${mbC}px 0;letter-spacing:-0.005em;${border}">${iconHtml}${label}</a>`;
    },
  );
  out = out.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" style="color:#0E1414;text-decoration:underline">$1</a>');
  return out;
}

function parseFormatting(syntax: string): string {
  if (!syntax) return '';
  const trimmed = syntax.replace(/^\n+|\n+$/g, '');
  if (!trimmed) return '';
  const lines = trimmed.split('\n');
  const blocks: string[] = [];
  let buffer: string[] = [];
  let listItems: string[] = [];
  let emptyStreak = 0;
  const flushBuffer = () => {
    if (buffer.length === 0) return;
    blocks.push(`<p style="${_STYLE_PARA}">${_applyInlines(buffer.join('<br>'))}</p>`);
    buffer = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems
      .map((item) => `<span style="${_STYLE_LI}"><span style="${_STYLE_BUL}">•</span>${_applyInlines(item)}</span>`)
      .join('');
    blocks.push(`<div style="${_STYLE_LIST}">${items}</div>`);
    listItems = [];
  };
  for (const line of lines) {
    if (line === '') {
      flushBuffer();
      flushList();
      emptyStreak++;
      continue;
    }
    if (emptyStreak > 1) {
      for (let i = 0; i < emptyStreak - 1; i++) blocks.push(`<p style="${_STYLE_PARA}">&nbsp;</p>`);
    }
    emptyStreak = 0;
    if (/^---+$/.test(line.trim())) {
      flushBuffer();
      flushList();
      blocks.push(`<hr style="${_STYLE_HR}">`);
      continue;
    }
    const h4 = line.match(/^#### (.+)$/);
    if (h4 && h4[1]) {
      flushBuffer();
      flushList();
      blocks.push(`<h4 style="${_STYLE_H4}">${_applyInlines(h4[1])}</h4>`);
      continue;
    }
    const h3 = line.match(/^### (.+)$/);
    if (h3 && h3[1]) {
      flushBuffer();
      flushList();
      blocks.push(`<h3 style="${_STYLE_H3}">${_applyInlines(h3[1])}</h3>`);
      continue;
    }
    const h2 = line.match(/^## (.+)$/);
    if (h2 && h2[1]) {
      flushBuffer();
      flushList();
      blocks.push(`<h2 style="${_STYLE_H2}">${_applyInlines(h2[1])}</h2>`);
      continue;
    }
    const h1 = line.match(/^# (.+)$/);
    if (h1 && h1[1]) {
      flushBuffer();
      flushList();
      blocks.push(`<h1 style="${_STYLE_H1}">${_applyInlines(h1[1])}</h1>`);
      continue;
    }
    const img = line.trim().match(/^!\[([^\]]*)\]\((.+?)\)$/);
    if (img && img[2] !== undefined) {
      flushBuffer();
      flushList();
      blocks.push(`<img src="${img[2]}" alt="${img[1] ?? ''}" style="${_STYLE_IMG}">`);
      continue;
    }
    const li = line.match(/^- (.+)$/);
    if (li && li[1]) {
      flushBuffer();
      listItems.push(li[1]);
      continue;
    }
    flushList();
    buffer.push(line);
  }
  flushBuffer();
  flushList();
  return blocks.join('');
}

function bodyToText(syntax: string): string {
  if (!syntax) return '';
  return syntax
    .replace(/#### (.+)/g, '$1')
    .replace(/### (.+)/g, '$1')
    .replace(/## (.+)/g, '$1')
    .replace(/# (.+)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '$1')
    .replace(/\{color:[^}]+\}([^{]+)\{\/color\}/g, '$1')
    .replace(/\{w:[^}]+\}([^{]+)\{\/w\}/g, '$1')
    .replace(/!\[([^\]]*)\]\((.+?)\)/g, '[image: $1 — $2]')
    .replace(/\[button:([^|\]]+)(?:\|[^\]]*)?\]\((.+?)\)/g, '$1: $2')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .replace(/^---$/gm, '────────────')
    .trim();
}

function renderLogoHeader(brand: BrandSettings): string {
  if (!brand.logoShow || !brand.logoUrl) return '';
  const maxWidth = Math.max(40, Math.min(320, brand.logoMaxWidth));
  return `<p style="margin:0 0 8px 0;text-align:center"><img src="${brand.logoUrl}" alt="" style="max-width:${maxWidth}px;height:auto;display:inline-block;border:0"></p>`;
}

function renderLegalFooter(brand: BrandSettings): string {
  const lines: string[] = ['Venneir Limited'];
  if (brand.companyNumber) lines.push(`Company no. ${brand.companyNumber}`);
  if (brand.vatNumber) lines.push(`VAT no. ${brand.vatNumber}`);
  if (brand.registeredAddress) lines.push(brand.registeredAddress);
  return `<p style="margin:24px 0 0;color:#7B8285;font-size:12px;text-align:center;line-height:1.55">${lines.join(' · ')}</p>`;
}

function wrapInLoungeShell(bodyHtml: string, brand: BrandSettings): string {
  const logo = renderLogoHeader(brand);
  const footer = renderLegalFooter(brand);
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F7F6F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0E1414;line-height:1.6;-webkit-font-smoothing:antialiased">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px">
    <div style="background:#FFFFFF;border:1px solid #E5E2DC;border-radius:14px;padding:32px 28px;font-size:15px;color:#0E1414">
      ${logo}${bodyHtml}
    </div>
    ${footer}
  </div>
</body></html>`;
}
