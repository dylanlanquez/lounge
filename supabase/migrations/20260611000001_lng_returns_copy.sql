-- 20260611000001_lng_returns_copy.sql
--
-- Better returns copy: the email carries the full instructions (QR code,
-- drop-off, timing tips, what to include), the SMS packs only the key
-- info. Updates both the live body and the reset-to-default baseline for
-- the General 'returns' templates. Idempotent; safe to re-run.
--
-- Apply: shadow first (verify), then Meridian.

update public.lng_email_templates
   set subject = 'Returning your impression kit',
       default_subject = 'Returning your impression kit',
       body_syntax = $b$Hi {{patientFirstName}},

Thanks for your virtual impression appointment. When you're ready to send your impression kit back, use the link below to generate your returns QR code. Drop it off at your nearest Post Office or DPD Parcel Shop, no printer required.

[button:Generate your returns QR code|#0E1414|#FFFFFF|999|22|12]({{returnsLink}})

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

Thanks for your virtual impression appointment. When you're ready to send your impression kit back, use the link below to generate your returns QR code. Drop it off at your nearest Post Office or DPD Parcel Shop, no printer required.

[button:Generate your returns QR code|#0E1414|#FFFFFF|999|22|12]({{returnsLink}})

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
 where key = 'returns' and service_type is null;

update public.lng_sms_templates
   set body = $b$Hi {{patientFirstName}}, generate your prepaid DPD returns QR code here: {{returnsLink}} Drop your kit at a Post Office or DPD Parcel Shop, no printer needed. Put your name, the email you ordered with, and your order number inside the parcel. Authorisation code: {{authorisationCode}}. Questions? Just reply. {{clinicName}}.$b$,
       default_body = $b$Hi {{patientFirstName}}, generate your prepaid DPD returns QR code here: {{returnsLink}} Drop your kit at a Post Office or DPD Parcel Shop, no printer needed. Put your name, the email you ordered with, and your order number inside the parcel. Authorisation code: {{authorisationCode}}. Questions? Just reply. {{clinicName}}.$b$,
       updated_at = now()
 where key = 'returns' and service_type is null;

NOTIFY pgrst, 'reload schema';
