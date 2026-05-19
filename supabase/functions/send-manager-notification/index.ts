// send-manager-notification
//
// Fires after a cashier has actioned something that previously
// required a manager picker on the cart / payment sheet:
//
//   * discount_applied / discount_amended / discount_removed
//   * refund_issued
//   * payment_voided
//
// The list of accounts to notify lives in
// lng_settings 'manager_notifications.recipient_account_ids' (jsonb
// array of accounts.id values). Admin → Emails → General → Manager
// notifications is the editor. Each listed account that is still an
// active manager with a valid email receives one Resend email,
// rendered from the `manager_notification` template.
//
// The action that triggered the notification has already succeeded
// by the time we're called; failure to deliver MUST NOT undo the
// action. Per-recipient failures land on lng_system_failures so the
// admin can see the gap; success lands on lng_event_log. Both writes
// are best-effort.
//
// Request body:
//   {
//     action_kind: 'discount_applied' | 'discount_amended'
//                | 'discount_removed' | 'refund_issued'
//                | 'payment_voided',
//     amount_pence: number,         // signed magnitude (always positive)
//     reason: string,               // staff-typed reason
//     patient_id: string | null,    // for {{patientName}}
//     visit_id: string | null,      // for {{visitRef}} + {{visitUrl}}
//     staff_account_id: string | null, // the cashier
//   }
//
// Response:
//   { ok: true, recipients: N, delivered: M, failed: K }
//   { ok: false, error: '...' }
//
// Auth: signed-in user JWT. Any authenticated Lounge staff member
// can fire this — it's invoked from the same surfaces that already
// gate on signed-in status.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import {
  EMPTY_BRAND,
  loadBrand,
  loadTemplate,
  renderAndSend,
  type TemplateRow,
} from '../_shared/emailRenderer.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_MANAGER_FROM_ADDRESS =
  (Deno.env.get('RESEND_MANAGER_SENDER_ADDRESS') ?? '').trim() ||
  'manager@notifications.venneir.com';
const RESEND_MANAGER_FROM_NAME =
  (Deno.env.get('RESEND_MANAGER_FROM_NAME') ?? '').trim() || 'Venneir Lounge';
const LOUNGE_PUBLIC_URL = (
  Deno.env.get('LOUNGE_PUBLIC_URL') ?? 'https://lounge.venneir.com'
).replace(/\/$/, '');

type ActionKind =
  | 'discount_applied'
  | 'discount_amended'
  | 'discount_removed'
  | 'refund_issued'
  | 'payment_voided';

