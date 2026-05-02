-- 20260502000005_lng_email_templates_booking_events.sql
--
-- Booking-event email templates. Lifts the three lifecycle emails the
-- send-appointment-confirmation edge function currently hardcodes
-- (booking confirmation, reschedule, cancellation) onto the same
-- editable-template system that already powers appointment_reminder.
--
-- The schema in 20260502000002_lng_email_templates.sql is unchanged;
-- this migration only seeds three new rows + their version-1 history.
-- The edge function is updated in the same PR to load these rows
-- instead of returning hardcoded HTML, so admins can edit subject /
-- body in the admin panel and the change goes live on the next send.
--
-- ── Variable surface ──────────────────────────────────────────────
--
-- Every booking template can use the appointment variable set:
--
--   {{patientFirstName}}     "Sarah" — empty falls back to "there"
--   {{patientLastName}}      "Henderson"
--   {{serviceLabel}}         "Click-in veneers"
--   {{appointmentDateTime}}  "Sat 9 May at 11:00"
--   {{appointmentDate}}      "Sat 9 May"
--   {{appointmentDateLong}}  "Saturday 9 May 2026"
--   {{appointmentTime}}      "11:00"
--   {{locationName}}         "Venneir Lounge"
--   {{locationCity}}         "Glasgow"
--   {{locationAddress}}      "Venneir Lounge, 123 High Street, Glasgow"
--   {{locationPhone}}        "+44 141 555 0123"
--   {{appointmentRef}}       "LAP-00042"
--   {{googleCalendarUrl}}    https://calendar.google.com/...
--
-- booking_reschedule additionally supports:
--
--   {{oldAppointmentDateTime}} "Fri 8 May at 09:30"
--   {{oldAppointmentDate}}     "Fri 8 May"
--   {{oldAppointmentTime}}     "09:30"
--
-- Variables left unset at send time render literally (e.g. "{{var}}")
-- so QA can spot a missing hydration in the test inbox. The edge
-- function always provides every variable for these templates, so
-- this is a defence-in-depth path rather than a regular case.
--
-- Rollback:
--   delete from public.lng_email_template_history
--    where template_key in ('booking_confirmation', 'booking_reschedule', 'booking_cancellation');
--   delete from public.lng_email_templates
--    where key in ('booking_confirmation', 'booking_reschedule', 'booking_cancellation');

-- ── booking_confirmation ──────────────────────────────────────────

insert into public.lng_email_templates (
  key, subject, body_syntax, default_subject, default_body_syntax,
  description, enabled
) values (
  'booking_confirmation',
  $SUBJECT$You're booked in · {{appointmentDateTime}}$SUBJECT$,
$BODY$Hi {{patientFirstName}},

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
The Venneir Lounge team$BODY$,
  $SUBJECT$You're booked in · {{appointmentDateTime}}$SUBJECT$,
$BODY$Hi {{patientFirstName}},

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
The Venneir Lounge team$BODY$,
  'Sent immediately when a patient is booked into a slot. Includes a calendar invite (.ics) so the appointment lands in their calendar with one click.',
  true
)
on conflict (key) do nothing;

-- ── booking_reschedule ────────────────────────────────────────────

insert into public.lng_email_templates (
  key, subject, body_syntax, default_subject, default_body_syntax,
  description, enabled
) values (
  'booking_reschedule',
  $SUBJECT$Your appointment has moved · {{appointmentDateTime}}$SUBJECT$,
$BODY$Hi {{patientFirstName}},

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
The Venneir Lounge team$BODY$,
  $SUBJECT$Your appointment has moved · {{appointmentDateTime}}$SUBJECT$,
$BODY$Hi {{patientFirstName}},

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
The Venneir Lounge team$BODY$,
  'Sent when staff move an appointment to a new time or date. The calendar invite swaps the old slot for the new one in one go.',
  true
)
on conflict (key) do nothing;

-- ── booking_cancellation ──────────────────────────────────────────

insert into public.lng_email_templates (
  key, subject, body_syntax, default_subject, default_body_syntax,
  description, enabled
) values (
  'booking_cancellation',
  $SUBJECT$Your appointment has been cancelled · {{appointmentDateTime}}$SUBJECT$,
$BODY$Hi {{patientFirstName}},

Your appointment with us has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationAddress}}

If this cancellation was a mistake, just reply to this email and we'll get you back on the schedule. We typically respond within a few hours.

Reference: {{appointmentRef}}

The Venneir Lounge team$BODY$,
  $SUBJECT$Your appointment has been cancelled · {{appointmentDateTime}}$SUBJECT$,
$BODY$Hi {{patientFirstName}},

Your appointment with us has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationAddress}}

If this cancellation was a mistake, just reply to this email and we'll get you back on the schedule. We typically respond within a few hours.

Reference: {{appointmentRef}}

The Venneir Lounge team$BODY$,
  'Sent when an appointment is cancelled. Pairs with a CANCEL calendar file so the slot disappears from the patient''s calendar.',
  true
)
on conflict (key) do nothing;

-- Seed the version-1 history rows so the admin's "earlier versions"
-- dropdown isn't empty before the first save.
insert into public.lng_email_template_history (template_key, version, subject, body_syntax)
select key, version, subject, body_syntax
from public.lng_email_templates
where key in ('booking_confirmation', 'booking_reschedule', 'booking_cancellation')
on conflict (template_key, version) do nothing;
