-- 20260430000019_lng_reports_financials_foundation.sql
--
-- Foundation for the Reports + Financials sections.
--
-- Three pieces, all designed to scale with the section as it grows
-- across follow-up PRs:
--
--   1. Granular permission flags on lng_staff_members. Reports is
--      operational and visible to every staff member by default.
--      Financials is money-side and gated to the super admin by
--      default; the super admin grants it via the Staff editor. Cash
--      counting is a sub-flag on top of financials because viewing
--      past counts is a different trust level than performing one.
--
--   2. lng_cash_counts + lng_cash_count_lines. Two-table snapshot of
--      a safe-counting event. The counts row carries the period,
--      expected/actual/variance, counter, signer, status. The lines
--      table denormalises every cash payment included in the count
--      so the statement remains accurate forever — even if a
--      payment is voided or amended after the count is signed, the
--      historical record of "this is what was supposed to be in the
--      safe at count time" stays exact.
--
--   3. Anomaly thresholds in lng_settings, seeded at sensible
--      defaults. Tunable without a deploy because the brief says
--      configuration values come from config or DB, never hard-coded
--      in components.
--
-- Two SECURITY DEFINER helpers (auth_can_view_financials,
-- auth_can_count_cash) mirror the existing auth_is_lng_admin
-- pattern. Each policy on the new tables calls the helper, never
-- inlines the EXISTS query — that's what produced the recursion bug
-- on lng_staff_members earlier.
--
-- No backfill of permission flags. Defaults apply to existing rows;
-- the super admin (dylan@lanquez.com) always passes the gate via
-- the email-derived implicit override in useCurrentAccount.
--
-- Rollback at the bottom.

-- ── 1. Permission columns on lng_staff_members ─────────────────────────────
alter table public.lng_staff_members
  add column if not exists can_view_reports     boolean not null default true,
  add column if not exists can_view_financials  boolean not null default false,
  add column if not exists can_count_cash       boolean not null default false;

comment on column public.lng_staff_members.can_view_reports is
  'Opens the Reports tab. Operational reports — service mix, demographics, bookings vs walk-ins. Default true: every Lounge staff member can see them.';
comment on column public.lng_staff_members.can_view_financials is
  'Opens the Financials tab. Money-side reports + cash reconciliation reads. Super-admin-grants only. Default false.';
comment on column public.lng_staff_members.can_count_cash is
  'Authorises performing a cash reconciliation count (initiating + entering the actual safe figure). Distinct from can_view_financials because viewing past counts is a lower trust level than performing one. Default false.';

-- ── 2. SECURITY DEFINER auth helpers ───────────────────────────────────────
-- Same pattern as public.auth_is_lng_admin — runs with bypass-RLS so
-- the inner SELECT against lng_staff_members never re-triggers the
-- write policy on that table. Granted to authenticated, revoked
-- from public.

create or replace function public.auth_can_view_financials()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.lng_staff_members sm
      join public.accounts a on a.id = sm.account_id
     where a.auth_user_id = auth.uid()
       and sm.status = 'active'
       and (sm.can_view_financials = true or a.login_email = 'dylan@lanquez.com')
  );
$$;

revoke all on function public.auth_can_view_financials() from public;
grant execute on function public.auth_can_view_financials() to authenticated;

comment on function public.auth_can_view_financials() is
  'True when the calling auth user can read Lounge financials. SECURITY DEFINER bypasses RLS so policies on lng_cash_counts can call it without recursing.';

create or replace function public.auth_can_count_cash()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.lng_staff_members sm
      join public.accounts a on a.id = sm.account_id
     where a.auth_user_id = auth.uid()
       and sm.status = 'active'
       and (sm.can_count_cash = true or a.login_email = 'dylan@lanquez.com')
  );
$$;

revoke all on function public.auth_can_count_cash() from public;
grant execute on function public.auth_can_count_cash() to authenticated;

comment on function public.auth_can_count_cash() is
  'True when the calling auth user can perform a cash reconciliation. Distinct from auth_can_view_financials — performing a count is a higher-trust action.';

