-- 20260517000013_lng_email_templates_per_service_seed.sql
--
-- Three coordinated changes to the email-template content.
--
-- 1. Footer standardisation. Every General template ends with
--    "See you soon, / The Venneir Team" (was "The Venneir Lounge
--    team"). Applies to non-virtual + virtual variants.
--
-- 2. Service-typed overrides pre-seeded for the four customer-
--    facing services that have non-virtual flows:
--       * click_in_veneers
--       * same_day_appliance
--       * denture_repair
--       * impression_appointment (in-person)
--    Across the four main template keys:
--       * booking_confirmation
--       * booking_reschedule
--       * booking_cancellation
--       * appointment_reminder
--    = 16 override rows. Each body uses the canonical service-
--    specific placeholder so the rendered email lines up with the
--    booking type:
--       * sameDayServiceLabel  for click-in-veneers + same-day
--                              appliance (both are same-day flows)
--       * dentureRepairTable   for denture repair (per-arch table)
--       * inPersonImpressionLabel for in-person impression
--
--    Inserting these rows makes them appear as fully-customised
--    entries under each pill in Admin > Emails — no "Customise"
--    click needed before editing, so the admin can open the
--    dropdown directly.
--
-- 3. Virtual variants already exist as separate template keys
--    (booking_confirmation_virtual etc.); their General bodies
--    get the same footer treatment but no per-service overrides
--    (virtual flows always read the _virtual key).
--
-- Idempotent: INSERT ... ON CONFLICT (key, service_type) DO UPDATE.
-- Re-running this rewrites every targeted row to the canonical
-- baseline. Admins who customise their copy further THEN re-run
-- this migration would have their edits clobbered — that's the
-- intended re-seed behaviour for a defaults migration.

-- ── 1. General footer + label-placeholder standardisation ────────

-- booking_confirmation (General — universal serviceLabel)
update public.lng_email_templates
   set body_syntax = $body$Hi {{patientFirstName}},

Thank you for booking with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

---

**{{serviceLabel}}**

---

**{{locationAddress}}**

---

{{paymentStatusBlock}}

---

**Need to make a change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
       default_body_syntax = $body$Hi {{patientFirstName}},

Thank you for booking with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

---

**{{serviceLabel}}**

---

**{{locationAddress}}**

---

{{paymentStatusBlock}}

---

**Need to make a change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
       updated_at = now()
 where key = 'booking_confirmation' and service_type is null;

update public.lng_email_templates
   set body_syntax = $body$Hi {{patientFirstName}},

We've moved your appointment to a new slot.

## {{appointmentDateTime}}

---

**{{serviceLabel}}**

**{{locationAddress}}**

*Was {{oldAppointmentDateTime}}.*

---

Your existing calendar entry will update automatically. Apple Mail and Outlook pick up the new and old calendar files together, so the old slot disappears and the new one drops in cleanly.

**Doesn't this work for you?**

Just reply to this email and we'll find another time. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
       default_body_syntax = $body$Hi {{patientFirstName}},

We've moved your appointment to a new slot.

## {{appointmentDateTime}}

---

**{{serviceLabel}}**

**{{locationAddress}}**

*Was {{oldAppointmentDateTime}}.*

---

Your existing calendar entry will update automatically. Apple Mail and Outlook pick up the new and old calendar files together, so the old slot disappears and the new one drops in cleanly.

**Doesn't this work for you?**

Just reply to this email and we'll find another time. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
       updated_at = now()
 where key = 'booking_reschedule' and service_type is null;

update public.lng_email_templates
   set body_syntax = $body$Hi {{patientFirstName}},

Your appointment with us has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

**{{serviceLabel}}**

**{{locationAddress}}**

---

If this cancellation was a mistake, just reply to this email and we'll get you back on the schedule. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
       default_body_syntax = $body$Hi {{patientFirstName}},

Your appointment with us has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

**{{serviceLabel}}**

**{{locationAddress}}**

---

If this cancellation was a mistake, just reply to this email and we'll get you back on the schedule. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
       updated_at = now()
 where key = 'booking_cancellation' and service_type is null;

update public.lng_email_templates
   set body_syntax = $body$Hi {{patientFirstName}},

A friendly reminder that you have an appointment with us tomorrow.

## {{appointmentDateTime}}

**{{serviceLabel}}**

**{{locationAddress}}**

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Team$body$,
       default_body_syntax = $body$Hi {{patientFirstName}},

A friendly reminder that you have an appointment with us tomorrow.

## {{appointmentDateTime}}

**{{serviceLabel}}**

**{{locationAddress}}**

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Team$body$,
       updated_at = now()
 where key = 'appointment_reminder' and service_type is null;

-- Virtual-variant footer fix.
update public.lng_email_templates
   set body_syntax = regexp_replace(body_syntax,
                                    'See you online,\s*\nThe Venneir Lounge team\s*$',
                                    E'See you soon,\nThe Venneir Team',
                                    'i'),
       default_body_syntax = regexp_replace(default_body_syntax,
                                            'See you online,\s*\nThe Venneir Lounge team\s*$',
                                            E'See you soon,\nThe Venneir Team',
                                            'i'),
       updated_at = now()
 where service_type is null
   and key in ('booking_confirmation_virtual', 'booking_reschedule_virtual', 'appointment_reminder_virtual');

-- ── 2. Service-typed overrides ────────────────────────────────────
--
-- Helper that copies the General default_subject + default_body
-- onto a service-typed row's own default_* columns. Allows "Reset"
-- on the override to delete the override (re-inherits General),
-- per the existing semantics in src/lib/queries/emailTemplates.ts.

-- click_in_veneers + same_day_appliance both use sameDayServiceLabel.
-- Two services, four keys = 8 rows.

-- click_in_veneers
insert into public.lng_email_templates (key, service_type, subject, body_syntax, default_subject, default_body_syntax, version, enabled)
values
  ('booking_confirmation', 'click_in_veneers',
   'Your Click-in Veneers appointment is confirmed',
   $body$Hi {{patientFirstName}},

Thank you for booking your click-in veneers fitting with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

---

**{{sameDayServiceLabel}}**

---

**{{locationAddress}}**

---

{{paymentStatusBlock}}

---

**Need to make a change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   'Your Click-in Veneers appointment is confirmed',
   $body$Hi {{patientFirstName}},

Thank you for booking your click-in veneers fitting with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

---

**{{sameDayServiceLabel}}**

---

**{{locationAddress}}**

---

{{paymentStatusBlock}}

---

**Need to make a change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   1, true),
  ('booking_reschedule', 'click_in_veneers',
   'Your Click-in Veneers appointment has moved',
   $body$Hi {{patientFirstName}},

We've moved your click-in veneers fitting to a new slot.

## {{appointmentDateTime}}

---

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

*Was {{oldAppointmentDateTime}}.*

---

Your existing calendar entry will update automatically.

**Doesn't this work for you?**

Just reply to this email and we'll find another time. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   'Your Click-in Veneers appointment has moved',
   $body$Hi {{patientFirstName}},

We've moved your click-in veneers fitting to a new slot.

## {{appointmentDateTime}}

---

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

*Was {{oldAppointmentDateTime}}.*

---

Your existing calendar entry will update automatically.

**Doesn't this work for you?**

Just reply to this email and we'll find another time. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   1, true),
  ('booking_cancellation', 'click_in_veneers',
   'Your Click-in Veneers appointment is cancelled',
   $body$Hi {{patientFirstName}},

Your click-in veneers appointment has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

---

If this cancellation was a mistake, just reply to this email and we'll get you back on the schedule. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   'Your Click-in Veneers appointment is cancelled',
   $body$Hi {{patientFirstName}},

Your click-in veneers appointment has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

---

If this cancellation was a mistake, just reply to this email and we'll get you back on the schedule. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   1, true),
  ('appointment_reminder', 'click_in_veneers',
   'Reminder: your Click-in Veneers appointment is tomorrow',
   $body$Hi {{patientFirstName}},

A friendly reminder that your click-in veneers appointment is tomorrow.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Team$body$,
   'Reminder: your Click-in Veneers appointment is tomorrow',
   $body$Hi {{patientFirstName}},

A friendly reminder that your click-in veneers appointment is tomorrow.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Team$body$,
   1, true)
on conflict (key, service_type) do update
   set subject = excluded.subject,
       body_syntax = excluded.body_syntax,
       default_subject = excluded.default_subject,
       default_body_syntax = excluded.default_body_syntax,
       updated_at = now();

-- same_day_appliance
insert into public.lng_email_templates (key, service_type, subject, body_syntax, default_subject, default_body_syntax, version, enabled)
values
  ('booking_confirmation', 'same_day_appliance',
   'Your same-day appointment is confirmed',
   $body$Hi {{patientFirstName}},

Thank you for booking your same-day appointment with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

---

**{{sameDayServiceLabel}}**

---

**{{locationAddress}}**

---

{{paymentStatusBlock}}

---

**Need to make a change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   'Your same-day appointment is confirmed',
   $body$Hi {{patientFirstName}},

Thank you for booking your same-day appointment with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

---

**{{sameDayServiceLabel}}**

---

**{{locationAddress}}**

---

{{paymentStatusBlock}}

---

**Need to make a change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   1, true),
  ('booking_reschedule', 'same_day_appliance',
   'Your same-day appointment has moved',
   $body$Hi {{patientFirstName}},

We've moved your same-day appointment to a new slot.

## {{appointmentDateTime}}

---

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

*Was {{oldAppointmentDateTime}}.*

---

Your existing calendar entry will update automatically.

**Doesn't this work for you?**

Just reply to this email and we'll find another time. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   'Your same-day appointment has moved',
   $body$Hi {{patientFirstName}},

We've moved your same-day appointment to a new slot.

## {{appointmentDateTime}}

---

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

*Was {{oldAppointmentDateTime}}.*

---

Your existing calendar entry will update automatically.

**Doesn't this work for you?**

Just reply to this email and we'll find another time. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   1, true),
  ('booking_cancellation', 'same_day_appliance',
   'Your same-day appointment is cancelled',
   $body$Hi {{patientFirstName}},

Your same-day appointment has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

---

If this cancellation was a mistake, just reply to this email and we'll get you back on the schedule. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   'Your same-day appointment is cancelled',
   $body$Hi {{patientFirstName}},

Your same-day appointment has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

---

If this cancellation was a mistake, just reply to this email and we'll get you back on the schedule. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   1, true),
  ('appointment_reminder', 'same_day_appliance',
   'Reminder: your same-day appointment is tomorrow',
   $body$Hi {{patientFirstName}},

A friendly reminder that your same-day appointment is tomorrow.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Team$body$,
   'Reminder: your same-day appointment is tomorrow',
   $body$Hi {{patientFirstName}},

A friendly reminder that your same-day appointment is tomorrow.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Team$body$,
   1, true)
on conflict (key, service_type) do update
   set subject = excluded.subject,
       body_syntax = excluded.body_syntax,
       default_subject = excluded.default_subject,
       default_body_syntax = excluded.default_body_syntax,
       updated_at = now();

-- denture_repair (uses dentureRepairTable instead of a label)
insert into public.lng_email_templates (key, service_type, subject, body_syntax, default_subject, default_body_syntax, version, enabled)
values
  ('booking_confirmation', 'denture_repair',
   'Your denture repair appointment is confirmed',
   $body$Hi {{patientFirstName}},

Thank you for booking your denture repair with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

---

{{dentureRepairTable}}

---

**{{locationAddress}}**

---

{{paymentStatusBlock}}

---

**Need to make a change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   'Your denture repair appointment is confirmed',
   $body$Hi {{patientFirstName}},

Thank you for booking your denture repair with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

---

{{dentureRepairTable}}

---

**{{locationAddress}}**

---

{{paymentStatusBlock}}

---

**Need to make a change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   1, true),
  ('booking_reschedule', 'denture_repair',
   'Your denture repair appointment has moved',
   $body$Hi {{patientFirstName}},

We've moved your denture repair appointment to a new slot.

## {{appointmentDateTime}}

---

{{dentureRepairTable}}

**{{locationAddress}}**

*Was {{oldAppointmentDateTime}}.*

---

Your existing calendar entry will update automatically.

**Doesn't this work for you?**

Just reply to this email and we'll find another time. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   'Your denture repair appointment has moved',
   $body$Hi {{patientFirstName}},

We've moved your denture repair appointment to a new slot.

## {{appointmentDateTime}}

---

{{dentureRepairTable}}

**{{locationAddress}}**

*Was {{oldAppointmentDateTime}}.*

---

Your existing calendar entry will update automatically.

**Doesn't this work for you?**

Just reply to this email and we'll find another time. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   1, true),
  ('booking_cancellation', 'denture_repair',
   'Your denture repair appointment is cancelled',
   $body$Hi {{patientFirstName}},

Your denture repair appointment has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

{{dentureRepairTable}}

**{{locationAddress}}**

---

If this cancellation was a mistake, just reply to this email and we'll get you back on the schedule. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   'Your denture repair appointment is cancelled',
   $body$Hi {{patientFirstName}},

Your denture repair appointment has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

{{dentureRepairTable}}

**{{locationAddress}}**

---

If this cancellation was a mistake, just reply to this email and we'll get you back on the schedule. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   1, true),
  ('appointment_reminder', 'denture_repair',
   'Reminder: your denture repair appointment is tomorrow',
   $body$Hi {{patientFirstName}},

A friendly reminder that your denture repair appointment is tomorrow.

## {{appointmentDateTime}}

{{dentureRepairTable}}

**{{locationAddress}}**

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Team$body$,
   'Reminder: your denture repair appointment is tomorrow',
   $body$Hi {{patientFirstName}},

A friendly reminder that your denture repair appointment is tomorrow.

## {{appointmentDateTime}}

{{dentureRepairTable}}

**{{locationAddress}}**

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Team$body$,
   1, true)
on conflict (key, service_type) do update
   set subject = excluded.subject,
       body_syntax = excluded.body_syntax,
       default_subject = excluded.default_subject,
       default_body_syntax = excluded.default_body_syntax,
       updated_at = now();

-- impression_appointment (in-person)
insert into public.lng_email_templates (key, service_type, subject, body_syntax, default_subject, default_body_syntax, version, enabled)
values
  ('booking_confirmation', 'impression_appointment',
   'Your in-person impression appointment is confirmed',
   $body$Hi {{patientFirstName}},

Thank you for booking your impression appointment with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

---

**{{inPersonImpressionLabel}}**

---

**{{locationAddress}}**

---

{{paymentStatusBlock}}

---

**Need to make a change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   'Your in-person impression appointment is confirmed',
   $body$Hi {{patientFirstName}},

Thank you for booking your impression appointment with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

---

**{{inPersonImpressionLabel}}**

---

**{{locationAddress}}**

---

{{paymentStatusBlock}}

---

**Need to make a change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   1, true),
  ('booking_reschedule', 'impression_appointment',
   'Your impression appointment has moved',
   $body$Hi {{patientFirstName}},

We've moved your impression appointment to a new slot.

## {{appointmentDateTime}}

---

**{{inPersonImpressionLabel}}**

**{{locationAddress}}**

*Was {{oldAppointmentDateTime}}.*

---

Your existing calendar entry will update automatically.

**Doesn't this work for you?**

Just reply to this email and we'll find another time. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   'Your impression appointment has moved',
   $body$Hi {{patientFirstName}},

We've moved your impression appointment to a new slot.

## {{appointmentDateTime}}

---

**{{inPersonImpressionLabel}}**

**{{locationAddress}}**

*Was {{oldAppointmentDateTime}}.*

---

Your existing calendar entry will update automatically.

**Doesn't this work for you?**

Just reply to this email and we'll find another time. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   1, true),
  ('booking_cancellation', 'impression_appointment',
   'Your impression appointment is cancelled',
   $body$Hi {{patientFirstName}},

Your impression appointment has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

**{{inPersonImpressionLabel}}**

**{{locationAddress}}**

---

If this cancellation was a mistake, just reply to this email and we'll get you back on the schedule. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   'Your impression appointment is cancelled',
   $body$Hi {{patientFirstName}},

Your impression appointment has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

**{{inPersonImpressionLabel}}**

**{{locationAddress}}**

---

If this cancellation was a mistake, just reply to this email and we'll get you back on the schedule. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
   1, true),
  ('appointment_reminder', 'impression_appointment',
   'Reminder: your impression appointment is tomorrow',
   $body$Hi {{patientFirstName}},

A friendly reminder that your impression appointment is tomorrow.

## {{appointmentDateTime}}

**{{inPersonImpressionLabel}}**

**{{locationAddress}}**

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Team$body$,
   'Reminder: your impression appointment is tomorrow',
   $body$Hi {{patientFirstName}},

A friendly reminder that your impression appointment is tomorrow.

## {{appointmentDateTime}}

**{{inPersonImpressionLabel}}**

**{{locationAddress}}**

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Team$body$,
   1, true)
on conflict (key, service_type) do update
   set subject = excluded.subject,
       body_syntax = excluded.body_syntax,
       default_subject = excluded.default_subject,
       default_body_syntax = excluded.default_body_syntax,
       updated_at = now();
