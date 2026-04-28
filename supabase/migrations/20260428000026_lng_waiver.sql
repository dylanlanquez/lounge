-- 20260428000026_lng_waiver.sql
--
-- Waiver / consent system. Two tables:
--
--   lng_waiver_sections    Admin-editable terms grouped by section (general /
--                          denture / appliance / click_in_veneers). Each
--                          section has its own version stamp so legal can
--                          update one set of terms without forcing patients
--                          who only signed the others to re-sign. Bumping a
--                          section's version invalidates every existing
--                          signature for that section on next visit.
--
--   lng_waiver_signatures  One row per signing event. signature_svg is the
--                          vector path captured by the canvas pad. The
--                          terms_snapshot column records the EXACT terms
--                          text that was on screen at the time, so a 2027
--                          audit can reproduce what was signed in 2026 even
--                          if the section was rewritten in between.
--
-- "Has this patient signed every section their visit requires, at the
-- current version?" is a derived query — the lng_waiver_signatures table
-- is the source of truth, no denormalised "last_version_signed" column on
-- patients. Index on (patient_id, section_key, signed_at desc) makes the
-- "latest signature per section" lookup O(log n).
--
-- Sections seeded:
--   general            UK GDPR / data-processing consent. applies_to_service_type
--                      NULL = required of every patient regardless of cart.
--   denture            denture_repair line items
--   appliance          same_day_appliance line items (retainers, guards, whitening trays/kits)
--   click_in_veneers   click_in_veneers line items (cosmetic warranty differs)
--
-- Versioning convention: ISO date + suffix, e.g. '2026-04-28-v1'. Bump on
-- every legally-meaningful change. Sort_order drives display order in the
-- form sheet.
--
-- Rollback: DROP TABLE lng_waiver_signatures, lng_waiver_sections;

