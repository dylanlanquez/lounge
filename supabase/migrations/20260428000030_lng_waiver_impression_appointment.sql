-- 20260428000030_lng_waiver_impression_appointment.sql
--
-- Adds a dedicated waiver section for in-person impression
-- appointments. Up until now impressions inherited the
-- 'same_day_appliance' waiver, which is written from the
-- finished-appliance perspective ("I have inspected my appliance and
-- accept its current condition") — wrong moment, wrong language for
-- a patient who has just had their impression / scan taken and is
-- leaving without an appliance.
--
-- The new section explicitly:
--   1. Frames Lounge staff as offering a supportive role rather than
--      acting as registered dental professionals.
--   2. Puts the responsibility for impression / scan quality back on
--      the patient following staff guidance, with re-take charges
--      payable by the patient unless staff error is demonstrated.
--   3. Confirms allergies / medical disclosures and acceptance of
--      residual risk for materials and equipment commonly used in
--      dental settings.
--   4. Notes that any appliance ordered is custom-made and
--      non-refundable once production has begun (the appliance
--      waiver applies separately at collection).
--   5. Releases Lounge, staff and lab partners from liability for
--      ordinary outcomes within reasonable expectations except where
--      caused by demonstrable negligence.
--   6. Confirms patient (or guardian) authority to consent.
--
-- IMPORTANT: this is a working draft for Venneir's legal/compliance
-- review. Admin → Waivers UI lets staff edit the terms and bump the
-- version once a UK dental-aware lawyer has signed off on the final
-- wording.
--
-- Schema change: extend the CHECK constraint on
-- applies_to_service_type so the new value 'impression_appointment'
-- is accepted.
--
-- Rollback:
--   DELETE FROM public.lng_waiver_sections WHERE key = 'impression_appointment';
--   ALTER TABLE public.lng_waiver_sections
--     DROP CONSTRAINT lng_waiver_sections_applies_to_service_type_check;
--   ALTER TABLE public.lng_waiver_sections
--     ADD CONSTRAINT lng_waiver_sections_applies_to_service_type_check
--     CHECK (applies_to_service_type IS NULL OR applies_to_service_type IN
--       ('denture_repair', 'same_day_appliance', 'click_in_veneers'));

-- ── 1. extend the CHECK constraint ─────────────────────────────────────────
alter table public.lng_waiver_sections
  drop constraint if exists lng_waiver_sections_applies_to_service_type_check;

alter table public.lng_waiver_sections
  add constraint lng_waiver_sections_applies_to_service_type_check
  check (
    applies_to_service_type is null
    or applies_to_service_type in (
      'denture_repair',
      'same_day_appliance',
      'click_in_veneers',
      'impression_appointment'
    )
  );

-- ── 2. seed the new section ────────────────────────────────────────────────
insert into public.lng_waiver_sections (
  key,
  title,
  terms,
  version,
  applies_to_service_type,
  sort_order,
  active
) values (
  'impression_appointment',
  'In-person impression appointment',
  jsonb_build_array(
    'I understand that the staff at Venneir Lounge will guide and assist me through the process of capturing my dental impressions or intraoral scans during this appointment. Staff are providing a supportive role only and are not acting as my registered dental professional.',
    'I am responsible for following staff guidance carefully so the resulting impression or scan is suitable for the appliance I have ordered. The fit, finish and timing of any appliance produced from this appointment depend directly on the quality of the impression or scan captured today.',
    'If the impression or scan is determined by the laboratory to be unsuitable for production, I understand that a re-take may be required, and any associated charges (additional appointment fees, materials, or laboratory work) will be payable by me unless the issue is shown to result from demonstrable staff error.',
    'I confirm I have disclosed any allergies, sensitivities or relevant medical conditions to staff before the appointment. I understand the materials and equipment used during impression or scan capture (including impression putties, trays, and intraoral scanner wands) are commonly used in dental settings and considered safe under normal conditions, and I accept the ordinary residual risk associated with their use.',
    'I confirm I have voluntarily attended this appointment and am consenting to the impression or scan capture procedure described to me by staff. I understand I may stop the procedure at any time.',
    'I understand that any appliance ordered following this appointment (including but not limited to retainers, mouthguards, whitening trays, click-in veneers, and dentures) is a custom-made device and is non-refundable once production has begun. The appliance-specific terms and warranty apply at the point of collection and are not waived by this agreement.',
    'To the fullest extent permitted by law, I release Venneir Lounge, its staff, and its laboratory partners from liability for any minor discomfort, dissatisfaction with the resulting appliance fit, normal wear-related changes, or other ordinary outcomes that fall within reasonable expectations of dental impression or scan capture, except where caused by demonstrable negligence.',
    'Nothing in this agreement removes any right I may have under UK consumer protection legislation that cannot be excluded by contract.',
    'I confirm I am the patient receiving the procedure (or the parent / legal guardian of a patient under the age of 18) and have authority to consent to it. I have been given the opportunity to ask questions and am satisfied with the information provided.'
  ),
  '2026-04-28-v1',
  'impression_appointment',
  4,
  true
)
on conflict (key) do update
set
  title = excluded.title,
  terms = excluded.terms,
  version = excluded.version,
  applies_to_service_type = excluded.applies_to_service_type,
  sort_order = excluded.sort_order,
  active = excluded.active,
  updated_at = now();
