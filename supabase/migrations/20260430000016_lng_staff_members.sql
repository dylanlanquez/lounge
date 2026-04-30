-- 20260430000016_lng_staff_members.sql
--
-- Lounge-side staff registry. One row per staff member who works at
-- the clinic; FK'd to public.accounts.id (the shared identity table
-- Meridian also reads). Existence of a row = "this account works at
-- Lounge". Non-existence = no Lounge access — Meridian-only people
-- (Omar in CAD Egypt, the lab team, dental practices, etc.) never
-- appear on the Lounge Staff tab and never see the till's till.
--
-- Why a separate table rather than columns on accounts:
--
--   • Lounge and Meridian share `accounts` for identity (name, login
--     email, auth_user_id) but every operational concept beyond
--     identity belongs to one app or the other. This is the same
--     pattern the brief mandates with the lng_ prefix: lng_visits,
--     lng_carts, lng_terminal_readers, lng_appointments — each is a
--     Lounge-side surface that joins to accounts/patients for shared
--     identity but owns its own row shape.
--
--   • Demoting a Lounge admin must NOT demote a Meridian admin. The
--     previous model used `account_types` containing 'admin', which
--     Meridian's is_admin() also reads. With this table the two
--     concerns are fully decoupled.
--
--   • Future Lounge-specific staff fields (location, hire date,
--     payroll later, per-location permissions) can land here without
--     polluting the shared accounts table.
--
-- Three boolean / scalar fields drive the UX:
--
--   • is_admin  — can open the Admin tab in Lounge. Replaces the
--                 previous account_types-contains-'admin' check.
--   • is_manager — can authorise discounts and voids. Replaces
--                 accounts.is_manager (column dropped at the bottom).
--   • status    — 'active' or 'inactive'. Soft-delete: deactivating
--                 a staff member preserves every signature, payment,
--                 audit row their account ever touched (legally
--                 required) and just stops them appearing in the
--                 active list and signing in to Lounge.
--
-- Backfill seeds Beth (clinic admin), Dylan Lane (super admin), and
-- Cameron (existing manager from the void/discount flow) so the
-- Lounge Staff tab still reads the same set of names after this
-- ships. Future staff are added via the new Add staff sheet.
--
-- Rollback at the bottom.

-- ── Table ──────────────────────────────────────────────────────────────────
create table if not exists public.lng_staff_members (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null unique references public.accounts(id) on delete restrict,
  is_admin        boolean not null default false,
  is_manager      boolean not null default false,
  location_id     uuid references public.locations(id) on delete set null,
  status          text not null default 'active'
                    check (status in ('active', 'inactive')),
  hired_at        timestamptz not null default now(),
  deactivated_at  timestamptz,
  deactivated_by  uuid references public.accounts(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Status + deactivated_at move together: an active row has
-- deactivated_at IS NULL; an inactive row has it populated.
alter table public.lng_staff_members
  add constraint lng_staff_members_status_pair
  check (
    (status = 'active'   and deactivated_at is null)
    or
    (status = 'inactive' and deactivated_at is not null)
  );

create index if not exists lng_staff_members_status_idx
  on public.lng_staff_members (status);
create index if not exists lng_staff_members_admin_idx
  on public.lng_staff_members (is_admin) where status = 'active';
create index if not exists lng_staff_members_manager_idx
  on public.lng_staff_members (is_manager) where status = 'active';

create trigger lng_staff_members_set_updated_at
  before update on public.lng_staff_members
  for each row execute function public.touch_updated_at();

alter table public.lng_staff_members enable row level security;

-- Read: any signed-in user can list the staff (the cashier needs to
-- see the manager dropdown when applying a discount). Admin
-- behaviour is gated client-side; data confidentiality is light here
-- since these rows only describe who works at the clinic and what
-- their two flags are, not anything patient-axis.
create policy lng_staff_members_read on public.lng_staff_members
  for select to authenticated using (true);

-- Write: gated to admins. A normal receptionist cannot promote
-- themselves or invite new staff; only an existing admin can add /
-- remove rows. The super admin (dylan@lanquez.com) ultimately
-- controls who is_admin via the UI gate, layered on top of this.
create policy lng_staff_members_write on public.lng_staff_members
  for all to authenticated
  using (
    exists (
      select 1 from public.lng_staff_members me
      join public.accounts a on a.id = me.account_id
      where a.auth_user_id = auth.uid()
        and me.is_admin = true
        and me.status = 'active'
    )
  )
  with check (
    exists (
      select 1 from public.lng_staff_members me
      join public.accounts a on a.id = me.account_id
      where a.auth_user_id = auth.uid()
        and me.is_admin = true
        and me.status = 'active'
    )
  );

-- ── Backfill ───────────────────────────────────────────────────────────────
-- Seed the three accounts that already existed under the old model:
--   • Beth Mackay (info@venneir.com)        → admin + manager
--   • Dylan Lane (dylan@lanquez.com)         → admin + manager (super)
--   • Cameron Docherty (dylan@venneir.com)   → manager only
-- Idempotent via ON CONFLICT — re-running the migration leaves
-- existing rows untouched.

insert into public.lng_staff_members (account_id, is_admin, is_manager)
select id,
       login_email in ('info@venneir.com', 'dylan@lanquez.com'),
       coalesce(is_manager, false)
       or login_email in ('info@venneir.com', 'dylan@lanquez.com')
  from public.accounts
 where login_email in ('info@venneir.com', 'dylan@lanquez.com', 'dylan@venneir.com')
on conflict (account_id) do nothing;

-- ── Drop accounts.is_manager (now lives on lng_staff_members) ──────────────
-- Read paths in the app code change in the same shipping unit; any
-- missed reader will fail loudly with "column does not exist" rather
-- than silently return stale data, which is the preferred trade.
alter table public.accounts drop column if exists is_manager;

comment on table public.lng_staff_members is
  'Lounge staff registry. One row per staff member who works at the clinic. Existence = active Lounge access; non-existence = none. Replaces the old accounts.is_manager column + the account_types-contains-admin check; those touched the shared identity table and bled across to Meridian.';
comment on column public.lng_staff_members.is_admin is
  'Lounge admin flag. Gates the Admin tab and Settings entry points. Independent of Meridian admin (account_types contains admin).';
comment on column public.lng_staff_members.is_manager is
  'Authorises discounts and voids. Manager re-enters their password when signing off; the dropdown alone is insufficient.';
comment on column public.lng_staff_members.status is
  'Soft-delete flag. Inactive staff cannot sign in to Lounge but their attribution on every signature/payment/audit row is preserved.';

-- ── Rollback ───────────────────────────────────────────────────────────────
-- alter table public.accounts add column if not exists is_manager boolean not null default false;
-- update public.accounts a set is_manager = sm.is_manager
--   from public.lng_staff_members sm
--  where sm.account_id = a.id;
-- drop table if exists public.lng_staff_members;
