-- 20260506000002_lng_visit_shipped_email_seed.sql
--
-- Seeds the visit_shipped email template into lng_email_templates.
-- Admin can edit subject / body and toggle it on/off via Admin → Emails.
-- The book-lng-shipment edge function reads this row before sending.
--
-- Rollback: delete from public.lng_email_templates where key = 'visit_shipped';

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
  'visit_shipped',
  'Your Venneir order is on its way',
  E'Hi {{patientFirstName}},\n\nGreat news — your order has been dispatched and is on its way to you.\n\n**What''s being sent**\n{{itemsList}}\n\n**Delivery address**\n{{shippingAddress}}\n\n**Track your parcel**\nTracking number: {{trackingNumber}}\n{{trackingUrl}}\n\nIf you have any questions, just reply to this email.\n\nThe Venneir team',
  'Your Venneir order is on its way',
  E'Hi {{patientFirstName}},\n\nGreat news — your order has been dispatched and is on its way to you.\n\n**What''s being sent**\n{{itemsList}}\n\n**Delivery address**\n{{shippingAddress}}\n\n**Track your parcel**\nTracking number: {{trackingNumber}}\n{{trackingUrl}}\n\nIf you have any questions, just reply to this email.\n\nThe Venneir team',
  true,
  1,
  'Sent to the patient when their completed work is dispatched via DPD. Includes tracking number and delivery address.'
)
on conflict (key) do nothing;
