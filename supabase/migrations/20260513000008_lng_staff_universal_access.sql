-- 20260513000008_lng_staff_universal_access.sql
--
-- Open read+write access on operational Lounge tables to every active
-- lng_staff_member.
--
-- The original RLS model gated everything on `auth_is_receptionist()`
-- — a helper that checks the legacy `location_members` table for a
-- row with `lab_role = 'receptionist'`. The Lounge staff registry
-- (`lng_staff_members`) was introduced later and is the canonical
-- "who can use Lounge" source of truth. Result: a staff member added
-- via Admin > Staff > Add staff member passes the app-level auth gate
-- (they have an active lng_staff_members row → is_lng_staff = true)
-- but every query returns zero rows because RLS still consults the
-- old `location_members` table they're not in.
--
-- Dylan's requirement: every active Lounge staff member sees every
-- booking, visit, walk-in, cart, payment, and receipt — single-clinic
-- model, no per-location segmentation. Admin-only surfaces (managing
-- staff, configuring catalogue, viewing financials) stay gated
-- separately on the existing is_admin and section-access flags
-- already enforced in the app.
--
-- ── Approach ───────────────────────────────────────────────────────
--   1. Add `auth_is_lng_staff()` — true iff caller has an active row
--      in lng_staff_members. SECURITY DEFINER + search_path locked,
--      same pattern as auth_is_lng_admin().
--   2. Drop every `_receptionist_*` policy on Lounge operational
--      tables and replace with `_staff_*` policies that gate on
--      `auth_is_lng_staff() OR auth_is_super_admin()` and drop the
--      `location_id = auth_location_id()` filter.
--   3. Leave `auth_is_receptionist()` itself untouched — other
--      callers (Meridian, edge functions) may still reference it.
--      We just stop using it for Lounge RLS.
--
-- Admin-write policies on these tables stay as they are
-- (`public.is_admin()`); they're additive — admins were already
-- covered, this opens the door wider for plain staff.
--
-- ── Tables touched ─────────────────────────────────────────────────
--   lng_settings              read only (writes stay admin)
--   lng_terminal_readers      read only (writes stay admin)
--   lng_terminal_sessions     read only
--   lng_appointments          read + insert + update
--   lng_walk_ins              read + insert + update
--   lng_visits                read + insert + update
--   lng_carts                 read + insert + update
--   lng_cart_items            full (read/write)
--   lng_payments              read only (writes via service-role)
--   lng_terminal_payments     read only (writes via service-role)
--   lng_receipts              read + insert (insert added 20260506000003)
--   lng_event_log             insert only (self-attributed)
--
-- DELETE policies remain absent intentionally per the original RLS
-- design — Lounge is append-only on patient-axis data.
--
-- Rollback (paste into a fresh migration to revert):
--   drop policy if exists lng_settings_staff_select          on public.lng_settings;
--   drop policy if exists lng_terminal_readers_staff_select   on public.lng_terminal_readers;
--   drop policy if exists lng_terminal_sessions_staff_select  on public.lng_terminal_sessions;
--   drop policy if exists lng_appointments_staff_select       on public.lng_appointments;
--   drop policy if exists lng_appointments_staff_insert       on public.lng_appointments;
--   drop policy if exists lng_appointments_staff_update       on public.lng_appointments;
--   drop policy if exists lng_walk_ins_staff_select           on public.lng_walk_ins;
--   drop policy if exists lng_walk_ins_staff_insert           on public.lng_walk_ins;
--   drop policy if exists lng_walk_ins_staff_update           on public.lng_walk_ins;
--   drop policy if exists lng_visits_staff_select             on public.lng_visits;
--   drop policy if exists lng_visits_staff_insert             on public.lng_visits;
--   drop policy if exists lng_visits_staff_update             on public.lng_visits;
--   drop policy if exists lng_carts_staff_select              on public.lng_carts;
--   drop policy if exists lng_carts_staff_insert              on public.lng_carts;
--   drop policy if exists lng_carts_staff_update              on public.lng_carts;
--   drop policy if exists lng_cart_items_staff_all            on public.lng_cart_items;
--   drop policy if exists lng_payments_staff_select           on public.lng_payments;
--   drop policy if exists lng_terminal_payments_staff_select  on public.lng_terminal_payments;
--   drop policy if exists lng_receipts_staff_select           on public.lng_receipts;
--   drop policy if exists lng_receipts_staff_insert           on public.lng_receipts;
--   drop policy if exists lng_event_log_staff_self_insert     on public.lng_event_log;
--   drop function if exists public.auth_is_lng_staff();
--   (recreate the legacy _receptionist_* policies from
--    20260428000017_lng_rls_policies.sql if needed.)

-- ── 1. auth_is_lng_staff() ─────────────────────────────────────────

create or replace function public.auth_is_lng_staff()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from public.lng_staff_members lsm
      join public.accounts a on a.id = lsm.account_id
     where a.auth_user_id = auth.uid()
       and lsm.status = 'active'
  );
$$;

revoke all on function public.auth_is_lng_staff() from public;
grant execute on function public.auth_is_lng_staff() to authenticated;

comment on function public.auth_is_lng_staff() is
  'True iff the calling user has an active row in lng_staff_members. Used in RLS to gate read/write on operational Lounge tables. SECURITY DEFINER + locked search_path so it can be safely called from policies on tables the caller cannot otherwise SELECT.';

-- ── 2. Drop the legacy _receptionist_* policies on Lounge tables ──
-- All under `drop policy if exists` so re-runs are safe.