const ACTION_TITLES: Record<ActionKind, string> = {
  discount_applied: 'Discount applied',
  discount_amended: 'Discount amended',
  discount_removed: 'Discount removed',
  refund_issued: 'Refund issued',
  payment_voided: 'Payment voided',
};

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return jsonResponse(200, {
      ok: false,
      error: `send-manager-notification crashed: ${
        e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      }`,
    });
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Auth — accept any signed-in account. The action that triggered
  // this call has already been gated on the right role, so we just
  // need a non-anon JWT to keep the endpoint off the open internet.
  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) {
    return jsonResponse(401, { ok: false, error: 'No bearer token' });
  }
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) return jsonResponse(401, { ok: false, error: 'Not signed in' });

  // Parse and validate.
  let body: {
    action_kind?: string;
    amount_pence?: number;
    reason?: string;
    patient_id?: string | null;
    visit_id?: string | null;
    staff_account_id?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const actionKind = body.action_kind as ActionKind | undefined;
  if (!actionKind || !(actionKind in ACTION_TITLES)) {
    return jsonResponse(400, { ok: false, error: 'invalid action_kind' });
  }
  const amountPence = Number.isFinite(body.amount_pence)
    ? Math.max(0, Math.round(Number(body.amount_pence)))
    : 0;
  const reasonText = (body.reason ?? '').toString().trim();
  const patientId = body.patient_id ?? null;
  const visitId = body.visit_id ?? null;
  const staffAccountId = body.staff_account_id ?? null;

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Resolve recipient list. Empty list = nothing to do; that's
  //    a clean ok-response, not an error.
  const recipientIds = await readRecipientIds(admin);
  if (recipientIds.length === 0) {
    return jsonResponse(200, {
      ok: true,
      recipients: 0,
      delivered: 0,
      failed: 0,
      note: 'No manager notification recipients configured.',
    });
  }

  // 2. Look up each recipient: must still be an active manager with
  //    a login_email. Anyone disabled / deleted / non-manager since
  //    being added to the list gets dropped silently.
  const recipients = await readRecipients(admin, recipientIds);
  if (recipients.length === 0) {
    await logFailure(admin, {
      stage: 'no_eligible_recipients',
      action_kind: actionKind,
      configured_count: recipientIds.length,
    });
    return jsonResponse(200, {
      ok: true,
      recipients: 0,
      delivered: 0,
      failed: 0,
      note: 'Configured recipients are no longer active managers or lack email addresses.',
    });
  }

  // 3. Load template + brand + ancillary context (patient name,
  //    visit ref, staff name). Each lookup is best-effort — a missing
  //    visit shouldn't sink the whole send, the template just renders
  //    empty for that variable.
  const template = await loadTemplate(admin, 'manager_notification');
  if (!template || !template.enabled) {
    await logFailure(admin, {
      stage: 'template_missing_or_disabled',
      action_kind: actionKind,
    });
    return jsonResponse(200, {
      ok: false,
      error: 'manager_notification template missing or paused',
    });
  }
  const brand = await loadBrand(admin).catch(() => EMPTY_BRAND);

  const patientName = await resolvePatientName(admin, patientId);
  const { visitRef, visitUrl } = await resolveVisitRefAndUrl(admin, visitId);
  const staffName = await resolveAccountName(admin, staffAccountId);

  const amount = formatPence(amountPence);
  const actionTitle = ACTION_TITLES[actionKind];
  const actionSummary = buildActionSummary(actionKind, amount, visitRef, patientName);
  const processedAt = formatNow();

  // 4. Send one email per recipient. Per-recipient failures are
  //    logged but don't abort the rest.
  let delivered = 0;
  let failed = 0;
  for (const recipient of recipients) {
    const managerName = recipient.name;
    const variables: Record<string, string> = {
      actionTitle,
      actionSummary,
      amount,
      reason: reasonText,
      patientName,
      visitRef,
      staffName,
      managerName,
      processedAt,
      visitUrl,
    };
    const result = await renderAndSend({
      apiKey: RESEND_API_KEY,
      from: `${RESEND_MANAGER_FROM_NAME} <${RESEND_MANAGER_FROM_ADDRESS}>`,
      replyTo: RESEND_MANAGER_FROM_ADDRESS,
      to: recipient.email,
      template: template as TemplateRow,
      brand,
      variables,
    });
    if (result.ok) {
      delivered += 1;
      await admin.from('lng_event_log').insert({
        source: 'send-manager-notification',
        event_type: 'sent',
        payload: {
          action_kind: actionKind,
          recipient_account_id: recipient.id,
          recipient_email: recipient.email,
          visit_id: visitId,
          patient_id: patientId,
          message_id: result.messageId ?? null,
        },
      });
    } else {
      failed += 1;
      await logFailure(admin, {
        stage: 'resend_send',
        action_kind: actionKind,
        recipient_account_id: recipient.id,
        recipient_email: recipient.email,
        error: result.error,
      });
    }
  }

  return jsonResponse(200, {
    ok: failed === 0,
    recipients: recipients.length,
    delivered,
    failed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function readRecipientIds(admin: SupabaseClient): Promise<string[]> {
  const { data } = await admin
    .from('lng_settings')
    .select('value')
    .eq('key', 'manager_notifications.recipient_account_ids')
    .is('location_id', null)
    .maybeSingle();
  const value = (data as { value: unknown } | null)?.value;
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

interface RecipientRow {
  id: string;
  email: string;
  name: string;
}

async function readRecipients(
  admin: SupabaseClient,
  ids: string[],
): Promise<RecipientRow[]> {
  if (ids.length === 0) return [];
  // is_manager + active status live on lng_staff_members; we join to
  // accounts via account_id to pick up the display name + login_email.
  // Anyone configured as a recipient but no longer an active manager
  // (deactivated / un-flagged) silently drops here — Admin will see
  // them disappear when they re-open the Manager notifications card.
  const { data } = await admin
    .from('lng_staff_members')
    .select(
      'account_id, is_manager, status, account:accounts!account_id ( id, first_name, last_name, name, login_email )',
    )
    .in('account_id', ids)
    .eq('is_manager', true)
    .eq('status', 'active');
  const rows = (data ?? []) as Array<{
    account_id: string;
    is_manager: boolean | null;
    status: string | null;
    account:
      | {
          id: string;
          first_name: string | null;
          last_name: string | null;
          name: string | null;
          login_email: string | null;
        }
      | Array<{
          id: string;
          first_name: string | null;
          last_name: string | null;
          name: string | null;
          login_email: string | null;
        }>
      | null;
  }>;
  const out: RecipientRow[] = [];
  for (const r of rows) {
    const a = Array.isArray(r.account) ? r.account[0] ?? null : r.account;
    if (!a?.login_email) continue;
    out.push({
      id: r.account_id,
      email: a.login_email,
      name: displayName(a),
    });
  }
  return out;
}

function displayName(r: {
  first_name: string | null;
  last_name: string | null;
  name: string | null;
}): string {
  const fn = r.first_name?.trim() ?? '';
  const ln = r.last_name?.trim() ?? '';
  if (fn && ln) return `${fn} ${ln}`;
  return fn || ln || (r.name?.trim() ?? '') || 'there';
}

async function resolvePatientName(
  admin: SupabaseClient,
  patientId: string | null,
): Promise<string> {
  if (!patientId) return '';
  const { data } = await admin
    .from('patients')
    .select('first_name, last_name')
    .eq('id', patientId)
    .maybeSingle();
  const r = data as { first_name: string | null; last_name: string | null } | null;
  if (!r) return '';
  return displayName({ first_name: r.first_name, last_name: r.last_name, name: null });
}

async function resolveVisitRefAndUrl(
  admin: SupabaseClient,
  visitId: string | null,
): Promise<{ visitRef: string; visitUrl: string }> {
  if (!visitId) return { visitRef: '', visitUrl: '' };
  const visitUrl = `${LOUNGE_PUBLIC_URL}/visit/${visitId}`;
  // The LAP-NNNNN ref lives on the appointment, not the visit. A
  // visit may not yet have intake-stamped an appointment_ref; if
  // there's no row to read or no ref to read, render the slug
  // empty rather than substituting null.
  const { data: visitRow } = await admin
    .from('lng_visits')
    .select('appointment_id')
    .eq('id', visitId)
    .maybeSingle();
  const visit = visitRow as { appointment_id: string | null } | null;
  if (!visit?.appointment_id) return { visitRef: '', visitUrl };
  const { data: apptRow } = await admin
    .from('lng_appointments')
    .select('appointment_ref')
    .eq('id', visit.appointment_id)
    .maybeSingle();
  const appt = apptRow as { appointment_ref: string | null } | null;
  return { visitRef: appt?.appointment_ref ?? '', visitUrl };
}

async function resolveAccountName(
  admin: SupabaseClient,
  accountId: string | null,
): Promise<string> {
  if (!accountId) return '';
  const { data } = await admin
    .from('accounts')
    .select('first_name, last_name, name')
    .eq('id', accountId)
    .maybeSingle();
  const r = data as { first_name: string | null; last_name: string | null; name: string | null } | null;
  if (!r) return '';
  return displayName(r);
}

function buildActionSummary(
  kind: ActionKind,
  amount: string,
  visitRef: string,
  patientName: string,
): string {
  const target = visitRef
    ? `on ${visitRef}`
    : patientName
      ? `for ${patientName}`
      : 'on a visit';
  switch (kind) {
    case 'discount_applied':
      return `${amount} discount applied ${target}.`;
    case 'discount_amended':
      return `Discount amended to ${amount} ${target}.`;
    case 'discount_removed':
      return `Discount removed ${target}.`;
    case 'refund_issued':
      return `${amount} refund issued ${target}.`;
    case 'payment_voided':
      return `${amount} payment voided ${target}.`;
  }
}

function formatPence(amountPence: number): string {
  if (!Number.isFinite(amountPence) || amountPence < 0) return '£0.00';
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountPence / 100);
}

function formatNow(): string {
  const now = new Date();
  // Pin to Europe/London so the timestamp reads correctly regardless
  // of where the edge runs. Format: "Tue 19 May 2026 at 14:32".
  const datePart = now.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Europe/London',
  });
  const timePart = now.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/London',
  });
  return `${datePart} at ${timePart}`;
}

async function logFailure(
  admin: SupabaseClient,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    const stage = typeof context.stage === 'string' ? context.stage : 'unknown_stage';
    const message =
      typeof context.error === 'string' && context.error.length > 0
        ? `manager-notification ${stage}: ${context.error}`
        : `manager-notification ${stage}`;
    await admin.from('lng_system_failures').insert({
      source: 'send-manager-notification',
      severity: 'warning',
      message,
      context,
    });
  } catch {
    // System failure logging is itself best-effort — swallow.
  }
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
