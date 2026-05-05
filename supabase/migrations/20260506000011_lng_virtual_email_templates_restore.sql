-- 20260506000011_lng_virtual_email_templates_restore.sql
--
-- One-time repair: the three virtual appointment email templates were
-- corrupted when the old SnippetEditor code (before the syntaxToHtml
-- line-level button fix) garbled the button syntax into raw HTML and
-- {color:...}{w:...} wrappers, which were then saved as version 2.
--
-- This migration:
--   1. Snapshots the corrupted version 2 rows to history (audit trail).
--   2. Resets body_syntax to default_body_syntax (the clean seed from
--      20260506000010, which was never overwritten).
--   3. Bumps version to the next integer.
--
-- Safe in a fresh environment: if the templates are still at version 1
-- (clean, from 20260506000010) the WHERE clause is a no-op because
-- body_syntax would equal default_body_syntax.
--
-- Rollback:
--   Restore the corrupted content from lng_email_template_history at
--   the version snapshotted here (one version below the post-migration
--   version). The editor code fix (e660427) prevents re-corruption.

-- ── 1. Snapshot corrupted rows to history ────────────────────────
insert into public.lng_email_template_history (template_key, version, subject, body_syntax)
select key, version, subject, body_syntax
from public.lng_email_templates
where key in (
  'appointment_reminder_virtual',
  'booking_confirmation_virtual',
  'booking_reschedule_virtual'
)
  and body_syntax != default_body_syntax
on conflict (template_key, version) do nothing;

-- ── 2. Reset body_syntax and bump version ────────────────────────
update public.lng_email_templates
set
  body_syntax  = default_body_syntax,
  version      = version + 1,
  updated_at   = now()
where key in (
  'appointment_reminder_virtual',
  'booking_confirmation_virtual',
  'booking_reschedule_virtual'
)
  and body_syntax != default_body_syntax;
