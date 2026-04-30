-- 20260430000017_lng_staff_members_rls_fix.sql
--
-- Hot-fix for the lng_staff_members write policy. The original
-- policy in 20260430000016 inlined an EXISTS subquery against
-- lng_staff_members to check admin membership, which Postgres can't
-- evaluate without re-applying the same RLS policy — infinite
-- recursion at evaluation time.
--
-- Symptom: any read from the Staff tab failed with
--   "infinite recursion detected in policy for relation
--    lng_staff_members".
--
-- Fix: extract the admin check into a SECURITY DEFINER function
-- (auth_is_lng_admin) that bypasses RLS for its inner lookup. The
-- policy then calls the function, which is a single boolean return —
-- no recursion. Same pattern Meridian uses for public.is_admin() on
-- accounts.

create or replace function public.auth_is_lng_admin()
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
       and sm.is_admin = true
       and sm.status = 'active'
  );
$$;

revoke all on function public.auth_is_lng_admin() from public;
grant execute on function public.auth_is_lng_admin() to authenticated;

comment on function public.auth_is_lng_admin() is
  'True when the calling auth user maps to an active Lounge staff member with is_admin = true. SECURITY DEFINER so the inner SELECT bypasses RLS and avoids recursion when used inside a policy on lng_staff_members.';

-- Replace the recursive write policy.
drop policy if exists lng_staff_members_write on public.lng_staff_members;

create policy lng_staff_members_write on public.lng_staff_members
  for all to authenticated
  using (public.auth_is_lng_admin())
  with check (public.auth_is_lng_admin());

-- ── Rollback ───────────────────────────────────────────────────────────────
-- drop policy if exists lng_staff_members_write on public.lng_staff_members;
-- drop function if exists public.auth_is_lng_admin();
-- (then re-create the recursive policy from migration 0016 — not recommended)
