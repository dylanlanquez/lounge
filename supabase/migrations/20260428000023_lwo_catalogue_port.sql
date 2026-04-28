-- 20260428000023_lwo_catalogue_port.sql
--
-- Port Checkpoint's lwo_catalogue table + seed data into Meridian.
--
-- Background: when we agreed to "share" the catalogue between Checkpoint
-- and Lounge, the assumption was the table already lived where Lounge
-- could read it. It doesn't — Checkpoint runs on a different Supabase
-- project (emonsrrhflmwfsuupibj). Lounge runs on Meridian
-- (npuvhxakffxqoszytkxw). The catalogue lives in Checkpoint's project
-- and Lounge can't reach it cross-project.
--
-- Path forward: bring the table to Meridian (where Lounge already lives),
-- under the same name (lwo_catalogue) so when Checkpoint's appointments
-- retire, no rename. The Lounge prefix rule (lng_*) doesn't apply here —
-- this is a ported domain table from the existing Checkpoint LWO model,
-- and we want to keep the same name so the two codebases see the same
-- shape until Checkpoint deprecates.
--
-- The schema below is identical to:
--   ~/Desktop/checkpoint-app/supabase/migrations/20260412_01_lwo_catalogue.sql
--   ~/Desktop/checkpoint-app/supabase/migrations/20260412_03_lwo_extras_pricing.sql
-- combined: extra_unit_price is on the table from day one in Meridian (no
-- need to ALTER it in afterwards).
--
-- Rollback: DROP TABLE public.lwo_catalogue;

