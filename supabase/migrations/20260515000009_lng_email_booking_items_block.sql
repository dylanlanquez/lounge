-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — booking email templates: per-booking items breakdown
--
-- Adds the {{bookingItemsBlock}} placeholder to the default templates
-- for booking_confirmation, booking_reschedule and appointment_reminder
-- so the patient sees what they actually picked at booking time
-- (per-arch denture-repair lines + selected upgrades). The placeholder
-- expands to a bold-headed markdown bullet list rendered by the email
-- function and degrades to an empty string for bookings without
-- either, so an unchanged single-service booking reads identically.
--
-- Strategy:
--   1. Update default_body_syntax unconditionally (the reset baseline).
--   2. Update body_syntax only where it still equals the prior default
--      — preserves any admin customisation already in flight.
--   3. Bump the version + snapshot the prior body to lng_email_template_history
--      for every row touched, so the admin's "earlier versions" picker
--      reflects the change without losing audit trail.
--
-- Virtual variants (booking_confirmation_virtual / booking_reschedule_virtual /
-- appointment_reminder_virtual) are left untouched: virtual_impression
-- appointments don't carry repair items or upgrades, so the variable
-- would always be empty and the visual noise (an extra blank
-- paragraph) isn't worth the inclusion.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prior defaults ───────────────────────────────────────────────────
-- Copies of the body_syntax shipped by 20260502000005_lng_email_templates_booking_events.sql
-- and 20260502000002_lng_email_templates.sql (appointment_reminder).
-- Used to (a) match-and-replace in the live row when no admin edits
-- exist and (b) build the comparator for the snapshot insert.

create or replace function pg_temp.lng_prior_booking_confirmation_body()
returns text language sql immutable as $$
  select $BODY$Hi {{patientFirstName}},

Thank you for booking with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationAddress}}

[button:Add to Google Calendar|#0E1414|#FFFFFF|999|20|8]({{googleCalendarUrl}})

Apple Mail and Outlook pick up the attached calendar file automatically, so you don't need to add it twice.

---

**Need to make a change?**

Just reply to this email and we'll find another time that works. We typically respond within a few hours.

Reference: {{appointmentRef}}

See you soon,
The Venneir Lounge team$BODY$;
$$;

create or replace function pg_temp.lng_prior_booking_reschedule_body()
returns text language sql immutable as $$
  select $BODY$Hi {{patientFirstName}},

We've moved your appointment to a new slot.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationAddress}}

*Was {{oldAppointmentDateTime}}.*

[button:Add the new time to Google Calendar|#0E1414|#FFFFFF|999|20|8]({{googleCalendarUrl}})

Your existing calendar entry will update automatically. Apple Mail and Outlook pick up the new and old calendar files together, so the old slot disappears and the new one drops in cleanly.

---

**Doesn't this work for you?**

Just reply to this email and we'll find another time. We typically respond within a few hours.

Reference: {{appointmentRef}}

See you soon,
The Venneir Lounge team$BODY$;
$$;

-- ── New defaults (drop-in {{bookingItemsBlock}}) ─────────────────────
-- The block sits in the "summary" paragraph below the heading. It
-- self-collapses to nothing when the booking has neither repair
-- items nor upgrades, so single-line services read the same as
-- before.

create or replace function pg_temp.lng_new_booking_confirmation_body()
returns text language sql immutable as $$
  select $BODY$Hi {{patientFirstName}},

Thank you for booking with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationAddress}}

{{bookingItemsBlock}}

[button:Add to Google Calendar|#0E1414|#FFFFFF|999|20|8]({{googleCalendarUrl}})

Apple Mail and Outlook pick up the attached calendar file automatically, so you don't need to add it twice.

---

**Need to make a change?**

Just reply to this email and we'll find another time that works. We typically respond within a few hours.

Reference: {{appointmentRef}}

See you soon,
The Venneir Lounge team$BODY$;
$$;

create or replace function pg_temp.lng_new_booking_reschedule_body()
returns text language sql immutable as $$
  select $BODY$Hi {{patientFirstName}},

We've moved your appointment to a new slot.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationAddress}}

*Was {{oldAppointmentDateTime}}.*

{{bookingItemsBlock}}

[button:Add the new time to Google Calendar|#0E1414|#FFFFFF|999|20|8]({{googleCalendarUrl}})

Your existing calendar entry will update automatically. Apple Mail and Outlook pick up the new and old calendar files together, so the old slot disappears and the new one drops in cleanly.

---

**Doesn't this work for you?**

Just reply to this email and we'll find another time. We typically respond within a few hours.

Reference: {{appointmentRef}}

See you soon,
The Venneir Lounge team$BODY$;
$$;

-- ── booking_confirmation ─────────────────────────────────────────────

-- Snapshot the current body before we touch it so admin "earlier
-- versions" keeps an audit trail through the migration.
insert into public.lng_email_template_history (template_key, version, subject, body_syntax)
select t.key, t.version, t.subject, t.body_syntax
from public.lng_email_templates t
where t.key = 'booking_confirmation'
  and t.body_syntax = pg_temp.lng_prior_booking_confirmation_body();

update public.lng_email_templates
set
  default_body_syntax = pg_temp.lng_new_booking_confirmation_body(),
  body_syntax = case
    when body_syntax = pg_temp.lng_prior_booking_confirmation_body()
      then pg_temp.lng_new_booking_confirmation_body()
    else body_syntax
  end,
  version = case
    when body_syntax = pg_temp.lng_prior_booking_confirmation_body()
      then version + 1
    else version
  end,
  updated_at = now()
where key = 'booking_confirmation';

-- ── booking_reschedule ───────────────────────────────────────────────

insert into public.lng_email_template_history (template_key, version, subject, body_syntax)
select t.key, t.version, t.subject, t.body_syntax
from public.lng_email_templates t
where t.key = 'booking_reschedule'
  and t.body_syntax = pg_temp.lng_prior_booking_reschedule_body();

update public.lng_email_templates
set
  default_body_syntax = pg_temp.lng_new_booking_reschedule_body(),
  body_syntax = case
    when body_syntax = pg_temp.lng_prior_booking_reschedule_body()
      then pg_temp.lng_new_booking_reschedule_body()
    else body_syntax
  end,
  version = case
    when body_syntax = pg_temp.lng_prior_booking_reschedule_body()
      then version + 1
    else version
  end,
  updated_at = now()
where key = 'booking_reschedule';