drop policy if exists lng_settings_receptionist_select          on public.lng_settings;
drop policy if exists lng_terminal_readers_receptionist_select  on public.lng_terminal_readers;
drop policy if exists lng_terminal_sessions_receptionist_select on public.lng_terminal_sessions;
drop policy if exists lng_appointments_receptionist_select      on public.lng_appointments;
drop policy if exists lng_appointments_receptionist_insert      on public.lng_appointments;
drop policy if exists lng_appointments_receptionist_update      on public.lng_appointments;
drop policy if exists lng_walk_ins_receptionist_select          on public.lng_walk_ins;
drop policy if exists lng_walk_ins_receptionist_insert          on public.lng_walk_ins;
drop policy if exists lng_walk_ins_receptionist_update          on public.lng_walk_ins;
drop policy if exists lng_visits_receptionist_select            on public.lng_visits;
drop policy if exists lng_visits_receptionist_insert            on public.lng_visits;
drop policy if exists lng_visits_receptionist_update            on public.lng_visits;
drop policy if exists lng_carts_receptionist_select             on public.lng_carts;
drop policy if exists lng_carts_receptionist_insert             on public.lng_carts;
drop policy if exists lng_carts_receptionist_update             on public.lng_carts;
drop policy if exists lng_cart_items_receptionist_all           on public.lng_cart_items;
drop policy if exists lng_payments_receptionist_select          on public.lng_payments;
drop policy if exists lng_terminal_payments_receptionist_select on public.lng_terminal_payments;
drop policy if exists lng_receipts_receptionist_select          on public.lng_receipts;
drop policy if exists lng_receipts_receptionist_insert          on public.lng_receipts;
drop policy if exists lng_event_log_receptionist_self_insert    on public.lng_event_log;

-- ── 3. New _staff_* policies — every active Lounge staff member ───
-- Single guard expression used everywhere. Super admin is included so
-- a brand-new install where the staff row isn't yet wired up still
-- works (mirrors the same exemption used in app-side gates).

-- ---------- lng_settings ----------
create policy lng_settings_staff_select
  on public.lng_settings for select
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin());

-- ---------- lng_terminal_readers ----------
create policy lng_terminal_readers_staff_select
  on public.lng_terminal_readers for select
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin());

-- ---------- lng_terminal_sessions ----------
create policy lng_terminal_sessions_staff_select
  on public.lng_terminal_sessions for select
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin());

-- ---------- lng_appointments ----------
create policy lng_appointments_staff_select
  on public.lng_appointments for select
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin());

create policy lng_appointments_staff_insert
  on public.lng_appointments for insert
  to authenticated
  with check (public.auth_is_lng_staff() or public.auth_is_super_admin());

create policy lng_appointments_staff_update
  on public.lng_appointments for update
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin())
  with check (public.auth_is_lng_staff() or public.auth_is_super_admin());

-- ---------- lng_walk_ins ----------
create policy lng_walk_ins_staff_select
  on public.lng_walk_ins for select
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin());

create policy lng_walk_ins_staff_insert
  on public.lng_walk_ins for insert
  to authenticated
  with check (public.auth_is_lng_staff() or public.auth_is_super_admin());

create policy lng_walk_ins_staff_update
  on public.lng_walk_ins for update
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin())
  with check (public.auth_is_lng_staff() or public.auth_is_super_admin());

-- ---------- lng_visits ----------
create policy lng_visits_staff_select
  on public.lng_visits for select
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin());

create policy lng_visits_staff_insert
  on public.lng_visits for insert
  to authenticated
  with check (public.auth_is_lng_staff() or public.auth_is_super_admin());

create policy lng_visits_staff_update
  on public.lng_visits for update
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin())
  with check (public.auth_is_lng_staff() or public.auth_is_super_admin());

-- ---------- lng_carts ----------
create policy lng_carts_staff_select
  on public.lng_carts for select
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin());

create policy lng_carts_staff_insert
  on public.lng_carts for insert
  to authenticated
  with check (public.auth_is_lng_staff() or public.auth_is_super_admin());

create policy lng_carts_staff_update
  on public.lng_carts for update
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin())
  with check (public.auth_is_lng_staff() or public.auth_is_super_admin());

-- ---------- lng_cart_items ----------
create policy lng_cart_items_staff_all
  on public.lng_cart_items for all
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin())
  with check (public.auth_is_lng_staff() or public.auth_is_super_admin());

-- ---------- lng_payments ----------
-- Reads only — inserts/updates flow through service-role-backed edge
-- functions (terminal-start-payment, cash payment recorder).
create policy lng_payments_staff_select
  on public.lng_payments for select
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin());

-- ---------- lng_terminal_payments ----------
create policy lng_terminal_payments_staff_select
  on public.lng_terminal_payments for select
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin());

-- ---------- lng_receipts ----------
create policy lng_receipts_staff_select
  on public.lng_receipts for select
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin());

create policy lng_receipts_staff_insert
  on public.lng_receipts for insert
  to authenticated
  with check (public.auth_is_lng_staff() or public.auth_is_super_admin());

-- ---------- lng_event_log ----------
-- Self-attributed insert only — the staff member can log events
-- against their own account_id, nothing else.
create policy lng_event_log_staff_self_insert
  on public.lng_event_log for insert
  to authenticated
  with check (
    (public.auth_is_lng_staff() or public.auth_is_super_admin())
    and account_id = public.auth_account_id()
  );

-- ── Reload PostgREST schema cache ──────────────────────────────────
-- Policy changes don't strictly need this, but the simultaneous
-- function add does. Cheap to send either way.
notify pgrst, 'reload schema';