create table public.lng_waiver_sections (
  key                     text primary key,
  title                   text not null,
  terms                   jsonb not null,
  version                 text not null,
  applies_to_service_type text
    check (applies_to_service_type is null
      or applies_to_service_type in ('denture_repair', 'same_day_appliance', 'click_in_veneers')),
  sort_order              int not null default 0,
  active                  boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create or replace function public.lng_waiver_sections_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger lng_waiver_sections_set_updated_at
  before update on public.lng_waiver_sections
  for each row execute function public.lng_waiver_sections_touch_updated_at();

alter table public.lng_waiver_sections enable row level security;
create policy lng_waiver_sections_read on public.lng_waiver_sections
  for select to authenticated using (true);
create policy lng_waiver_sections_write on public.lng_waiver_sections
  for all to authenticated using (true) with check (true);

comment on table public.lng_waiver_sections is
  'Admin-editable waiver / consent text, grouped by section. Each section has independent version. applies_to_service_type matches lng_cart_items.service_type — null means always required (e.g. GDPR).';
comment on column public.lng_waiver_sections.terms is
  'jsonb array of paragraph strings. Order preserved. Renderable as <li> or <p> in the form sheet.';

create table public.lng_waiver_signatures (
  id              uuid primary key default gen_random_uuid(),
  patient_id      uuid not null references public.patients(id) on delete restrict,
  visit_id        uuid references public.lng_visits(id) on delete set null,
  section_key     text not null references public.lng_waiver_sections(key) on delete restrict,
  section_version text not null,
  signature_svg   text not null,
  signed_at       timestamptz not null default now(),
  witnessed_by    uuid references public.accounts(id) on delete set null,
  -- Snapshot of the terms text as it stood when signed. Critical for
  -- legal record-keeping — Reproducing what the patient agreed to must
  -- not depend on the section row staying unchanged.
  terms_snapshot  jsonb not null,
  created_at      timestamptz not null default now()
);

create index lng_waiver_signatures_patient_section_idx
  on public.lng_waiver_signatures (patient_id, section_key, signed_at desc);
create index lng_waiver_signatures_visit_idx
  on public.lng_waiver_signatures (visit_id);

alter table public.lng_waiver_signatures enable row level security;
create policy lng_waiver_signatures_read on public.lng_waiver_signatures
  for select to authenticated using (true);
create policy lng_waiver_signatures_write on public.lng_waiver_signatures
  for insert to authenticated with check (true);
-- No update / delete policy — signatures are immutable. Corrections happen
-- by inserting a new signature row at the current version.

comment on table public.lng_waiver_signatures is
  'One row per signing event. Immutable — corrections create a new row at the current section version. terms_snapshot preserves the exact text agreed to.';

-- Seed the four sections. Versions all start at 2026-04-28-v1; bump on any
-- legally-meaningful edit. Terms ported from Checkpoint where applicable;
-- general (GDPR) and click_in_veneers are Lounge-original.
insert into public.lng_waiver_sections (key, title, terms, version, applies_to_service_type, sort_order) values
  (
    'general',
    'Privacy and consent',
    jsonb_build_array(
      'I consent to the laboratory processing my personal information (contact details, dental impressions, photographs, and payment information) for the purpose of providing dental laboratory services. Processing is in accordance with UK GDPR and the Data Protection Act 2018.',
      'I understand my data is retained per the laboratory''s privacy policy and applicable regulatory retention periods. I may request access, correction, or erasure of my personal data at any time.',
      'I consent to clinical photographs being taken before and after the work for the purpose of records and any required laboratory communication.',
      'I confirm the contact information I have provided is correct and may be used to contact me regarding the work, follow-up, and any required corrections.'
    ),
    '2026-04-28-v1',
    null,
    10
  ),
  (
    'denture',
    'Denture services',
    jsonb_build_array(
      'I have inspected my repaired denture(s) and accept them in their current condition.',
      'The laboratory provides a 24-hour warranty on the repair workmanship from the time of collection. Any issues directly related to the repair work must be reported within 24 hours for assessment and potential correction at no additional charge.',
      'Once I leave the laboratory premises, the laboratory is not liable for any damage, breakage, loss, or issues that occur with the denture(s), including but not limited to normal wear, improper use, or accidental damage.',
      'No extended warranty is provided due to the nature of denture repairs. Dentures are medical devices subject to wear, pre-existing damage, and individual usage patterns. While repairs are performed to industry standards, the laboratory cannot guarantee the longevity or future performance of repaired dentures beyond the 24-hour warranty period.',
      'The laboratory is not responsible for pre-existing damage, wear, structural weaknesses, or the age and condition of the denture(s) that may affect the repair outcome.'
    ),
    '2026-04-28-v1',
    'denture_repair',
    20
  ),
  (
    'appliance',
    'Appliances',
    jsonb_build_array(
      'I have inspected my dental appliance(s) and accept them in their current condition at the time of collection.',
      'Each appliance has been fabricated to the measurements and impressions taken on the day. Fit is dependent on the quality of the impression provided. If an impression is deemed inadequate by the technician, I understand that a remake may be required.',
      'The laboratory provides a 24-hour warranty on workmanship from the time of collection. Any fit or fabrication issues directly related to the laboratory''s work must be reported within 24 hours for assessment and potential correction at no additional charge.',
      'Dental appliances are custom-made medical devices. Once collected, the laboratory is not liable for damage, breakage, loss, or issues arising from improper use, accidental damage, or failure to follow the care instructions provided.',
      'The laboratory is not responsible for pre-existing dental conditions, tooth movement, changes in bite, or any other oral health factors that may affect the fit or performance of any appliance after collection.',
      'No extended warranty is provided. Wear and tear, discolouration, and changes in fit over time are normal and are not covered.',
      'I confirm I have been given the opportunity to ask questions and am satisfied with the information provided.'
    ),
    '2026-04-28-v1',
    'same_day_appliance',
    30
  ),
  (
    'click_in_veneers',
    'Click-in veneers',
    jsonb_build_array(
      'Click-in veneers are a cosmetic, removable dental device and are not a substitute for professional dental treatment.',
      'They must be removed before eating, drinking (other than water), sleeping, or engaging in contact sports.',
      'Results may vary based on individual dental anatomy. No guarantee is made regarding aesthetic outcome beyond fabrication to the agreed specification.',
      'I have inspected the click-in veneers at collection and accept the cosmetic outcome and fit.',
      'No extended warranty is provided beyond the 24-hour workmanship window. Wear, discolouration, and fit changes over time are normal and not covered.'
    ),
    '2026-04-28-v1',
    'click_in_veneers',
    40
  );
