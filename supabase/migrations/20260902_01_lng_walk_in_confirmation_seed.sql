-- 20260902_01_lng_walk_in_confirmation_seed.sql
--
-- Seeds the new 'walk_in_confirmation' email template. Sent when a
-- receptionist takes a walk-in through the arrival flow (see
-- createWalkInVisit in src/lib/queries/visits.ts), fired against the
-- walk-in marker appointment with intent: 'walk_in'.
--
-- Why this template exists: every other arrival path already emails
-- the patient (booking_confirmation, booking_reschedule,
-- booking_cancellation, appointment_no_show). A walk-in was the one
-- route that left with nothing in writing, so the patient had no
-- record of what they came in for or what their reference was.
--
-- No .ics is attached on this path. The patient is in the building;
-- a calendar REQUEST for a slot they are already sitting in would be
-- noise. The edge function skips the attachment for kind 'walk_in'.
--
-- Six rows go in, matching the per-service pattern the
-- lng_resolve_email_template RPC expects:
--
--   service_type = null                       (General default)
--   service_type = 'click_in_veneers'
--   service_type = 'same_day_appliance'
--   service_type = 'denture_repair'
--   service_type = 'impression_appointment'
--   service_type = 'virtual_impression_appointment'
--
-- Seeded ENABLED, unlike the appointment_no_show seed. That is a
-- deliberate difference: the no-show copy needed writing before it
-- could go out, whereas this copy is a plain acknowledgement of a
-- visit that has already happened and is safe to send as written.
-- The consequence is that walk-in emails start going to real
-- patients the moment this lands on Meridian. To stage it more
-- slowly, flip enabled to false here and switch the rows on from
-- Admin > Email templates once the copy has been reviewed.
--
-- {{appointmentDateTime}} renders the marker's start_at, which
-- createWalkInVisit stamps as the moment of arrival, so it reads as
-- today's date and the time the patient walked in.
--
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING. Re-running leaves
-- any customised rows untouched.

