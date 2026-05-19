// send-template-test
//
// One-off "send a test email of this template draft" call from the
// admin email-templates editor. The admin types subject + body in
// the editor, hits "Send test", picks (or accepts the default) a
// recipient email, and this function renders the draft with sample
// variables + ships it via Resend with a [TEST] subject prefix.
//
// Auth: signed-in admin user JWT. We verify the caller is an Lounge
// admin OR super admin so a regular receptionist can't fire test
// emails to arbitrary recipients (Resend bills us, and a malicious
// recipient parameter could be abused).
//
// Body shape:
//   {
//     subject: string,           // current draft subject
//     bodySyntax: string,        // current draft body in storage syntax
//     variables: { ... },        // sample variable values
//     to: string                 // recipient email
//   }
//
// Returns { ok: true, messageId } on success or { ok: false, error }.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { parseFormatting, wrapInLoungeShell, EMPTY_BRAND } from '../_shared/emailRenderer.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_FROM = Deno.env.get('RESEND_FROM_BOOKING') ?? 'Venneir Appointments <lounge@venneir.com>';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO_BOOKING') ?? 'lounge@venneir.com';

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return jsonResponse(200, {
      ok: false,
      error: `send-template-test crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    });
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) {
    return jsonResponse(401, { ok: false, error: 'No bearer token' });
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) return jsonResponse(401, { ok: false, error: 'Not signed in' });

  // Admin gate: only lng admins / super admins can send test emails.
  // Reads via the user JWT so RLS narrows accordingly; falls back
  // to a service-role client for the actual send.
  const { data: meRaw } = await userClient
    .from('accounts')
    .select('account_types')
    .eq('auth_user_id', who.user.id)
    .maybeSingle();
  const me = meRaw as { account_types: string[] | null } | null;
  const types = me?.account_types ?? [];
  const isAdmin = types.includes('admin') || types.includes('lng_admin') || types.includes('super_admin');
  if (!isAdmin) {
    return jsonResponse(403, { ok: false, error: 'Admin access required to send test emails' });
  }

  let body: {
    subject?: string;
    bodySyntax?: string;
    variables?: Record<string, string>;
    to?: string;
  };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const { subject, bodySyntax, variables, to } = body;
  if (!subject || !bodySyntax || !to) {
    return jsonResponse(400, {
      ok: false,
      error: 'subject, bodySyntax, and to are required',
    });
  }

  if (!RESEND_API_KEY) {
    return jsonResponse(200, {
      ok: false,
      error: 'Email delivery not configured (RESEND_API_KEY missing)',
    });
  }

  // Render via the SHARED renderer so the test send matches a real
  // send byte-for-byte. The previous inline parser was a parallel
  // copy that lagged behind every fix to _shared (most recently the
  // raw-HTML passthrough that lets {{appointmentTimeline}} /
  // {{paymentStatusBlock}} / {{dentureRepairTable}} render without
  // <p> auto-close artifacts), so the in-app preview AND the
  // production confirmation/reminder emails would be tight but the
  // test send still showed huge gaps. Sharing the renderer kills the
  // divergence in one move.
  const subjectFinal = `[TEST] ${substituteVariables(subject, variables ?? {})}`;
  const bodyAfterVars = substituteVariables(bodySyntax, variables ?? {});
  const html = wrapInLoungeShell(parseFormatting(bodyAfterVars), EMPTY_BRAND);
  const text = bodyToText(bodyAfterVars);

  const sendResult = await sendEmail({ to, subject: subjectFinal, html, text });
  if (!sendResult.ok) {
    return jsonResponse(200, { ok: false, error: sendResult.error });
  }

  // Audit row so admins can see who sent which test.
  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  await admin.from('lng_event_log').insert({
    source: 'send-template-test',
    event_type: 'test_sent',
    payload: {
      sent_by_auth_user: who.user.id,
      recipient: to,
      message_id: sendResult.messageId ?? null,
    },
  });

  return jsonResponse(200, {
    ok: true,
    recipient: to,
    messageId: sendResult.messageId ?? null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderer (parallel copy of src/lib/emailRenderer.ts — Deno can't
// import from src/. Same syntax, same output. Update both + the
// test file if the format changes.)
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

// Plain-text equivalent for the multipart alternative. The shared
// renderer exports a `parseFormatting` for HTML but not a parallel
// text downgrade, so keep this small helper here. Mirrors the prior
// inline behaviour byte-for-byte; the format hasn't changed.
function bodyToText(syntax: string): string {
  if (!syntax) return '';
  return syntax
    .replace(/### (.+)/g, '$1')
    .replace(/## (.+)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '$1')
    .replace(/\{color:[^}]+\}([^{]+)\{\/color\}/g, '$1')
    .replace(/!\[([^\]]*)\]\((.+?)\)/g, '[image: $1 — $2]')
    .replace(/\[button:([^|\]]+)(?:\|[^\]]*)?\]\((.+?)\)/g, '$1: $2')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .replace(/^---$/gm, '────────────')
    .trim();
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
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: `Resend ${r.status}: ${JSON.stringify(body)}` };
  return { ok: true, messageId: (body as { id?: string }).id };
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}
