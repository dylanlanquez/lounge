// _shared/emailSender.ts
//
// Resolves the canonical "From" + "Reply-To" headers for every
// outbound Resend email at send time. Admin (lng_settings under
// email.from_name / email.reply_to) is the source of truth for
// the display name and the reply-to address — both editable from
// Admin → Branding → Email sender. The verified Resend sending
// address is set via env (RESEND_SENDER_ADDRESS) so a domain
// re-verification doesn't require a code change; the in-code
// fallback is the current production-verified value.
//
// Why a runtime fetch instead of env-only:
//   • The admin can rebrand (e.g. "Venneir Clinic" → "Venneir
//     Lounge") without a redeploy. Reading admin at send time
//     means the next email reflects the new brand within seconds.
//   • Reply-to changes are similarly admin-controlled — cs@ for a
//     customer-service line vs clinic@ for an in-clinic surface.
//   • Falling back to env keeps the boot path safe before any
//     lng_settings rows are seeded (preview deploys, dev DBs).
//
// Fallback chain (display name):
//   1. lng_settings 'email.from_name' (admin)
//   2. env RESEND_FROM_NAME
//   3. 'Venneir Clinic'
//
// Fallback chain (sending address):
//   1. env RESEND_SENDER_ADDRESS
//   2. 'clinic@notifications.venneir.com'
//
// Fallback chain (reply-to):
//   1. lng_settings 'email.reply_to' (admin)
//   2. env RESEND_REPLY_TO_BOOKING
//   3. sending address (so replies still land somewhere we read)

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

export interface EmailSenderHeaders {
  /** Resend "from" header — display name + angle-bracket address. */
  from: string;
  /** Display name only, without the angle-bracket address. */
  fromName: string;
  /** Verified bounce/From address (no display name). */
  fromAddress: string;
  /** Reply-To header. Always an email address (no display name). */
  replyTo: string;
}

const DEFAULT_FROM_NAME = 'Venneir Clinic';
const DEFAULT_SENDER_ADDRESS = 'clinic@notifications.venneir.com';

/** Read the admin-edited email sender row from lng_settings.
 *  Uses .maybeSingle() so a missing row falls back to env/defaults
 *  rather than raising. Pulls the global (location_id IS NULL) row
 *  because the admin UI is single-location today; per-location
 *  overrides land on the same key with a non-null location_id. */
async function readAdminSenderRow(
  admin: SupabaseClient,
): Promise<{ fromName: string | null; replyTo: string | null }> {
  const { data } = await admin
    .from('lng_settings')
    .select('key, value')
    .in('key', ['email.from_name', 'email.reply_to'])
    .is('location_id', null);
  const rows = (data ?? []) as Array<{ key: string; value: unknown }>;
  const map = new Map<string, string>();
  for (const r of rows) {
    // lng_settings.value is jsonb — strings round-trip as JSON
    // strings, so the typeof check pulls them out without
    // re-parsing while still tolerating the legacy non-string case.
    if (typeof r.value === 'string') {
      map.set(r.key, r.value);
    } else if (r.value !== null && r.value !== undefined) {
      map.set(r.key, String(r.value));
    }
  }
  return {
    fromName: (map.get('email.from_name') ?? '').trim() || null,
    replyTo: (map.get('email.reply_to') ?? '').trim() || null,
  };
}

/** Build the canonical { from, replyTo } headers for any outbound
 *  Resend send. Pass the service-role-keyed admin client used by
 *  the calling edge function so the read bypasses RLS. */
export async function getEmailSenderHeaders(
  admin: SupabaseClient,
): Promise<EmailSenderHeaders> {
  const adminRow = await readAdminSenderRow(admin);

  const fromAddress =
    (Deno.env.get('RESEND_SENDER_ADDRESS') ?? '').trim() || DEFAULT_SENDER_ADDRESS;
  const envFromName = (Deno.env.get('RESEND_FROM_NAME') ?? '').trim();
  const fromName = adminRow.fromName ?? (envFromName || DEFAULT_FROM_NAME);
  const envReplyTo = (Deno.env.get('RESEND_REPLY_TO_BOOKING') ?? '').trim();
  const replyTo = adminRow.replyTo ?? (envReplyTo || fromAddress);

  return {
    from: `${fromName} <${fromAddress}>`,
    fromName,
    fromAddress,
    replyTo,
  };
}