create table if not exists public.lwo_catalogue (
  id              uuid primary key default gen_random_uuid(),
  code            text unique not null,
  category        text not null,
  name            text not null,
  description     text null,
  unit_price       numeric(10,2) not null,
  -- Volume pricing: first instance on a walk-in / cart charges
  -- unit_price, every subsequent instance charges extra_unit_price.
  -- Null = no discount, every instance unit_price.
  extra_unit_price numeric(10,2) null,
  unit_label       text null,

  service_type    text null,
  product_key     text null,
  repair_variant  text null,
  arch_match      text not null default 'any' check (arch_match in ('any','single','both')),

  sort_order      int default 0,
  active          boolean default true,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists lwo_catalogue_active_idx on public.lwo_catalogue(active);
create index if not exists lwo_catalogue_match_idx on public.lwo_catalogue(service_type, product_key, repair_variant);
create index if not exists lwo_catalogue_sort_idx on public.lwo_catalogue(category, sort_order);

create or replace function public.update_lwo_catalogue_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists lwo_catalogue_updated_at on public.lwo_catalogue;
create trigger lwo_catalogue_updated_at
  before update on public.lwo_catalogue
  for each row execute procedure public.update_lwo_catalogue_updated_at();

alter table public.lwo_catalogue enable row level security;

drop policy if exists "lwo_catalogue_read"  on public.lwo_catalogue;
drop policy if exists "lwo_catalogue_write" on public.lwo_catalogue;

create policy "lwo_catalogue_read" on public.lwo_catalogue
  for select to authenticated using (true);

create policy "lwo_catalogue_write" on public.lwo_catalogue
  for all to authenticated using (true) with check (true);

comment on table public.lwo_catalogue is
  'Shared product / price catalogue. Originally Checkpoint-owned (LWO = Lab Work Order); ported into Meridian so Lounge can read + write the same source of truth as we retire Checkpoint appointments.';
comment on column public.lwo_catalogue.extra_unit_price is
  'Price applied to every instance after the first on a walk-in / cart. NULL = same as unit_price (no volume discount).';

-- Seed: matches Checkpoint's seed verbatim. ON CONFLICT DO NOTHING so a
-- subsequent rerun is idempotent — codes are unique.
insert into public.lwo_catalogue (code, category, name, description, unit_price, unit_label, service_type, product_key, repair_variant, arch_match, sort_order) values
  ('den_snapped',      'Denture repairs',       'Snapped denture',          'Repair dentures snapped into 1, 2 or 3 pieces',           70.00,  null,        'denture_repair', null, 'Snapped denture',  'any',    10),
  ('den_cracked',      'Denture repairs',       'Cracked denture',          'Cracked but not yet snapped',                              60.00,  null,        'denture_repair', null, 'Cracked denture',  'any',    20),
  ('den_broken_tooth', 'Denture repairs',       'Broken tooth',             'Supply and fit replacement tooth, per tooth',              50.00,  'per tooth', 'denture_repair', null, 'Broken tooth',     'any',    30),
  ('den_add_tooth',    'Denture repairs',       'Add a new tooth',          'Add a tooth to existing denture, matched to shade',        40.00,  'per tooth', 'denture_repair', null, 'Add a new tooth',  'any',    40),
  ('den_reline_single','Denture repairs',       'Relining (single arch)',   'Reline upper or lower denture for improved fit',          160.00,  'per arch',  'denture_repair', null, 'Relining',         'single', 50),
  ('den_reline_both',  'Denture repairs',       'Relining (both arches)',   'Reline both upper and lower dentures',                    320.00,  'per arch',  'denture_repair', null, 'Relining',         'both',   55),
  ('ret_single',       'Essix retainers',       'Single arch retainer',     'Top or bottom, ready in under 2 hours',                   149.00,  null,        'same_day_appliance', 'retainer', null, 'single', 100),
  ('ret_both',         'Essix retainers',       'Both arches retainer',     'Top and bottom, ready in under 2 hours',                  199.00,  null,        'same_day_appliance', 'retainer', null, 'both',   105),
  ('aln_single',       'Replacement aligners',  'Single arch aligner',      'Based on current tooth position, ready in under 2 hours', 149.00,  null,        'same_day_appliance', 'aligner',  null, 'single', 200),
  ('aln_both',         'Replacement aligners',  'Both arches aligner',      'Top and bottom, ready in under 2 hours',                  199.00,  null,        'same_day_appliance', 'aligner',  null, 'both',   205),
  ('wt_single',        'Whitening trays',       'Single arch whitening tray','Top or bottom, ready in under 2 hours',                  149.00,  null,        'same_day_appliance', 'whitening_tray', null, 'single', 300),
  ('wt_both',          'Whitening trays',       'Both arches whitening trays','Top and bottom, ready in under 2 hours',                199.00,  null,        'same_day_appliance', 'whitening_tray', null, 'both',   305),
  ('wk_complete',      'Whitening kits',        'Complete whitening kit',   'Custom trays (top and bottom), PAP+ gel, LED light',      199.00,  null,        'same_day_appliance', 'whitening_kit',  null, 'any',    400),
  ('ng_single',        'Night guards',          'Single arch night guard',  'Top or bottom, choice of thickness and material',         149.00,  null,        'same_day_appliance', 'night_guard',    null, 'single', 500),
  ('ng_both',          'Night guards',          'Both arches night guard',  'Top and bottom',                                          199.00,  null,        'same_day_appliance', 'night_guard',    null, 'both',   505),
  ('dg_single',        'Day guards',            'Single arch day guard',    'Slim, discreet, comfortable for daytime wear',            149.00,  null,        'same_day_appliance', 'day_guard',      null, 'single', 600),
  ('dg_both',          'Day guards',            'Both arches day guard',    'Top and bottom',                                          199.00,  null,        'same_day_appliance', 'day_guard',      null, 'both',   605),
  ('mtr_single',       'Missing tooth retainer','Missing tooth retainer (single arch)','Per arch, up to 3 teeth, shade matched',       199.00,  'per arch',  'same_day_appliance', 'missing_tooth',  null, 'single', 700),
  ('mtr_both',         'Missing tooth retainer','Missing tooth retainer (both arches)','Both arches, shade matched',                   298.00,  'per arch',  'same_day_appliance', 'missing_tooth',  null, 'both',   705),
  ('civ_single',       'Click-in veneers',      'Single arch click-in veneers','With storage case and aftercare pack',                 399.00,  null,        'click_in_veneers',   'click_in_veneers', null, 'single', 800),
  ('civ_both',         'Click-in veneers',      'Both arches click-in veneers','With storage case and aftercare pack',                 599.00,  null,        'click_in_veneers',   'click_in_veneers', null, 'both',   805)
on conflict (code) do nothing;
