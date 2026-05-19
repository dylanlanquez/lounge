-- 20260519000013_lng_sms_payment_receipt_template.sql
--
-- Seed a dedicated payment_receipt SMS template. send-receipt
-- has been deriving the SMS body from the email template's text
-- form, which makes a 280-char-plus paragraph land on the
-- patient's lock screen — exactly the kind of receipt content
-- that should be terse for SMS. Admins also couldn't edit the SMS
-- copy without affecting the email, because the two channels
-- shared one body.
--
-- This adds a General-only row to lng_sms_templates so the SMS
-- channel renders its own short body, and so Admin → Emails & SMS
-- can expose the row for editing once we add payment_receipt to
-- SMS_TEMPLATE_KEYS in the UI.
--
-- Rollback: delete from lng_sms_templates where key='payment_receipt';

insert into public.lng_sms_templates (key, service_type, body, default_body, description)
values (
  'payment_receipt',
  null,
  'Hi {{patientFirstName}}, thanks for stopping by {{clinicName}}. Your receipt: {{totalAmount}} paid by {{paidBy}}. Reference {{receiptRef}}.',
  'Hi {{patientFirstName}}, thanks for stopping by {{clinicName}}. Your receipt: {{totalAmount}} paid by {{paidBy}}. Reference {{receiptRef}}.',
  'Sent to the patient when they pick SMS as the receipt channel after paying at the till. Short by design, GSM-7 in one segment so a single £-cost paid SMS covers the full receipt. Admin-editable from the General pill in Admin → SMS.'
)
on conflict (key, service_type) do nothing;