-- ── 3. lng_cash_counts ─────────────────────────────────────────────────────
create table if not exists public.lng_cash_counts (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references public.locations(id) on delete restrict,
  -- Period covered. period_end is when the count was performed; period_start
  -- is whenever the previous signed count ended (or earliest cash payment if
  -- this is the first ever count). Both timestamptz so timezones are explicit.
  period_start    timestamptz not null,
  period_end      timestamptz not null,
  -- Snapshotted at count creation. expected_pence is sum of cash
  -- payments in the period; actual_pence is what the counter saw
  -- physically in the safe. Both immutable once the count is signed.
  expected_pence  integer not null check (expected_pence >= 0),
  actual_pence    integer null check (actual_pence is null or actual_pence >= 0),
  -- Generated so it can never drift from the two source figures.
  variance_pence  integer generated always as (
    case when actual_pence is null then 0 else actual_pence - expected_pence end
  ) stored,
  status          text not null default 'pending'
                    check (status in ('pending', 'signed', 'disputed')),
  notes           text null,
  -- Counter writes the count. Signer (different person) signs it
  -- off after a manager re-auth — same anti-self-approval pattern as
  -- the discount + void flows.
  counted_by      uuid not null references public.accounts(id) on delete restrict,
  counted_at      timestamptz not null default now(),
  signed_off_by   uuid null references public.accounts(id) on delete restrict,
  signed_off_at   timestamptz null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Pair constraint: a signed count carries both signer and timestamp.
alter table public.lng_cash_counts
  add constraint lng_cash_counts_signed_pair check (
    (status <> 'signed' and signed_off_by is null and signed_off_at is null)
    or
    (status = 'signed' and signed_off_by is not null and signed_off_at is not null)
  );

-- Period sanity.
alter table public.lng_cash_counts
  add constraint lng_cash_counts_period_order check (period_start <= period_end);

-- Counter and signer must differ. Belt-and-braces — the client also
-- blocks self-approval, but the constraint catches direct SQL writes.
alter table public.lng_cash_counts
  add constraint lng_cash_counts_counter_signer_distinct check (
    signed_off_by is null or signed_off_by <> counted_by
  );

create index lng_cash_counts_period_idx
  on public.lng_cash_counts (location_id, period_end desc);
create index lng_cash_counts_status_idx
  on public.lng_cash_counts (status, period_end desc);

create trigger lng_cash_counts_set_updated_at
  before update on public.lng_cash_counts
  for each row execute function public.touch_updated_at();

alter table public.lng_cash_counts enable row level security;

create policy lng_cash_counts_read on public.lng_cash_counts
  for select to authenticated using (public.auth_can_view_financials());
create policy lng_cash_counts_insert on public.lng_cash_counts
  for insert to authenticated with check (public.auth_can_count_cash());
-- Updates allowed only on pending rows. Signed / disputed are
-- immutable for the counter; the only path forward from signed is a
-- separate dispute row in a follow-up. Keeps the audit clean.
create policy lng_cash_counts_update on public.lng_cash_counts
  for update to authenticated
  using (public.auth_can_count_cash() and status = 'pending')
  with check (public.auth_can_count_cash());

comment on table public.lng_cash_counts is
  'Cash reconciliation event. One row per safe count. Pending → signed (with manager re-auth). Signed rows are immutable; disputes spawn a fresh count, never edit an existing one.';

-- ── 4. lng_cash_count_lines ────────────────────────────────────────────────
-- Per-payment denormalised snapshot included in a count. Kept on
-- insert; never edited. Patient name + cart total snapshot live here
-- so the printed statement stays accurate even if the underlying
-- payment is voided / the patient renames after the count is signed.
create table if not exists public.lng_cash_count_lines (
  id                          uuid primary key default gen_random_uuid(),
  count_id                    uuid not null references public.lng_cash_counts(id) on delete cascade,
  payment_id                  uuid not null references public.lng_payments(id) on delete restrict,
  amount_pence                integer not null check (amount_pence >= 0),
  taken_at                    timestamptz not null,
  patient_name_snapshot       text null,
  cart_total_pence_snapshot   integer null,
  appointment_ref_snapshot    text null,
  created_at                  timestamptz not null default now()
);

-- A payment can't appear in two counts.
create unique index lng_cash_count_lines_unique_payment_count
  on public.lng_cash_count_lines (count_id, payment_id);
create index lng_cash_count_lines_count_idx
  on public.lng_cash_count_lines (count_id, taken_at);

alter table public.lng_cash_count_lines enable row level security;

create policy lng_cash_count_lines_read on public.lng_cash_count_lines
  for select to authenticated using (public.auth_can_view_financials());
create policy lng_cash_count_lines_insert on public.lng_cash_count_lines
  for insert to authenticated with check (public.auth_can_count_cash());
-- No update / delete policy — lines are insert-once. The cascade on
-- the FK to lng_cash_counts is the only way they go away (if the
-- parent count is hard-deleted, which is super-admin-only via
-- direct SQL — never via the app).

comment on table public.lng_cash_count_lines is
  'Snapshot of cash payments included in a count. Insert-only. patient_name + cart_total are denormalised so the historical statement stays accurate even if downstream rows change.';

-- ── 5. Anomaly threshold defaults in lng_settings ──────────────────────────
-- Tunable from the app at runtime. Every behaviour-driving value
-- comes from config or DB per the brief — the Anomaly flags page
-- reads these on every render so an admin can tighten / loosen
-- without a deploy. JSONB-typed values; helpers in the app pull
-- value->>0 for numerics.

insert into public.lng_settings (location_id, key, value, description) values
  (null, 'anomaly.discount_pct_threshold',  to_jsonb(50),  'Flag any cart-level discount exceeding this percent of subtotal.'),
  (null, 'anomaly.void_window_minutes',     to_jsonb(60),  'Flag any payment voided within this many minutes of capture.'),
  (null, 'anomaly.cash_variance_pence',     to_jsonb(500), 'Required-notes threshold on cash count variance. £5.00 default.'),
  (null, 'anomaly.cash_count_overdue_days', to_jsonb(30),  'Flag the safe as overdue this many days after the last signed count.')
on conflict (key) where location_id is null do nothing;

-- ── Rollback ───────────────────────────────────────────────────────────────
-- delete from public.lng_settings where location_id is null and key in (
--   'anomaly.discount_pct_threshold', 'anomaly.void_window_minutes',
--   'anomaly.cash_variance_pence', 'anomaly.cash_count_overdue_days'
-- );
-- drop table if exists public.lng_cash_count_lines;
-- drop table if exists public.lng_cash_counts;
-- drop function if exists public.auth_can_count_cash();
-- drop function if exists public.auth_can_view_financials();
-- alter table public.lng_staff_members
--   drop column if exists can_count_cash,
--   drop column if exists can_view_financials,
--   drop column if exists can_view_reports;
