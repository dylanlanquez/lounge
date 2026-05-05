-- 20260506000010_lng_email_templates_virtual_appointments.sql
--
-- Adds three dedicated email templates for virtual impression
-- appointments. The edge functions (send-appointment-confirmation,
-- send-appointment-reminders) route to these when the appointment
-- has a join_url set; in-person appointments continue to use the
-- existing standard templates.
--
-- Also reverts the lazy {{joinMeetingButton}} addition from
-- 20260506000009 — that variable is removed from the standard
-- templates and does not belong there. The standard templates are
-- restored to their pre-00009 bodies.
--
-- Virtual templates differ from the standard ones:
--   • No location address (there is no physical location to attend)
--   • Join link is the primary CTA (teal button, above Google Calendar)
--   • Copy written for a remote consultation, not an in-person visit
--   • {{manageUrl}} included so patients can self-serve reschedule
--   • "See you online" rather than "See you soon"
--   • Booking reference included for support queries
--
-- Available variables in all booking templates:
--   {{patientFirstName}}, {{patientLastName}}
--   {{serviceLabel}}, {{appointmentDateTime}}, {{appointmentDate}}
--   {{appointmentDateLong}}, {{appointmentTime}}, {{appointmentRef}}
--   {{locationName}}, {{locationCity}}, {{locationAddress}}
--   {{googleCalendarUrl}}, {{manageUrl}}
--   {{joinMeetingUrl}}   ← URL to the video session (virtual only)
--   {{publicEmail}}, {{websiteUrl}}, {{bookingLink}}
--   {{patientFacingDuration}}, {{patientFacingSchedule}}
--
-- booking_reschedule additionally:
--   {{oldAppointmentDateTime}}, {{oldAppointmentDate}}, {{oldAppointmentTime}}
--
-- Rollback:
--   delete from public.lng_email_templates
--    where key in (
--      'booking_confirmation_virtual',
--      'booking_reschedule_virtual',
--      'appointment_reminder_virtual'
--    );
--   Then restore standard template bodies from lng_email_template_history.

-- ── 1. Revert standard templates to pre-00009 bodies ─────────────

update public.lng_email_templates
set
  body_syntax = $BODY$Hi {{patientFirstName}},

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
  default_body_syntax = $BODY$Hi {{patientFirstName}},

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
  version = version + 1,
  updated_at = now()
where key = 'booking_confirmation';

update public.lng_email_templates
set
  body_syntax = $BODY$Hi {{patientFirstName}},

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
  default_body_syntax = $BODY$Hi {{patientFirstName}},

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
  version = version + 1,
  updated_at = now()
where key = 'booking_reschedule';

update public.lng_email_templates
set
  body_syntax = $BODY$Hi {{patientFirstName}},

A friendly reminder that you have an appointment with us tomorrow.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationName}}

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Lounge team$BODY$,
  default_body_syntax = $BODY$Hi {{patientFirstName}},

A friendly reminder that you have an appointment with us tomorrow.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationName}}

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Lounge team$BODY$,
  version = version + 1,
  updated_at = now()
where key = 'appointment_reminder';

-- ── 2. Virtual appointment templates ─────────────────────────────

