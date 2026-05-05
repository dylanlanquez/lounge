-- 20260506000004_lng_receipt_email_seed.sql
--
-- Seeds the payment_receipt email template into lng_email_templates.
-- Admin can edit subject / body and toggle it on/off via Admin → Emails.
-- The send-receipt edge function reads this row before sending; if the
-- row is missing or disabled it falls back to a hardcoded render.
--
-- Variables supported: patientFirstName, totalAmount, paidBy,
--   itemsList, receiptRef, paymentDate.
--
-- Rollback: delete from public.lng_email_templates where key = 'payment_receipt';

insert into public.lng_email_templates (
  key,
  subject,
  body_syntax,
  default_subject,
  default_body_syntax,
  enabled,
  version,
  description
)
values (
  'payment_receipt',
  'Your Venneir Lounge receipt, {{totalAmount}}, paid by {{paidBy}}',
  E'Hi {{patientFirstName}},\n\nThank you for your visit. Here is your receipt.\n\n## What you paid for\n\n{{itemsList}}\n\n---\n\n**Total:** {{totalAmount}}\nPaid by: {{paidBy}}\nReference: {{receiptRef}}\n\nIf you have any questions, just reply to this email.\n\nThe Venneir team',
  'Your Venneir Lounge receipt, {{totalAmount}}, paid by {{paidBy}}',
  E'Hi {{patientFirstName}},\n\nThank you for your visit. Here is your receipt.\n\n## What you paid for\n\n{{itemsList}}\n\n---\n\n**Total:** {{totalAmount}}\nPaid by: {{paidBy}}\nReference: {{receiptRef}}\n\nIf you have any questions, just reply to this email.\n\nThe Venneir team',
  true,
  1,
  'Sent to the patient after a payment is taken at the Lounge. Includes a line-item list, total, payment method and reference.'
)
on conflict (key) do nothing;
