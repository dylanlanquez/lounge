-- visit_shipped email: wrap the tracking number itself in the DPD URL
-- so the customer taps the number and lands on the DPD tracking page,
-- instead of seeing a bare URL printed on a separate line.
--
-- Before:
--   Tracking number: {{trackingNumber}}
--   {{trackingUrl}}
--
-- After:
--   Tracking number: [{{trackingNumber}}]({{trackingUrl}})
--
-- The markdown link gets parsed by _shared/emailRenderer.ts into a
-- normal <a> tag. trackingNumber + trackingUrl are unchanged on the
-- send-side; only the template body shifts.
--
-- Guarded: only rewrites the default body. An admin-edited template
-- (different copy) is left untouched — they can drop the new link
-- syntax in themselves from the Emails admin tab.

update public.lng_email_templates
   set body_syntax = $body$Hi {{patientFirstName}},

Great news, your order has been dispatched and is on its way to you.

**What's being sent**
{{itemsList}}

**Delivery address**
{{shippingAddress}}

**Track your parcel**
Tracking number: [{{trackingNumber}}]({{trackingUrl}})

If you have any questions, just reply to this email.

The Venneir team$body$
 where key = 'visit_shipped'
   and body_syntax not like '%[{{trackingNumber}}]%';
