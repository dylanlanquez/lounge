-- 20260430000007_lng_catalogue_settings.sql
--
-- Per-catalogue-item settings + per-upgrade display position. Three
-- moves, all additive:
--
--   1. lwo_catalogue gains four columns:
--        sla_enabled         — when true, this item carries an SLA from
--                              "marked arrived" to "appointment complete".
--        sla_target_minutes  — target window in minutes. Null when SLA is
--                              off, set when on. The breach evaluator (a
--                              follow-up slice) reads these two together.
--        include_on_lwo      — gates whether the line appears on the
--                              printable Lab Work Order. Defaults true
--                              for service-bearing rows; false for
--                              impression appointments (today the print
--                              already hard-codes that filter — this
--                              column generalises it).
--        allocate_job_box    — gates whether arrival demands a JB ref for
--                              this item. Backfilled true for denture /
--                              appliance / click-in-veneer rows, false
--                              for impression appointments (they pick up
--                              a JB later when the appliance is built).
--
--   2. lng_catalogue_waiver_requirements — explicit per-item waiver links.
--      When an item has rows here, those win and the existing
--      applies_to_service_type inference is bypassed for that item.
--      Items with no rows fall back to the inference rule, so legacy
--      data keeps working without backfill.
--
--   3. lng_catalogue_upgrades.display_position — controls how the upgrade
--      renders in product tables / LWO / cart copy:
--        before_device  — prefixes the device name (e.g. "Scalloped Denture")
--        after_device   — suffixes (e.g. "Denture, scalloped"), the default
--        own_line       — renders as its own row in tables that allow it
--
-- Rollback at the bottom.

-- ── 1. lwo_catalogue settings columns ──────────────────────────────────────
alter table public.lwo_catalogue
  add column if not exists sla_enabled        boolean not null default false,
  add column if not exists sla_target_minutes integer null,
  add column if not exists include_on_lwo     boolean not null default true,
  add column if not exists allocate_job_box   boolean not null default true;

-- sla_target_minutes only makes sense when sla_enabled. Keep this loose —
-- a target without enabled is just dormant config — but disallow zero or
-- negative when set so the evaluator doesn't divide by zero.
alter table public.lwo_catalogue
  add constraint lwo_catalogue_sla_target_positive
  check (sla_target_minutes is null or sla_target_minutes > 0);

-- Backfill: impression appointments shouldn't print on the LWO and
-- shouldn't demand a JB. Everything else keeps the column default
-- (true / true).
update public.lwo_catalogue
  set include_on_lwo = false,
      allocate_job_box = false
  where service_type = 'impression_appointment';

comment on column public.lwo_catalogue.sla_enabled is
  'When true, the item carries an arrived → appointment-complete SLA. The breach evaluator reads sla_target_minutes alongside.';
comment on column public.lwo_catalogue.sla_target_minutes is
  'Target window in minutes. Null when SLA is off; positive integer when on. Constraint forbids zero or negative.';
comment on column public.lwo_catalogue.include_on_lwo is
  'Gates whether the cart line appears on the printable Lab Work Order. Defaults true; impression-appointment rows are false.';
comment on column public.lwo_catalogue.allocate_job_box is
  'Gates whether arrival requires a job box ref for this item. Defaults true; impression-appointment rows are false (they get a JB later when the actual appliance is fabricated).';

-- ── 2. lng_catalogue_waiver_requirements ───────────────────────────────────
-- Composite PK (catalogue_id, section_key) — at most one row per pair.
-- Catalogue side cascades on delete (the link is meaningless without the
-- product). Waiver-section side restricts on delete: legal must
-- consciously detach a section before retiring it, so no signed link
-- silently disappears.
create table if not exists public.lng_catalogue_waiver_requirements (
  catalogue_id uuid not null references public.lwo_catalogue(id)        on delete cascade,
  section_key  text not null references public.lng_waiver_sections(key) on delete restrict,
  created_at   timestamptz not null default now(),
  primary key (catalogue_id, section_key)
);

create index if not exists lng_catalogue_waiver_requirements_section_idx
  on public.lng_catalogue_waiver_requirements (section_key);

alter table public.lng_catalogue_waiver_requirements enable row level security;
create policy lng_catalogue_waiver_requirements_read on public.lng_catalogue_waiver_requirements
  for select to authenticated using (true);
create policy lng_catalogue_waiver_requirements_write on public.lng_catalogue_waiver_requirements
  for all to authenticated using (true) with check (true);

comment on table public.lng_catalogue_waiver_requirements is
  'Explicit per-catalogue-item waiver requirements. When an item has any rows here, the waiver resolver uses these and ignores lng_waiver_sections.applies_to_service_type for that item. Items without rows fall back to the inference rule — legacy data keeps working.';

-- ── 3. lng_catalogue_upgrades display_position ─────────────────────────────
alter table public.lng_catalogue_upgrades
  add column if not exists display_position text not null default 'after_device';

alter table public.lng_catalogue_upgrades
  add constraint lng_catalogue_upgrades_display_position_check
  check (display_position in ('before_device', 'after_device', 'own_line'));

comment on column public.lng_catalogue_upgrades.display_position is
  'How this upgrade renders next to the device name in LWO / product tables / cart copy. before_device prefixes (e.g. "Scalloped Denture"), after_device suffixes ("Denture, scalloped"), own_line renders as its own row where the surface allows.';

-- ── Rollback ───────────────────────────────────────────────────────────────
-- ALTER TABLE public.lng_catalogue_upgrades
--   DROP CONSTRAINT IF EXISTS lng_catalogue_upgrades_display_position_check,
--   DROP COLUMN IF EXISTS display_position;
-- DROP TABLE IF EXISTS public.lng_catalogue_waiver_requirements;
-- ALTER TABLE public.lwo_catalogue
--   DROP CONSTRAINT IF EXISTS lwo_catalogue_sla_target_positive,
--   DROP COLUMN IF EXISTS allocate_job_box,
--   DROP COLUMN IF EXISTS include_on_lwo,
--   DROP COLUMN IF EXISTS sla_target_minutes,
--   DROP COLUMN IF EXISTS sla_enabled;
