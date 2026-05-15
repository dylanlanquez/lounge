-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — splice {{bookingItemsBlock}} into customised email bodies
--
-- 20260515000009 updated default_body_syntax unconditionally but only
-- touched body_syntax where it still matched the prior default. In
-- practice both Meridian and shadow already had admin-customised
-- bodies (calendar button removed, "Reference:" relabeled), so the
-- live emails never picked up the new placeholder.
--
-- This migration performs a narrow additive splice: it inserts
-- "{{bookingItemsBlock}}" into a known stable anchor point in each
-- template, only when:
--   • the variable isn't already in the body (idempotent)
--   • the anchor matches (so a heavily-rewritten template is left
--     alone for the admin to update manually)
--
-- Anchors:
--   booking_confirmation → between {{locationAddress}} and the
--     paragraph that follows. We require the existing structure
--     "{{locationAddress}}<EOL><blank><...next paragraph...>" so we
--     don't disturb a template the admin has restructured.
--   booking_reschedule  → between "*Was {{oldAppointmentDateTime}}.*"
--     and the paragraph that follows.
--
-- On a match, we snapshot the prior version to lng_email_template_history,
-- splice the variable in, and bump version. Templates that don't
-- match are left untouched and the admin can drop {{bookingItemsBlock}}
-- in via the variables picker (it's already listed there).
-- ─────────────────────────────────────────────────────────────────────────────

-- booking_confirmation: splice after {{locationAddress}}.
with target as (
  select key, version, subject, body_syntax
  from public.lng_email_templates
  where key = 'booking_confirmation'
    and position('{{bookingItemsBlock}}' in body_syntax) = 0
    and position(E'{{locationAddress}}\n\n' in body_syntax) > 0
), snapshot as (
  insert into public.lng_email_template_history (template_key, version, subject, body_syntax)
  select key, version, subject, body_syntax from target
  returning template_key
)
update public.lng_email_templates t
set
  body_syntax = replace(
    t.body_syntax,
    E'{{locationAddress}}\n\n',
    E'{{locationAddress}}\n\n{{bookingItemsBlock}}\n\n'
  ),
  version = t.version + 1,
  updated_at = now()
from target
where t.key = target.key;

-- booking_reschedule: splice after the "*Was {{oldAppointmentDateTime}}.*"
-- line — keeps the variable right under the "what's changed" header
-- the same way the confirmation puts it under the "where you're going"
-- block.
with target as (
  select key, version, subject, body_syntax
  from public.lng_email_templates
  where key = 'booking_reschedule'
    and position('{{bookingItemsBlock}}' in body_syntax) = 0
    and position(E'*Was {{oldAppointmentDateTime}}.*\n\n' in body_syntax) > 0
), snapshot as (
  insert into public.lng_email_template_history (template_key, version, subject, body_syntax)
  select key, version, subject, body_syntax from target
  returning template_key
)
update public.lng_email_templates t
set
  body_syntax = replace(
    t.body_syntax,
    E'*Was {{oldAppointmentDateTime}}.*\n\n',
    E'*Was {{oldAppointmentDateTime}}.*\n\n{{bookingItemsBlock}}\n\n'
  ),
  version = t.version + 1,
  updated_at = now()
from target
where t.key = target.key;
