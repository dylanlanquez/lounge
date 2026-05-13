-- 20260513000009_lng_email_remove_add_to_calendar.sql
--
-- Reverts 20260512000008_lng_email_add_to_calendar.sql.
--
-- The "Add to calendar" button shipped in that migration didn't work
-- end-to-end and was misleading patients into tapping a link that
-- failed. Removing every trace so a fresh confirmation / reschedule /
-- reminder email no longer contains the broken CTA.
--
-- ── What we strip ─────────────────────────────────────────────────
--   • The [button:Add to calendar|...]({{addToCalendarUrl}}) line
--     (and the "Add the new time to your calendar" variant used on
--     reschedule templates).
--   • The trailing " so you don't need to add it twice" clause that
--     only made sense alongside the button — the .ics attachment text
--     still stands on its own.
--
-- The .ics attachment itself is unaffected — Apple Mail and Outlook
-- still get the calendar file on confirmations and reschedules via
-- send-appointment-confirmation, which still calls buildIcs() from
-- _shared/icsBuilder.ts. Only the in-body tappable CTA is going.
--
-- ── Safety guards ─────────────────────────────────────────────────
-- Each update uses `replace()` so admins who've already customised
-- copy elsewhere in the body keep their changes. Only the exact
-- button line (and the matching trailing clause) is touched. The
-- `where ... like '%addToCalendarUrl%'` guard makes the migration a
-- no-op for templates an admin has already cleaned by hand.
--
-- We also strip the addToCalendarUrl from `default_body_syntax` so
-- the "Reset to default" button in Admin > Emails no longer brings
-- the broken button back.
--
-- Rollback: re-apply 20260512000008_lng_email_add_to_calendar.sql.

-- ── booking_confirmation ──────────────────────────────────────────
update public.lng_email_templates
   set body_syntax = replace(
       replace(
         body_syntax,
         E'\n[button:Add to calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})\n',
         E'\n'
       ),
       ', so you don''t need to add it twice',
       ''
     ),
       default_body_syntax = replace(
       replace(
         default_body_syntax,
         E'\n[button:Add to calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})\n',
         E'\n'
       ),
       ', so you don''t need to add it twice',
       ''
     )
 where key = 'booking_confirmation'
   and (body_syntax like '%addToCalendarUrl%' or default_body_syntax like '%addToCalendarUrl%');

-- ── booking_reschedule ────────────────────────────────────────────
-- Different button label on reschedules — "Add the new time to your
-- calendar" — so the strip pattern is template-specific.
update public.lng_email_templates
   set body_syntax = replace(
         body_syntax,
         E'\n[button:Add the new time to your calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})\n',
         E'\n'
       ),
       default_body_syntax = replace(
         default_body_syntax,
         E'\n[button:Add the new time to your calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})\n',
         E'\n'
       )
 where key = 'booking_reschedule'
   and (body_syntax like '%addToCalendarUrl%' or default_body_syntax like '%addToCalendarUrl%');

-- ── booking_confirmation_virtual ──────────────────────────────────
update public.lng_email_templates
   set body_syntax = replace(
       replace(
         body_syntax,
         E'\n[button:Add to calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})\n',
         E'\n'
       ),
       ', so you don''t need to add it twice',
       ''
     ),
       default_body_syntax = replace(
       replace(
         default_body_syntax,
         E'\n[button:Add to calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})\n',
         E'\n'
       ),
       ', so you don''t need to add it twice',
       ''
     )
 where key = 'booking_confirmation_virtual'
   and (body_syntax like '%addToCalendarUrl%' or default_body_syntax like '%addToCalendarUrl%');

-- ── booking_reschedule_virtual ────────────────────────────────────
update public.lng_email_templates
   set body_syntax = replace(
         body_syntax,
         E'\n[button:Add the new time to your calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})\n',
         E'\n'
       ),
       default_body_syntax = replace(
         default_body_syntax,
         E'\n[button:Add the new time to your calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})\n',
         E'\n'
       )
 where key = 'booking_reschedule_virtual'
   and (body_syntax like '%addToCalendarUrl%' or default_body_syntax like '%addToCalendarUrl%');

-- ── appointment_reminder ──────────────────────────────────────────
update public.lng_email_templates
   set body_syntax = replace(
         body_syntax,
         E'\n[button:Add to calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})\n',
         E'\n'
       ),
       default_body_syntax = replace(
         default_body_syntax,
         E'\n[button:Add to calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})\n',
         E'\n'
       )
 where key = 'appointment_reminder'
   and (body_syntax like '%addToCalendarUrl%' or default_body_syntax like '%addToCalendarUrl%');

-- ── appointment_reminder_virtual ──────────────────────────────────
update public.lng_email_templates
   set body_syntax = replace(
         body_syntax,
         E'\n[button:Add to calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})\n',
         E'\n'
       ),
       default_body_syntax = replace(
         default_body_syntax,
         E'\n[button:Add to calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})\n',
         E'\n'
       )
 where key = 'appointment_reminder_virtual'
   and (body_syntax like '%addToCalendarUrl%' or default_body_syntax like '%addToCalendarUrl%');

-- ── Safety net: any remaining stray placeholder ───────────────────
-- If an admin reorganised a template body but left a bare
-- {{addToCalendarUrl}} elsewhere (e.g. inside a custom button), nuke
-- the placeholder so it doesn't render to nothing in a way that
-- breaks surrounding punctuation. The variable is gone from the
-- catalogue (see src/lib/queries/emailTemplates.ts) so the editor UI
-- will no longer offer it.
update public.lng_email_templates
   set body_syntax = replace(body_syntax, '{{addToCalendarUrl}}', ''),
       default_body_syntax = replace(default_body_syntax, '{{addToCalendarUrl}}', '')
 where body_syntax like '%addToCalendarUrl%'
    or default_body_syntax like '%addToCalendarUrl%';
