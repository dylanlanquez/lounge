-- 20260610000007_lng_returns.sql
--
-- Returns flow. From the virtual appointment page, staff send the patient
-- their prepaid DPD return label + an authorisation code, by email and/or
-- SMS. The message is editable in Admin (Emails + SMS templates, key
-- 'returns'); the code is stored per staff member and the SENDING staff
-- member's code is inserted at send time.
--
-- Adds:
--   • lng_staff_members.authorisation_code (per-staff free text)
--   • lng_settings 'returns.link' (the DPD returns URL → {{returnsLink}})
--   • General 'returns' SMS + email templates (the editable default copy)
--
-- Apply: shadow first (verify), then Meridian.

-- ── 1. Per-staff authorisation code ────────────────────────────────
alter table public.lng_staff_members
  add column if not exists authorisation_code text;
comment on column public.lng_staff_members.authorisation_code is
  'Free-text code sent to patients in the returns message (DPD return authorisation). Set per staff in Admin > Staff; the sending staff member''s code is used at send time.';
-- lng_staff_members uses column-level grants for authenticated.
grant select (authorisation_code), update (authorisation_code)
  on public.lng_staff_members to authenticated;

-- ── 2. DPD returns link (editable; rendered as {{returnsLink}}) ─────
insert into public.lng_settings (key, value, location_id)
select 'returns.link', to_jsonb('https://our-returns.dpd.co.uk/VENNEIR'::text), null
where not exists (
  select 1 from public.lng_settings where key = 'returns.link' and location_id is null
);

-- ── 3. Returns SMS template (General default) ──────────────────────
insert into public.lng_sms_templates (key, service_type, body, default_body, description, enabled, version)
select
  'returns', null,
  $b$Hi {{patientFirstName}}, to send your impression kit back, use this prepaid DPD label and drop it at any DPD point: {{returnsLink}}
Authorisation code: {{authorisationCode}}. Any questions, just reply. Thanks, {{clinicName}}.$b$,
  $b$Hi {{patientFirstName}}, to send your impression kit back, use this prepaid DPD label and drop it at any DPD point: {{returnsLink}}
Authorisation code: {{authorisationCode}}. Any questions, just reply. Thanks, {{clinicName}}.$b$,
  'Returns: DPD return label + authorisation code. Sent from the virtual appointment page.',
  true, 1
where not exists (
  select 1 from public.lng_sms_templates where key = 'returns' and service_type is null
);

-- ── 4. Returns email template (General default) ────────────────────
insert into public.lng_email_templates
  (key, service_type, subject, body_syntax, default_subject, default_body_syntax, description, enabled, version)
select
  'returns', null,
  'Returning your impression kit',
  $b$Hi {{patientFirstName}},

Thanks for your virtual impression appointment. When you're ready to send your impression kit back, use the prepaid DPD return label below.

[button:Create your DPD return label|#0E1414|#FFFFFF|999|22|12]({{returnsLink}})

Your authorisation code: {w:700}{{authorisationCode}}{/w}

Print the label, attach it to your parcel, and drop it at any DPD pickup point. Any questions, just reply to this email.

Thanks,
{{clinicName}}$b$,
  'Returning your impression kit',
  $b$Hi {{patientFirstName}},

Thanks for your virtual impression appointment. When you're ready to send your impression kit back, use the prepaid DPD return label below.

[button:Create your DPD return label|#0E1414|#FFFFFF|999|22|12]({{returnsLink}})

Your authorisation code: {w:700}{{authorisationCode}}{/w}

Print the label, attach it to your parcel, and drop it at any DPD pickup point. Any questions, just reply to this email.

Thanks,
{{clinicName}}$b$,
  'Returns: DPD return label + authorisation code. Sent from the virtual appointment page.',
  true, 1
where not exists (
  select 1 from public.lng_email_templates where key = 'returns' and service_type is null
);

NOTIFY pgrst, 'reload schema';
