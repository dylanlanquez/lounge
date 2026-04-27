-- 20260428_02_lng_settings.sql
-- Per-location and global Lounge configuration. Includes the BNPL scripts
-- (loaded by BNPLHelper at runtime per `01-architecture-decision.md §3.6`).
--
-- Key namespacing convention: dot-separated (`bnpl.klarna.steps`, `epos.tax_rate`).
-- A row with location_id = NULL is a global default; a row with location_id set
-- is a per-location override. Lookup: prefer location-specific, fall back to global.
--
-- Rollback: DROP TABLE public.lng_settings;

create table public.lng_settings (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid references public.locations(id) on delete cascade,
  key          text not null,
  value        jsonb not null,
  description  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index lng_settings_key_global_unique
  on public.lng_settings (key)
  where location_id is null;

create unique index lng_settings_key_per_location_unique
  on public.lng_settings (location_id, key)
  where location_id is not null;

create index lng_settings_location_idx on public.lng_settings (location_id);

create trigger lng_settings_set_updated_at
  before update on public.lng_settings
  for each row execute function public.touch_updated_at();

comment on table public.lng_settings is
  'Lounge runtime configuration. NULL location_id = global default; set location_id = per-location override. Scripts (e.g. BNPL helper) live here so admin can edit without redeploying.';
