-- 20260430000020_lng_super_admin_helper.sql
--
-- Extract the super-admin override into a single SECURITY DEFINER
-- helper instead of inlining the login_email comparison inside every
-- per-permission function. Migration 0019 inlined it inside both
-- auth_can_view_financials and auth_can_count_cash; this consolidates
-- to one place and re-creates the consumers to call it.
--
-- The super admin email lives in app code as a constant
-- (SUPER_ADMIN_EMAIL in lib/queries/currentAccount.ts) AND in this
-- function. Both must change together if the operator is ever
-- rotated. A future cleanup could move the value into lng_settings
-- so both read from there; deferred for now to keep this migration
-- a pure refactor.

create or replace function public.auth_is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.accounts a
     where a.auth_user_id = auth.uid()
       and a.login_email = 'dylan@lanquez.com'
  );
$$;

revoke all on function public.auth_is_super_admin() from public;
grant execute on function public.auth_is_super_admin() to authenticated;

comment on function public.auth_is_super_admin() is
  'True when the calling auth user is the super admin (login_email = dylan@lanquez.com). SECURITY DEFINER bypasses RLS for the inner SELECT so other policy helpers can call it without recursing.';

-- Re-create the two consumers to use the helper. Same observable
-- behaviour as before; the inlined email check just becomes
-- `auth_is_super_admin() or ...` so the email lives in one place.

create or replace function public.auth_can_view_financials()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.auth_is_super_admin() or exists (
    select 1
      from public.lng_staff_members sm
      join public.accounts a on a.id = sm.account_id
     where a.auth_user_id = auth.uid()
       and sm.status = 'active'
       and sm.can_view_financials = true
  );
$$;

create or replace function public.auth_can_count_cash()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.auth_is_super_admin() or exists (
    select 1
      from public.lng_staff_members sm
      join public.accounts a on a.id = sm.account_id
     where a.auth_user_id = auth.uid()
       and sm.status = 'active'
       and sm.can_count_cash = true
  );
$$;

-- ── Rollback ───────────────────────────────────────────────────────────────
-- Re-inline the email check inside the two consumer functions and drop
-- the helper. See migration 0019 for the original inlined form.
