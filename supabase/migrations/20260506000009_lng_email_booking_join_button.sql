-- 20260506000009_lng_email_booking_join_button.sql
--
-- Adds {{joinMeetingButton}} to the booking_confirmation,
-- booking_reschedule, and appointment_reminder email templates.
--
-- The variable is pre-rendered by the edge functions as a teal
-- [button:...] string when join_url is set on the appointment
-- (virtual impression slots), or empty string otherwise. An empty
-- value renders as a blank line, which the paragraph parser treats
-- as a paragraph break — causing a single extra &nbsp; spacer
-- before the Google Calendar button on non-virtual sends. Acceptable
-- tradeoff vs. adding conditional-block support to the renderer.
--
-- Placement: {{joinMeetingButton}} sits above the Google Calendar
-- button so the join link is the primary CTA for virtual appointments.
--
-- Rollback:
--   Restore the previous body_syntax / default_body_syntax values
--   from lng_email_template_history (version before this migration).

-- ── booking_confirmation ─────────────────────────────────────────

update public.lng_email_templates
set
  body_syntax = $BODY$Hi {{patientFirstName}},

Thank you for booking with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationAddress}}

{{joinMeetingButton}}

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

{{joinMeetingButton}}

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

-- ── booking_reschedule ───────────────────────────────────────────

update public.lng_email_templates
set
  body_syntax = $BODY$Hi {{patientFirstName}},

We've moved your appointment to a new slot.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationAddress}}

*Was {{oldAppointmentDateTime}}.*

{{joinMeetingButton}}

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

{{joinMeetingButton}}

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

-- ── appointment_reminder ─────────────────────────────────────────

update public.lng_email_templates
set
  body_syntax = $BODY$Hi {{patientFirstName}},

A friendly reminder that you have an appointment with us tomorrow.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationName}}

{{joinMeetingButton}}

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Lounge team$BODY$,
  default_body_syntax = $BODY$Hi {{patientFirstName}},

A friendly reminder that you have an appointment with us tomorrow.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationName}}

{{joinMeetingButton}}

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Lounge team$BODY$,
  version = version + 1,
  updated_at = now()
where key = 'appointment_reminder';
