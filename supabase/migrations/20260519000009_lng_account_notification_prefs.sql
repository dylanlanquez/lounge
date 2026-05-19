-- 20260519000009_lng_account_notification_prefs.sql
--
-- Per-account state for the notifications bell + drawer that lands
-- on the TopBar. Holds two things:
--
--   1. last_viewed_at  — bumped to now() when the staff member taps
--                        the bell, used by the client to compute
--                        "unseen count = events newer than this".
--   2. disabled_types  — text[] of event_type values the staff
--                        member has muted in the settings sheet.
--                        Empty array = receive every type (default).
--
-- The notifications themselves are NOT materialised in this table.
-- The patient_events table is already the project's audit-trail
-- and already carries every event we surface in the drawer
-- (appointment_booked / appointment_cancelled /
-- appointment_rescheduled / visit_ended_early). Verified on
-- Meridian: 180 / 23 / 3 / 3 rows respectively as of writing. The
-- client joins patient_events to patients + lng_appointments at
-- read time, so adding a new event type to the drawer in future
-- is "extend the IN list", not "rebuild a materialised view".
--
-- One row per account. UNIQUE on account_id forces upsert semantics
-- in the client (insert-or-update keyed on the foreign key). RLS
-- pins to the calling account — admins see everything for audit.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE POLICY ... DROP-
-- and-recreate so a re-apply doesn't error.

create table if not exists public.lng_account_notification_prefs (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null unique
                       references public.accounts(id) on delete cascade,
  -- Bumped to now() every time the bell is opened. The client
  -- computes "unseen since last_viewed_at" by filtering
  -- patient_events.created_at > last_viewed_at. On first
  -- subscription (no row yet) we treat it as "everything is
  -- unseen", then write a row on first open.
  last_viewed_at    timestamptz not null default now(),
  -- Muted event types. Stored as a text[] (not a separate
  -- table) because the list is small + closed (~4 values today),
  -- staff toggle them rarely, and a single column keeps the
  -- realtime payload trivial. A separate row-per-type table
  -- would be over-engineering for this surface.
  disabled_types    text[] not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.lng_account_notification_prefs is
  'Per-account state for the TopBar notifications bell. last_viewed_at drives the unseen-count badge; disabled_types is the per-type mute list set from the drawer settings panel. Notifications themselves are read live from patient_events at query time — no materialised rows here.';

comment on column public.lng_account_notification_prefs.last_viewed_at is
  'Timestamp the staff member last opened the notifications drawer. The bell badge shows a dot iff patient_events newer than this exist (after disabled_types filter).';

comment on column public.lng_account_notification_prefs.disabled_types is
  'Event types the staff member has muted in the drawer settings. Empty array = receive every type. Validated server-side by the client (no enum check on this column to allow forward-compatible additions to the bell without a schema change).';

-- Updated_at touch trigger — same shape as every other lng_* table.
drop trigger if exists lng_account_notification_prefs_touch_updated_at
  on public.lng_account_notification_prefs;
create trigger lng_account_notification_prefs_touch_updated_at
  before update on public.lng_account_notification_prefs
  for each row execute function public.touch_updated_at();

-- RLS: staff see their own row, admins see all.
alter table public.lng_account_notification_prefs enable row level security;

drop policy if exists lng_account_notification_prefs_self on public.lng_account_notification_prefs;
create policy lng_account_notification_prefs_self on public.lng_account_notification_prefs
  for all
  using (account_id = public.auth_account_id())
  with check (account_id = public.auth_account_id());

drop policy if exists lng_account_notification_prefs_admin_all on public.lng_account_notification_prefs;
create policy lng_account_notification_prefs_admin_all on public.lng_account_notification_prefs
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- Realtime broadcast so a settings change on one tablet is reflected
-- on the same staff member's second tablet (rare but easy to support).
alter publication supabase_realtime add table public.lng_account_notification_prefs;

-- ── Rollback ──────────────────────────────────────────────────────
-- alter publication supabase_realtime drop table public.lng_account_notification_prefs;
-- drop policy if exists lng_account_notification_prefs_admin_all on public.lng_account_notification_prefs;
-- drop policy if exists lng_account_notification_prefs_self on public.lng_account_notification_prefs;
-- drop table if exists public.lng_account_notification_prefs;
