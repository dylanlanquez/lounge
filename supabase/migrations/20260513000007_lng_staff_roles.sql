-- 20260513000007_lng_staff_roles.sql
--
-- Job titles for Lounge staff.
--
-- Until now the only labels on a staff member were the permission
-- flags (Admin, Manager, can_view_reports etc.). Those describe what
-- the system *lets* a person do, not what they actually *do* day to
-- day. A receptionist and a hygienist might both have identical
-- permissions but they're different jobs, and the difference matters
-- for filtering ("show me all the dental nurses"), attribution
-- context, and onboarding ("Sarah is starting Monday as a treatment
-- coordinator").
--
-- Modelled as a curated lookup table rather than a free-text column
-- or a baked-in enum because:
--   • Free-text drifts ("Receptionist" vs "receptionist" vs
--     "Front of house") and breaks filtering.
--   • A baked-in enum needs a code change every time the clinic adds
--     a role — wrong axis of ownership.
--   • A lookup table gives admin-editable names, descriptions, and a
--     stable surrogate key so renaming "Receptionist" → "Front of
--     house" doesn't orphan staff rows or break audit trails.
--
-- Single-role-per-staff for v1: lng_staff_members.role_id is a
-- nullable FK. If a clinic wants someone tagged as both Receptionist
-- and Treatment Coordinator, we add a junction table later — easy to
-- migrate by copying role_id into the junction and dropping the
-- column. YAGNI for now.
--
-- ── Privacy / RLS ──────────────────────────────────────────────────
-- All staff can SELECT the role catalogue (the Staff list shows role
-- pills to everyone with admin access; the dropdown in the Manage
-- sheet needs the list to render). Only admins can mutate.
--
-- Rollback:
--   alter table public.lng_staff_members drop column role_id;
--   drop policy if exists lng_staff_roles_admin_write on public.lng_staff_roles;
--   drop policy if exists lng_staff_roles_read on public.lng_staff_roles;
--   drop trigger if exists lng_staff_roles_set_updated_at on public.lng_staff_roles;
--   drop table if exists public.lng_staff_roles;

create table if not exists public.lng_staff_roles (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  description  text,
  -- Display ordering on the role management list. Lower comes first.
  sort_order   int not null default 0,
  -- Soft-archive rather than delete so existing staff_members.role_id
  -- references keep resolving. Archived roles disappear from the
  -- assignment dropdown but stay readable on past assignments.
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Case-insensitive uniqueness on active roles. Two archived rows can
-- share a name (you renamed "Receptionist" and later created a fresh
-- "Receptionist" — the old one stays around for attribution); two
-- active rows cannot, to keep the dropdown unambiguous.
create unique index if not exists lng_staff_roles_active_name_unique
  on public.lng_staff_roles (lower(name))
  where archived_at is null;

create index if not exists lng_staff_roles_sort_idx
  on public.lng_staff_roles (sort_order, name)
  where archived_at is null;

create trigger lng_staff_roles_set_updated_at
  before update on public.lng_staff_roles
  for each row execute function public.touch_updated_at();

alter table public.lng_staff_roles enable row level security;

create policy lng_staff_roles_read
  on public.lng_staff_roles
  for select to authenticated using (true);

create policy lng_staff_roles_admin_write
  on public.lng_staff_roles
  for all to authenticated
  using (public.auth_is_lng_admin() or public.auth_is_super_admin())
  with check (public.auth_is_lng_admin() or public.auth_is_super_admin());

comment on table public.lng_staff_roles is
  'Curated catalogue of staff job titles (Receptionist, Treatment Coordinator, Hygienist, etc.). Informational — independent of the permission model on lng_staff_members. Admin-editable via Admin > Staff > Manage roles.';

-- ── lng_staff_members.role_id ──────────────────────────────────────
-- on delete set null: archiving (soft-delete) keeps the FK valid, but
-- if a role row is ever hard-deleted the staff row's job title clears
-- rather than the staff row going with it.

alter table public.lng_staff_members
  add column if not exists role_id uuid references public.lng_staff_roles(id) on delete set null;

create index if not exists lng_staff_members_role_idx
  on public.lng_staff_members (role_id)
  where role_id is not null;

comment on column public.lng_staff_members.role_id is
  'FK into lng_staff_roles. Job title for this staff member, independent of admin/manager/page permissions. Nullable — a staff member without a role still works.';
