-- 20260611000002_lng_returns_copy_fix.sql
--
-- Correct + final returns copy. Two problems this fixes:
--
--  1. A virtual_impression_appointment-specific row exists for both the
--     email and SMS 'returns' templates, and lng_resolve_*_template
--     prefers it over the General (service_type NULL) row. The previous
--     copy migration (20260611000001) only touched the NULL row, so the
--     send-returns-info function kept resolving the OLD "print the
--     prepaid DPD return label" wording. We update EVERY 'returns' row
--     (key = 'returns', any service_type) so both stay in lockstep.
--
--  2. Copy correction: customers do NOT need to print anything. They
--     generate a QR code and can simply SHOW it at the drop-off point
--     (or print it if they prefer). The old "print the label, attach it
--     to your parcel" line was wrong for how DPD's QR returns work.
--
-- SMS now uses line breaks between sections so it reads as spaced
-- paragraphs in the preview and on the handset, not one dense block.
--
-- Idempotent; safe to re-run. Apply: shadow first (verify), then Meridian.

update public.lng_email_templates
   set subject = 'Returning your impression kit',
       default_subject = 'Returning your impression kit',
       body_syntax = $b$Hi {{patientFirstName}},

Thanks for your virtual impression appointment. When you're ready to send your impression kit back, use the link below to generate your returns QR code.

[button:Generate your returns QR code|#0E1414|#FFFFFF|999|22|12]({{returnsLink}})

No printer needed. Show the QR code on your phone at the drop-off point, or print it if you prefer, then take your parcel to your nearest Post Office or DPD Parcel Shop.

Your authorisation code: {w:700}{{authorisationCode}}{/w}

A few tips to avoid delays:

- Return shipping usually takes 1 to 3 working days, sometimes longer if your local shop has limited DPD collections.
- For the best chance of same-day collection, drop off early in the morning, around 8 to 9 AM.
- Avoid DPD lockers, as they can cause delays.
- You MUST include your details inside the package: your name, the email address you used to place the order, and your order number.

Any questions, just reply to this email.

Thanks,
{{clinicName}}$b$,
       default_body_syntax = $b$Hi {{patientFirstName}},

Thanks for your virtual impression appointment. When you're ready to send your impression kit back, use the link below to generate your returns QR code.

[button:Generate your returns QR code|#0E1414|#FFFFFF|999|22|12]({{returnsLink}})

No printer needed. Show the QR code on your phone at the drop-off point, or print it if you prefer, then take your parcel to your nearest Post Office or DPD Parcel Shop.

Your authorisation code: {w:700}{{authorisationCode}}{/w}

A few tips to avoid delays:

- Return shipping usually takes 1 to 3 working days, sometimes longer if your local shop has limited DPD collections.
- For the best chance of same-day collection, drop off early in the morning, around 8 to 9 AM.
- Avoid DPD lockers, as they can cause delays.
- You MUST include your details inside the package: your name, the email address you used to place the order, and your order number.

Any questions, just reply to this email.

Thanks,
{{clinicName}}$b$,
       updated_at = now()
 where key = 'returns';

update public.lng_sms_templates
   set body = $b$Hi {{patientFirstName}},

Generate your returns QR code here: {{returnsLink}}

No printer needed. Show the QR code at a Post Office or DPD Parcel Shop, or print it if you prefer.

Inside the parcel, include your name, the email you ordered with, and your order number.

Authorisation code: {{authorisationCode}}

Questions? Just reply. {{clinicName}}.$b$,
       default_body = $b$Hi {{patientFirstName}},

Generate your returns QR code here: {{returnsLink}}

No printer needed. Show the QR code at a Post Office or DPD Parcel Shop, or print it if you prefer.

Inside the parcel, include your name, the email you ordered with, and your order number.

Authorisation code: {{authorisationCode}}

Questions? Just reply. {{clinicName}}.$b$,
       updated_at = now()
 where key = 'returns';

NOTIFY pgrst, 'reload schema';
