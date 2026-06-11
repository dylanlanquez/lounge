-- 20260611000006_lng_catalogue_suggestions.sql
--
-- Cart-aware product suggestions for the catalogue picker.
--
-- The picker's "Suggested for this booking" carousel used to show a
-- fixed, intake-derived list. This table lets the admin curate, per
-- product/service, which OTHER catalogue rows to suggest when that row
-- is already in the basket (e.g. an Essix Retainer in the basket ->
-- suggest a Retainer Case, Cleaning Tablets, Whitening Kit).
--
-- Self-referential many-to-one-per-pair on lwo_catalogue:
--   trigger_catalogue_id    — "when THIS is in the basket"
--   suggested_catalogue_id  — "suggest THIS"
--   sort_order              — display order within one trigger's set
--
-- When the basket is empty the picker shows every active row instead,
-- so there is no "default set" concept here — every row in this table
-- is keyed to a concrete trigger (NOT NULL).
--
-- Mirrors lng_catalogue_upgrades exactly for access: RLS stays off and
-- Supabase's default privileges grant anon/authenticated full DML, same
-- as the upgrades editor it sits beside in the admin catalogue editor.
--
-- Additive only. Rollback at the bottom of the file.

create table if not exists public.lng_catalogue_suggestions (
  id                     uuid primary key default gen_random_uuid(),
  trigger_catalogue_id   uuid not null references public.lwo_catalogue(id) on delete cascade,
  suggested_catalogue_id uuid not null references public.lwo_catalogue(id) on delete cascade,
  sort_order             int not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- A product can't suggest itself.
  constraint lng_catalogue_suggestions_no_self
    check (trigger_catalogue_id <> suggested_catalogue_id),
  -- One row per (trigger, suggested) pair — re-adding the same companion
  -- is an upsert target, not a duplicate.
  constraint lng_catalogue_suggestions_pair_uniq
    unique (trigger_catalogue_id, suggested_catalogue_id)
);

-- Picker resolves suggestions by trigger id, in sort order.
create index if not exists lng_catalogue_suggestions_trigger_sort_idx
  on public.lng_catalogue_suggestions (trigger_catalogue_id, sort_order);

-- Reverse lookup so deleting a suggested product can find its rows
-- cheaply (the FK cascade uses it too).
create index if not exists lng_catalogue_suggestions_suggested_idx
  on public.lng_catalogue_suggestions (suggested_catalogue_id);

create trigger lng_catalogue_suggestions_set_updated_at
  before update on public.lng_catalogue_suggestions
  for each row execute function public.touch_updated_at();

comment on table public.lng_catalogue_suggestions is
  'Per-product cart suggestions for the Lounge catalogue picker. When trigger_catalogue_id is in the basket, the picker offers suggested_catalogue_id in the "Suggested for this booking" carousel (deduped across all basket items, excluding rows already in the basket). Empty basket shows every active row instead, so every row here is keyed to a concrete trigger.';

comment on column public.lng_catalogue_suggestions.trigger_catalogue_id is
  'The catalogue row whose presence in the basket triggers this suggestion.';
comment on column public.lng_catalogue_suggestions.suggested_catalogue_id is
  'The catalogue row offered as a companion when the trigger is in the basket.';
comment on column public.lng_catalogue_suggestions.sort_order is
  'Display order of this companion within the trigger product''s suggestion set (ascending).';

-- ── Rollback ────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.lng_catalogue_suggestions;
