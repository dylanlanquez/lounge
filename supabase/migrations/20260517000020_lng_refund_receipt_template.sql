-- 20260517000020_lng_refund_receipt_template.sql
--
-- Seeds the refund_receipt email template. Sent to the patient
-- after a refund row settles (synchronously for cash, when
-- Stripe confirms for card / deposit).
--
-- Variables supported:
--   patientFirstName   First name of the patient (or 'there' fallback).
--   refundAmount       "£60.00" formatted total of THIS refund.
--   refundMethod       "Card", "Cash", "Online card", etc.
--   refundDate         "Sat, 17 May" local-clock label.
--   reasonNote         Free-text the staff member wrote on the
--                      refund row. Already trimmed.
--   reference          The lng_payment_refunds.id short form, for
--                      patients who phone us about a missing refund.

insert into public.lng_email_templates (
  key,
  service_type,
  subject,
  body_syntax,
  default_subject,
  default_body_syntax,
  enabled,
  version,
  description
)
values (
  'refund_receipt',
  null,
  'Your refund · {{refundAmount}}',
  E'Hi {{patientFirstName}},\n\nWe''ve issued a refund of **{{refundAmount}}** back to you.\n\n## What you''ll see\n\n- **Amount:** {{refundAmount}}\n- **Method:** {{refundMethod}}\n- **Date:** {{refundDate}}\n- **Reason:** {{reasonNote}}\n- **Reference:** {{reference}}\n\nCard refunds usually appear within 5 to 10 working days, depending on your bank.\n\nIf anything looks wrong, just reply to this email.\n\nThe Venneir team',
  'Your refund · {{refundAmount}}',
  E'Hi {{patientFirstName}},\n\nWe''ve issued a refund of **{{refundAmount}}** back to you.\n\n## What you''ll see\n\n- **Amount:** {{refundAmount}}\n- **Method:** {{refundMethod}}\n- **Date:** {{refundDate}}\n- **Reason:** {{reasonNote}}\n- **Reference:** {{reference}}\n\nCard refunds usually appear within 5 to 10 working days, depending on your bank.\n\nIf anything looks wrong, just reply to this email.\n\nThe Venneir team',
  true,
  1,
  'Sent to the patient when a refund settles. Covers cash, card-at-till, and widget-deposit refunds with one template.'
)
on conflict (key, service_type) do nothing;