insert into public.lng_email_templates (
  key, subject, body_syntax, default_subject, default_body_syntax,
  description, enabled
) values (
  'booking_confirmation_virtual',
  $SUBJECT$You're booked in · Virtual impression · {{appointmentDateTime}}$SUBJECT$,
$BODY$Hi {{patientFirstName}},

Your virtual impression appointment is confirmed. We will connect with you online at the time below.

## {{appointmentDateTime}}

**{{serviceLabel}}**

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

No app is needed. The link opens in your browser on any phone, tablet, or computer. Find a well-lit spot and join a couple of minutes before your start time.

[button:Add to Google Calendar|#0E1414|#FFFFFF|999|20|8]({{googleCalendarUrl}})

Apple Mail and Outlook pick up the attached calendar file automatically, so you don't need to add it twice.

---

**Need to make a change?**

[Reschedule or cancel your appointment]({{manageUrl}})

Or just reply to this email and we will find another time that works. We typically respond within a few hours.

Reference: {{appointmentRef}}

See you online,
The Venneir Lounge team$BODY$,
  $SUBJECT$You're booked in · Virtual impression · {{appointmentDateTime}}$SUBJECT$,
$BODY$Hi {{patientFirstName}},

Your virtual impression appointment is confirmed. We will connect with you online at the time below.

## {{appointmentDateTime}}

**{{serviceLabel}}**

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

No app is needed. The link opens in your browser on any phone, tablet, or computer. Find a well-lit spot and join a couple of minutes before your start time.

[button:Add to Google Calendar|#0E1414|#FFFFFF|999|20|8]({{googleCalendarUrl}})

Apple Mail and Outlook pick up the attached calendar file automatically, so you don't need to add it twice.

---

**Need to make a change?**

[Reschedule or cancel your appointment]({{manageUrl}})

Or just reply to this email and we will find another time that works. We typically respond within a few hours.

Reference: {{appointmentRef}}

See you online,
The Venneir Lounge team$BODY$,
  'Sent immediately when a patient books a virtual impression appointment. Join link is the primary CTA. No location address shown.',
  true
)
on conflict (key) do nothing;

insert into public.lng_email_templates (
  key, subject, body_syntax, default_subject, default_body_syntax,
  description, enabled
) values (
  'booking_reschedule_virtual',
  $SUBJECT$Your virtual appointment has moved · {{appointmentDateTime}}$SUBJECT$,
$BODY$Hi {{patientFirstName}},

We have moved your virtual impression appointment to a new time.

## {{appointmentDateTime}}

**{{serviceLabel}}**

*Was {{oldAppointmentDateTime}}.*

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

The link above has been updated to your new time. No app is needed — it opens in your browser.

[button:Add the new time to Google Calendar|#0E1414|#FFFFFF|999|20|8]({{googleCalendarUrl}})

Your existing calendar entry will update automatically. Apple Mail and Outlook pick up the new and old calendar files together, so the old slot disappears and the new one drops in cleanly.

---

**Doesn't this work for you?**

[Reschedule or cancel your appointment]({{manageUrl}})

Or just reply to this email and we will find another time. We typically respond within a few hours.

Reference: {{appointmentRef}}

See you online,
The Venneir Lounge team$BODY$,
  $SUBJECT$Your virtual appointment has moved · {{appointmentDateTime}}$SUBJECT$,
$BODY$Hi {{patientFirstName}},

We have moved your virtual impression appointment to a new time.

## {{appointmentDateTime}}

**{{serviceLabel}}**

*Was {{oldAppointmentDateTime}}.*

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

The link above has been updated to your new time. No app is needed — it opens in your browser.

[button:Add the new time to Google Calendar|#0E1414|#FFFFFF|999|20|8]({{googleCalendarUrl}})

Your existing calendar entry will update automatically. Apple Mail and Outlook pick up the new and old calendar files together, so the old slot disappears and the new one drops in cleanly.

---

**Doesn't this work for you?**

[Reschedule or cancel your appointment]({{manageUrl}})

Or just reply to this email and we will find another time. We typically respond within a few hours.

Reference: {{appointmentRef}}

See you online,
The Venneir Lounge team$BODY$,
  'Sent when a virtual impression appointment is moved to a new time. Updated join link shown prominently. No location address shown.',
  true
)
on conflict (key) do nothing;

insert into public.lng_email_templates (
  key, subject, body_syntax, default_subject, default_body_syntax,
  description, enabled
) values (
  'appointment_reminder_virtual',
  $SUBJECT$Reminder · Virtual impression tomorrow at {{appointmentTime}}$SUBJECT$,
$BODY$Hi {{patientFirstName}},

A friendly reminder that your virtual impression appointment is tomorrow.

## {{appointmentDateTime}}

**{{serviceLabel}}**

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

This link will be live at your appointment time. No app is needed, just a browser and a well-lit space. Join a couple of minutes early so we can start on time.

If something has come up and you can no longer make it, just reply to this email and we will find another slot that works.

[Reschedule or cancel your appointment]({{manageUrl}})

See you online,
The Venneir Lounge team$BODY$,
  $SUBJECT$Reminder · Virtual impression tomorrow at {{appointmentTime}}$SUBJECT$,
$BODY$Hi {{patientFirstName}},

A friendly reminder that your virtual impression appointment is tomorrow.

## {{appointmentDateTime}}

**{{serviceLabel}}**

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

This link will be live at your appointment time. No app is needed, just a browser and a well-lit space. Join a couple of minutes early so we can start on time.

If something has come up and you can no longer make it, just reply to this email and we will find another slot that works.

[Reschedule or cancel your appointment]({{manageUrl}})

See you online,
The Venneir Lounge team$BODY$,
  'Sent automatically 24 hours before a virtual impression appointment. Join link is the primary CTA. No location address shown.',
  true
)
on conflict (key) do nothing;

-- Seed initial history rows for the three new templates.
insert into public.lng_email_template_history (template_key, version, subject, body_syntax)
select key, version, subject, body_syntax
from public.lng_email_templates
where key in (
  'booking_confirmation_virtual',
  'booking_reschedule_virtual',
  'appointment_reminder_virtual'
)
on conflict (template_key, version) do nothing;
