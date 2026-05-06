-- 20260506000022_lng_account_actions.sql
--
-- Per-staff Account Actions (chunk 2).
--
-- Scope of this migration:
--   1. Seed two new admin-editable email templates:
--        * password_reset — admin-issued recovery link
--        * magic_link     — admin-issued one-time sign-in link
--      Both rendered + sent through the same Resend pipeline as
--      staff_invite (chunk 1, 20260506000021). The Admin → Emails
--      tab picks them up automatically; subject/body are editable
--      with version history.
--   2. Add lng_staff_members.require_2fa boolean column. Stored
--      configuration only at this migration; the actual sign-in
--      gate that enforces AAL2 lands in chunk 3 alongside the
--      enrolment + challenge screens. Storing it now decouples the
--      admin UI work from the MFA UI work and lets admins pre-set
--      the requirement on a staff row before chunk 3 ships.
--
-- ── Variable surface (both new templates) ─────────────────────────
--
--   {{firstName}}    recipient's first name (used in greeting)
--   {{lastName}}     recipient's last name
--   {{actionUrl}}    one-time link generated via
--                    auth.admin.generateLink({ type: 'recovery' })
--                    or { type: 'magiclink' }. Embeds a Supabase
--                    token; expires per the project's auth settings
--                    (default 1h for recovery, 10m for magic link).
--   {{adminName}}    full display name of the admin who issued the
--                    action. "Dylan Lane" or similar. Falls back to
--                    "your administrator" so the copy still reads
--                    cleanly when the caller can't be resolved.
--   {{loungeUrl}}    canonical app URL, e.g. https://lounge.venneir.com.
--
-- Rollback:
--   delete from public.lng_email_template_history
--    where template_key in ('password_reset', 'magic_link');
--   delete from public.lng_email_templates
--    where key in ('password_reset', 'magic_link');
--   alter table public.lng_staff_members drop column require_2fa;

-- ── 1. password_reset ─────────────────────────────────────────────

insert into public.lng_email_templates (
  key, subject, body_syntax, default_subject, default_body_syntax,
  description, enabled
) values (
  'password_reset',
  $SUBJECT$Reset your Lounge password$SUBJECT$,
$BODY$Hi {{firstName}},

{{adminName}} has issued a password reset for your Lounge account. Click below to choose a new password.

[button:Reset password|#1F4D3A|#FFFFFF|14|20|24]({{actionUrl}})

This link is good for one hour. If you didn't request this, ignore this email and your password will stay the same.

The Venneir Lounge team$BODY$,
  $SUBJECT$Reset your Lounge password$SUBJECT$,
$BODY$Hi {{firstName}},

{{adminName}} has issued a password reset for your Lounge account. Click below to choose a new password.

[button:Reset password|#1F4D3A|#FFFFFF|14|20|24]({{actionUrl}})

This link is good for one hour. If you didn't request this, ignore this email and your password will stay the same.

The Venneir Lounge team$BODY$,
  'Sent when an admin clicks "Send password reset link" on a staff row, OR when a staff member uses self-service forgotten-password (chunk 3+). Recipient lands on /welcome with type=recovery and is prompted to choose a new password.',
  true
)
on conflict (key) do nothing;

insert into public.lng_email_template_history (template_key, version, subject, body_syntax)
select key, version, subject, body_syntax
from public.lng_email_templates
where key = 'password_reset'
on conflict (template_key, version) do nothing;

-- ── 2. magic_link ─────────────────────────────────────────────────

insert into public.lng_email_templates (
  key, subject, body_syntax, default_subject, default_body_syntax,
  description, enabled
) values (
  'magic_link',
  $SUBJECT$Sign in to Lounge$SUBJECT$,
$BODY$Hi {{firstName}},

{{adminName}} has sent you a one-time sign-in link. Click below to sign straight in, no password needed.

[button:Sign in to Lounge|#1F4D3A|#FFFFFF|14|20|24]({{actionUrl}})

This link is good for ten minutes and can only be used once. Useful if password reset isn't reaching your inbox.

The Venneir Lounge team$BODY$,
  $SUBJECT$Sign in to Lounge$SUBJECT$,
$BODY$Hi {{firstName}},

{{adminName}} has sent you a one-time sign-in link. Click below to sign straight in, no password needed.

[button:Sign in to Lounge|#1F4D3A|#FFFFFF|14|20|24]({{actionUrl}})

This link is good for ten minutes and can only be used once. Useful if password reset isn't reaching your inbox.

The Venneir Lounge team$BODY$,
  'Sent when an admin clicks "Send sign-in link" on a staff row. Recipient clicks through to a fully-signed-in /schedule with no password challenge. Used as a fallback when password reset emails are filtered out.',
  true
)
on conflict (key) do nothing;

insert into public.lng_email_template_history (template_key, version, subject, body_syntax)
select key, version, subject, body_syntax
from public.lng_email_templates
where key = 'magic_link'
on conflict (template_key, version) do nothing;

-- ── 3. lng_staff_members.require_2fa ──────────────────────────────
--
-- Configuration only at this migration. Chunk 3 wires up the actual
-- enforcement at sign-in: when require_2fa is true and the session's
-- AAL is below aal2, the auth gate routes the user to /enroll-2fa
-- (no factors yet) or /verify-2fa (factors enrolled, AAL upgrade
-- required). Storing the bool now lets admins pre-stage the policy
-- per staff member before that wiring lands.
--
-- Default false: existing staff aren't forced into 2FA on the next
-- deploy. Super-admin grants are still gated UI-side; the column
-- itself is just a boolean so future bulk enforcement is one update.

alter table public.lng_staff_members
  add column if not exists require_2fa boolean not null default false;

comment on column public.lng_staff_members.require_2fa is
  'When true, this staff member must complete an authenticator-app challenge (AAL2) on every sign-in. Enforcement is wired in chunk 3 (auth gate + /enroll-2fa + /verify-2fa). Storing the flag here lets admins set the policy per-staff before that ships.';
