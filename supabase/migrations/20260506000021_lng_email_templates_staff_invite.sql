-- 20260506000021_lng_email_templates_staff_invite.sql
--
-- Seed the staff_invite email template. Sent by the
-- lng-create-staff-account edge function when an admin adds a
-- brand-new Lounge staff member (no existing accounts row for the
-- email).
--
-- Background: Lounge transactional auth emails do NOT go through
-- Supabase's per-project auth template editor. That editor is
-- project-global on the shared Meridian Supabase project, and
-- branding it "Lounge" would also re-brand any Meridian-side auth
-- email. Instead, every Lounge auth email is rendered from
-- lng_email_templates and delivered via Resend, mirroring how
-- send-appointment-reminders / send-appointment-confirmation already
-- work. The Admin → Emails tab picks this row up automatically and
-- gives Dylan the same edit + version-history surface as every other
-- Lounge transactional template.
--
-- ── Variable surface ──────────────────────────────────────────────
--
--   {{firstName}}        recipient's first name (used in greeting)
--   {{lastName}}         recipient's last name (rarely used in copy
--                        but available for completeness)
--   {{inviteUrl}}        one-time invite link generated via
--                        auth.admin.generateLink({ type: 'invite' }).
--                        Embeds the Supabase token; expires per the
--                        project's auth settings (default 24h).
--   {{adminName}}        full display name of the admin who issued
--                        the invite. "Dylan Lane" or similar. Empty
--                        fallback "the team" so the copy still reads
--                        cleanly when the caller can't be resolved.
--   {{loungeUrl}}        canonical app URL, e.g.
--                        https://lounge.venneir.com — used for the
--                        plain-text fallback and any "find us at"
--                        copy the admin adds later.
--
-- The edge function always provides every variable, so any
-- {{placeholder}} appearing in the rendered email is a smoke signal
-- that an admin's edit introduced an unknown variable.
--
-- Rollback:
--   delete from public.lng_email_template_history
--    where template_key = 'staff_invite';
--   delete from public.lng_email_templates
--    where key = 'staff_invite';

insert into public.lng_email_templates (
  key, subject, body_syntax, default_subject, default_body_syntax,
  description, enabled
) values (
  'staff_invite',
  $SUBJECT$You've been invited to Lounge$SUBJECT$,
$BODY$Hi {{firstName}},

{{adminName}} has set up a Lounge account for you. Click below to set a password and start using your account.

[button:Accept invite|#1F4D3A|#FFFFFF|14|20|24]({{inviteUrl}})

This link is good for 24 hours. If you weren't expecting this, you can safely ignore this email.

See you soon,
The Venneir Lounge team$BODY$,
  $SUBJECT$You've been invited to Lounge$SUBJECT$,
$BODY$Hi {{firstName}},

{{adminName}} has set up a Lounge account for you. Click below to set a password and start using your account.

[button:Accept invite|#1F4D3A|#FFFFFF|14|20|24]({{inviteUrl}})

This link is good for 24 hours. If you weren't expecting this, you can safely ignore this email.

See you soon,
The Venneir Lounge team$BODY$,
  'Sent when an admin provisions a brand-new Lounge staff account from the Admin → Staff tab. Recipient clicks the button, lands on /welcome, sets a password, and is signed in.',
  true
)
on conflict (key) do nothing;

-- Seed history version 1 so the Admin → Emails "earlier versions"
-- dropdown shows a baseline immediately.
insert into public.lng_email_template_history (template_key, version, subject, body_syntax)
select key, version, subject, body_syntax
from public.lng_email_templates
where key = 'staff_invite'
on conflict (template_key, version) do nothing;