insert into public.lng_email_templates (
  key,
  service_type,
  subject,
  body_syntax,
  default_subject,
  default_body_syntax,
  version,
  enabled
)
values
  -- General default. The fallback when no service_type override
  -- matches, and the row that fires for a walk-in staged without a
  -- service axis picked.
  (
    'walk_in_confirmation',
    null,
    'Thanks for coming in today',
    $body$Hi {{patientFirstName}},

Thanks for coming in to see us today. Here is a record of your visit for your files.

## {{appointmentDateTime}}

**{{serviceLabel}}**

**{{locationAddress}}**

---

If you have a question about anything we discussed, just reply to this email. We typically respond within a few hours.

Reference: {{appointmentRef}}

The Venneir Team$body$,
    'Thanks for coming in today',
    $body$Hi {{patientFirstName}},

Thanks for coming in to see us today. Here is a record of your visit for your files.

## {{appointmentDateTime}}

**{{serviceLabel}}**

**{{locationAddress}}**

---

If you have a question about anything we discussed, just reply to this email. We typically respond within a few hours.

Reference: {{appointmentRef}}

The Venneir Team$body$,
    1,
    true
  ),
  -- click_in_veneers
  (
    'walk_in_confirmation',
    'click_in_veneers',
    'Thanks for coming in for your Click-in Veneers',
    $body$Hi {{patientFirstName}},

Thanks for coming in to see us about your click-in veneers today. Here is a record of your visit for your files.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

---

If you have a question about your veneers or anything we discussed, just reply to this email. We typically respond within a few hours.

Reference: {{appointmentRef}}

The Venneir Team$body$,
    'Thanks for coming in for your Click-in Veneers',
    $body$Hi {{patientFirstName}},

Thanks for coming in to see us about your click-in veneers today. Here is a record of your visit for your files.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

---

If you have a question about your veneers or anything we discussed, just reply to this email. We typically respond within a few hours.

Reference: {{appointmentRef}}

The Venneir Team$body$,
    1,
    true
  ),
  -- same_day_appliance
  (
    'walk_in_confirmation',
    'same_day_appliance',
    'Thanks for coming in today',
    $body$Hi {{patientFirstName}},

Thanks for coming in to see us about your appliance today. Here is a record of your visit for your files.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

---

If you have a question about your appliance or anything we discussed, just reply to this email. We typically respond within a few hours.

Reference: {{appointmentRef}}

The Venneir Team$body$,
    'Thanks for coming in today',
    $body$Hi {{patientFirstName}},

Thanks for coming in to see us about your appliance today. Here is a record of your visit for your files.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

---

If you have a question about your appliance or anything we discussed, just reply to this email. We typically respond within a few hours.

Reference: {{appointmentRef}}

The Venneir Team$body$,
    1,
    true
  ),
  -- denture_repair. Uses the repair table so the patient has the
  -- specifics of what was brought in, same block the booking
  -- confirmation for this service renders.
  (
    'walk_in_confirmation',
    'denture_repair',
    'Thanks for bringing your denture in today',
    $body$Hi {{patientFirstName}},

Thanks for bringing your denture in to us today. Here is a record of your visit for your files.

## {{appointmentDateTime}}

{{dentureRepairTable}}

**{{locationAddress}}**

---

If you have a question about your repair or anything we discussed, just reply to this email. We typically respond within a few hours.

Reference: {{appointmentRef}}

The Venneir Team$body$,
    'Thanks for bringing your denture in today',
    $body$Hi {{patientFirstName}},

Thanks for bringing your denture in to us today. Here is a record of your visit for your files.

## {{appointmentDateTime}}

{{dentureRepairTable}}

**{{locationAddress}}**

---

If you have a question about your repair or anything we discussed, just reply to this email. We typically respond within a few hours.

Reference: {{appointmentRef}}

The Venneir Team$body$,
    1,
    true
  ),
  -- impression_appointment (in-person)
  (
    'walk_in_confirmation',
    'impression_appointment',
    'Thanks for coming in for your impressions',
    $body$Hi {{patientFirstName}},

Thanks for coming in to have your impressions taken today. Here is a record of your visit for your files.

## {{appointmentDateTime}}

**{{inPersonImpressionLabel}}**

**{{locationAddress}}**

---

We will be in touch as your case progresses. If you have a question in the meantime, just reply to this email. We typically respond within a few hours.

Reference: {{appointmentRef}}

The Venneir Team$body$,
    'Thanks for coming in for your impressions',
    $body$Hi {{patientFirstName}},

Thanks for coming in to have your impressions taken today. Here is a record of your visit for your files.

## {{appointmentDateTime}}

**{{inPersonImpressionLabel}}**

**{{locationAddress}}**

---

We will be in touch as your case progresses. If you have a question in the meantime, just reply to this email. We typically respond within a few hours.

Reference: {{appointmentRef}}

The Venneir Team$body$,
    1,
    true
  ),
  -- virtual_impression_appointment. Rare as a walk-in (the service
  -- is remote by definition) but seeded for completeness so the RPC
  -- never falls through to the General default with virtual copy
  -- missing. No location block: the row exists for the case where
  -- staff stage a virtual service against an in-person arrival.
  (
    'walk_in_confirmation',
    'virtual_impression_appointment',
    'Thanks for coming in today',
    $body$Hi {{patientFirstName}},

Thanks for coming in to see us today. Here is a record of your visit for your files.

## {{appointmentDateTime}}

**{{serviceLabel}}**

---

We will be in touch as your case progresses. If you have a question in the meantime, just reply to this email. We typically respond within a few hours.

Reference: {{appointmentRef}}

The Venneir Team$body$,
    'Thanks for coming in today',
    $body$Hi {{patientFirstName}},

Thanks for coming in to see us today. Here is a record of your visit for your files.

## {{appointmentDateTime}}

**{{serviceLabel}}**

---

We will be in touch as your case progresses. If you have a question in the meantime, just reply to this email. We typically respond within a few hours.

Reference: {{appointmentRef}}

The Venneir Team$body$,
    1,
    true
  )
on conflict (key, service_type) do nothing;
