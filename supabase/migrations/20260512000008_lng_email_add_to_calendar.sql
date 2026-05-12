-- Add "Add to calendar" buttons to every appointment email template.
--
-- Background: confirmations and reschedules already attach an .ics
-- file, which Apple Mail and Outlook auto-detect. Mobile mail clients
-- don't always make the attachment obvious — there's no consistent CTA
-- the patient can tap to add the booking to their iOS / Android
-- calendar. Reminders carry no .ics at all today.
--
-- The new lng-appointment-ics edge function returns a fresh .ics for
-- any appointment, gated by the row's manage_token (same token that
-- powers the {{manageUrl}} self-serve cancel/reschedule link). The
-- send functions hydrate the URL into a new {{addToCalendarUrl}}
-- variable; this migration drops a tappable button into each default
-- template body so the placeholder ships used out of the box.
--
-- We only rewrite a body when it still matches the pre-button
-- version. If an admin has edited a template (changed copy, removed
-- the .ics paragraph, etc.), we leave it alone — the new
-- {{addToCalendarUrl}} variable is in the catalogue so they can drop
-- the button in themselves.

-- booking_confirmation: in-person — replace the .ics-only paragraph
-- with a tappable button. Body is single-quoted so the embedded
-- {{vars}} survive as literal text.
update public.lng_email_templates
   set body_syntax = $body$Hi {{patientFirstName}},

Thank you for booking with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationAddress}}

[button:Add to calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})

Apple Mail and Outlook pick up the attached calendar file automatically, so you don't need to add it twice.

---

**Need to make a change?**

Just reply to this email and we'll find another time that works. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Lounge team$body$
 where key = 'booking_confirmation'
   and body_syntax not like '%addToCalendarUrl%';

-- booking_reschedule: in-person — same button, placed below the "Was"
-- line so the patient sees the new slot first, then a one-tap re-add.
update public.lng_email_templates
   set body_syntax = $body$Hi {{patientFirstName}},

We've moved your appointment to a new slot.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationAddress}}

*Was {{oldAppointmentDateTime}}.*

[button:Add the new time to your calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})

Your existing calendar entry will update automatically. Apple Mail and Outlook pick up the new and old calendar files together, so the old slot disappears and the new one drops in cleanly.

---

**Doesn't this work for you?**

Just reply to this email and we'll find another time. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Lounge team$body$
 where key = 'booking_reschedule'
   and body_syntax not like '%addToCalendarUrl%';

-- booking_confirmation_virtual: virtual — keeps the existing Join +
-- Google Calendar buttons, adds the universal one above them so iOS
-- and Android Mail users get the native add-to-calendar prompt.
update public.lng_email_templates
   set body_syntax = $body$Hi {{patientFirstName}},

Your virtual impression appointment is confirmed. We will connect with you online at the time below.

## {{appointmentDateTime}}

**{{serviceLabel}}**

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

No app is needed. The link opens in your browser on any phone, tablet, or computer. Find a well-lit spot and join a couple of minutes before your start time.

[button:Add to calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})

Apple Mail and Outlook pick up the attached calendar file automatically, so you don't need to add it twice.

---

**Need to make a change?**

[Reschedule or cancel your appointment]({{manageUrl}})

Or just reply to this email and we will find another time that works. We typically respond within a few hours.

Reference: {{appointmentRef}}

See you online,
The Venneir Lounge team$body$
 where key = 'booking_confirmation_virtual'
   and body_syntax not like '%addToCalendarUrl%';

-- booking_reschedule_virtual: virtual reschedule — universal button
-- replaces the Google-only one as the primary CTA. The Google variant
-- stays available in the variable catalogue for staff who want a
-- secondary shortcut.
update public.lng_email_templates
   set body_syntax = $body$Hi {{patientFirstName}},

We have moved your virtual impression appointment to a new time.

## {{appointmentDateTime}}

**{{serviceLabel}}**

*Was {{oldAppointmentDateTime}}.*

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

The link above has been updated to your new time. No app is needed — it opens in your browser.

[button:Add the new time to your calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})

Your existing calendar entry will update automatically. Apple Mail and Outlook pick up the new and old calendar files together, so the old slot disappears and the new one drops in cleanly.

---

**Doesn't this work for you?**

[Reschedule or cancel your appointment]({{manageUrl}})

Or just reply to this email and we will find another time that works. We typically respond within a few hours.

Reference: {{appointmentRef}}

See you online,
The Venneir Lounge team$body$
 where key = 'booking_reschedule_virtual'
   and body_syntax not like '%addToCalendarUrl%';

-- appointment_reminder (in-person, 24h before). Reminders don't ship
-- with a .ics attachment today, so the calendar button is the only
-- way for the patient to add the slot at this point. Placed near the
-- top so a phone user sees it without scrolling.
update public.lng_email_templates
   set body_syntax = $body$Hi {{patientFirstName}},

A friendly reminder that you have an appointment with us tomorrow.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationName}}

[button:Add to calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Lounge team$body$
 where key = 'appointment_reminder'
   and body_syntax not like '%addToCalendarUrl%';

-- appointment_reminder_virtual: same idea, alongside the existing Join
-- CTA. Universal calendar button goes below Join so the action they're
-- most likely to take tomorrow morning sits at the top.
update public.lng_email_templates
   set body_syntax = $body$Hi {{patientFirstName}},

A friendly reminder that your virtual impression appointment is tomorrow.

## {{appointmentDateTime}}

**{{serviceLabel}}**

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

[button:Add to calendar|#0E1414|#FFFFFF|999|20|8]({{addToCalendarUrl}})

This link will be live at your appointment time. No app is needed, just a browser and a well-lit space. Join a couple of minutes early so we can start on time.

If something has come up and you can no longer make it, just reply to this email and we will find another slot that works.

[Reschedule or cancel your appointment]({{manageUrl}})

See you online,
The Venneir Lounge team$body$
 where key = 'appointment_reminder_virtual'
   and body_syntax not like '%addToCalendarUrl%';
