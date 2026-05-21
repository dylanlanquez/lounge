-- 20260521000002_lng_email_no_show_seed.sql
--
-- Seeds the new 'appointment_no_show' email template. Sent when staff
-- mark an appointment as a no-show via the receptionist "Mark as
-- no-show" sheet (see markNoShow in src/lib/queries/visits.ts). The
-- send-appointment-confirmation edge function picks the row up via
-- the existing lng_resolve_email_template RPC, same per-service
-- override pattern as booking_confirmation / booking_cancellation.
--
-- Six rows go in:
--
--   service_type = null                       (General default)
--   service_type = 'click_in_veneers'
--   service_type = 'same_day_appliance'
--   service_type = 'denture_repair'
--   service_type = 'impression_appointment'
--   service_type = 'virtual_impression_appointment'
--
-- All seeded with enabled = false. Dylan is writing the patient-
-- facing copy after this lands; until each row is enabled, the edge
-- function returns reason: 'template_disabled' and nothing leaves
-- the building. This matches the existing pause behaviour around
-- booking_confirmation et al — staff get a clear "template paused"
-- toast rather than a silent miss.
--
-- The body/subject are short placeholders so the admin row in
-- Admin > Email templates doesn't render as an empty husk. The
-- admin overwrites them on first edit; "Reset to default" returns
-- to these placeholders, which is the intended baseline until a
-- richer canonical default ships in a later migration.
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
  -- General default. Acts as the fallback if a service_type-specific
  -- override is missing (it won't be after this migration, but the
  -- RPC still looks here last).
  (
    'appointment_no_show',
    null,
    'We missed you at your appointment',
    $body$Hi {{patientFirstName}},

We had you down for an appointment with us today but didn't get to see you.

## {{appointmentDateTime}}

**{{serviceLabel}}**

**{{locationAddress}}**

---

If something came up, just reply to this email and we'll find another time that works for you. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
    'We missed you at your appointment',
    $body$Hi {{patientFirstName}},

We had you down for an appointment with us today but didn't get to see you.

## {{appointmentDateTime}}

**{{serviceLabel}}**

**{{locationAddress}}**

---

If something came up, just reply to this email and we'll find another time that works for you. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
    1,
    false
  ),
  -- click_in_veneers
  (
    'appointment_no_show',
    'click_in_veneers',
    'We missed you at your Click-in Veneers appointment',
    $body$Hi {{patientFirstName}},

We had your click-in veneers fitting on the schedule today but didn't get to see you.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

---

If something came up, just reply to this email and we'll find another time that works. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
    'We missed you at your Click-in Veneers appointment',
    $body$Hi {{patientFirstName}},

We had your click-in veneers fitting on the schedule today but didn't get to see you.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

---

If something came up, just reply to this email and we'll find another time that works. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
    1,
    false
  ),
  -- same_day_appliance
  (
    'appointment_no_show',
    'same_day_appliance',
    'We missed you at your Same-day Appliance appointment',
    $body$Hi {{patientFirstName}},

We had your same-day appliance appointment on the schedule today but didn't get to see you.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

---

If something came up, just reply to this email and we'll find another time that works. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
    'We missed you at your Same-day Appliance appointment',
    $body$Hi {{patientFirstName}},

We had your same-day appliance appointment on the schedule today but didn't get to see you.

## {{appointmentDateTime}}

**{{sameDayServiceLabel}}**

**{{locationAddress}}**

---

If something came up, just reply to this email and we'll find another time that works. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
    1,
    false
  ),
  -- denture_repair
  (
    'appointment_no_show',
    'denture_repair',
    'We missed you at your Denture Repair appointment',
    $body$Hi {{patientFirstName}},

We had your denture repair appointment on the schedule today but didn't get to see you.

## {{appointmentDateTime}}

{{dentureRepairTable}}

**{{locationAddress}}**

---

If something came up, just reply to this email and we'll find another time that works. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
    'We missed you at your Denture Repair appointment',
    $body$Hi {{patientFirstName}},

We had your denture repair appointment on the schedule today but didn't get to see you.

## {{appointmentDateTime}}

{{dentureRepairTable}}

**{{locationAddress}}**

---

If something came up, just reply to this email and we'll find another time that works. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
    1,
    false
  ),
  -- impression_appointment (in-person)
  (
    'appointment_no_show',
    'impression_appointment',
    'We missed you at your impression appointment',
    $body$Hi {{patientFirstName}},

We had your in-person impression appointment on the schedule today but didn't get to see you.

## {{appointmentDateTime}}

**{{inPersonImpressionLabel}}**

**{{locationAddress}}**

---

If something came up, just reply to this email and we'll find another time that works. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
    'We missed you at your impression appointment',
    $body$Hi {{patientFirstName}},

We had your in-person impression appointment on the schedule today but didn't get to see you.

## {{appointmentDateTime}}

**{{inPersonImpressionLabel}}**

**{{locationAddress}}**

---

If something came up, just reply to this email and we'll find another time that works. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
    1,
    false
  ),
  -- virtual_impression_appointment
  (
    'appointment_no_show',
    'virtual_impression_appointment',
    'We missed you on your virtual impression call',
    $body$Hi {{patientFirstName}},

We had your virtual impression appointment on the schedule today but you weren't able to join us.

## {{appointmentDateTime}}

**{{serviceLabel}}**

---

If something came up, just reply to this email and we'll find another time that works. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
    'We missed you on your virtual impression call',
    $body$Hi {{patientFirstName}},

We had your virtual impression appointment on the schedule today but you weren't able to join us.

## {{appointmentDateTime}}

**{{serviceLabel}}**

---

If something came up, just reply to this email and we'll find another time that works. We typically respond within a few hours.

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
    1,
    false
  )
on conflict (key, service_type) do nothing;
