-- 20260428000027_lng_waiver_content_v2.sql
--
-- Aligns the seeded waiver text with Checkpoint's production WAIVER_TEXT
-- (src/lib/walkins.js) so what Lounge patients sign matches what
-- Checkpoint patients have agreed to in production. The previous seed
-- (migration 26) ported the denture text verbatim but dropped two
-- lines from Checkpoint's appliance section and split click-in
-- veneers into its own section. The split is kept (Lounge prefers
-- finer-grained per-section versioning), but the Checkpoint lines
-- are restored to the appliance section so coverage matches.
--
-- Versions bump on the `appliance` section because its text changes.
-- Bumping invalidates every existing signature on that section per
-- the per-section versioning model — receptionists will be prompted
-- to re-sign on the next arrival. `denture`, `general`, and
-- `click_in_veneers` are unchanged so their existing signatures
-- remain current.
--
-- Rollback: revert the appliance row's terms + version to the
-- 2026-04-28-v1 values from migration 26.

update public.lng_waiver_sections
set
  terms = jsonb_build_array(
    'I have inspected my dental appliance(s) and accept them in their current condition at the time of collection.',
    'Each appliance has been fabricated to the measurements and impressions taken on the day. Fit is dependent on the quality of the impression provided. If an impression is deemed inadequate by the technician, I understand that a remake may be required.',
    'The laboratory provides a 24-hour warranty on workmanship from the time of collection. Any fit or fabrication issues directly related to the laboratory''s work must be reported within 24 hours for assessment and potential correction at no additional charge.',
    'Dental appliances are custom-made medical devices. Once collected, the laboratory is not liable for damage, breakage, loss, or issues arising from improper use, accidental damage, or failure to follow the care instructions provided.',
    'The laboratory is not responsible for pre-existing dental conditions, tooth movement, changes in bite, or any other oral health factors that may affect the fit or performance of any appliance after collection.',
    'No extended warranty is provided. Wear and tear, discolouration, and changes in fit over time are normal and are not covered.',
    'Click-in Veneers, where supplied, are a cosmetic, removable dental device and not a substitute for professional dental treatment. They must be removed before eating, drinking (other than water), sleeping, or engaging in contact sports. Results may vary based on individual dental anatomy and no guarantee is made regarding aesthetic outcome beyond fabrication to the agreed specification.',
    'I confirm I have been given the opportunity to ask questions and am satisfied with the information provided.'
  ),
  version = '2026-04-28-v2',
  updated_at = now()
where key = 'appliance';
