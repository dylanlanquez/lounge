-- 20260513000005_lng_staff_admin_page_access.sql
--
-- Per-page admin access on lng_staff_members.
--
-- Until now the Admin tab was binary: `is_admin = true` meant "see
-- everything"; everyone else was blocked at the /admin gate. That
-- breaks down for staff who legitimately need one admin surface
-- (e.g. a manager who curates the Booking types catalogue) but
-- absolutely no business with Stripe payments, Failures, or Receipts.
--
-- This migration adds `admin_page_access` — a JSONB array of admin tab
-- keys (e.g. ['emails', 'branding']) granting access to specific admin
-- pages without granting full admin. The Admin gate becomes:
--
--   is_super_admin            → every tab
--   is_admin = true           → every tab (existing full-admin path)
--   admin_page_access non-empty → /admin opens, only the listed tabs are visible
--   otherwise                 → redirect away (current behaviour)
--
-- Stored as JSONB rather than 16+ boolean columns because the admin
-- tab list churns (we add new ones — Booking types, Resources,
-- Receipts have all landed in the last few weeks). A junction table
-- would mean a row per (staff, page) and an extra round-trip; a JSONB
-- array on the existing row keeps the read profile identical to the
-- other permission flags.
--
-- The app validates keys against the canonical ADMIN_TABS const in
-- src/routes/Admin.tsx; we don't enforce a CHECK constraint here so
-- that adding a new admin tab doesn't require a follow-up migration.
--
-- Rollback:
--   alter table public.lng_staff_members drop column admin_page_access;

alter table public.lng_staff_members
  add column if not exists admin_page_access jsonb not null default '[]'::jsonb;

-- Defensive: any row that somehow lands with NULL gets coerced to an
-- empty array so the app can treat the column as always-an-array.
update public.lng_staff_members
   set admin_page_access = '[]'::jsonb
 where admin_page_access is null;

-- Shape guard: must be a JSON array. Stops a typo from writing an
-- object or a scalar in here and breaking every read.
alter table public.lng_staff_members
  drop constraint if exists lng_staff_members_admin_page_access_is_array;
alter table public.lng_staff_members
  add constraint lng_staff_members_admin_page_access_is_array
    check (jsonb_typeof(admin_page_access) = 'array');

comment on column public.lng_staff_members.admin_page_access is
  'JSONB array of admin tab keys this staff member can open (e.g. ["emails","branding"]). Empty array = no per-page grants. Only consulted when is_admin = false; full admins see every tab regardless. Valid keys live in ADMIN_TABS in src/routes/Admin.tsx — no CHECK here so the list can churn without migrations.';
