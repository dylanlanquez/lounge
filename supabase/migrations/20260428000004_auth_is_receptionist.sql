-- 20260428_04_auth_is_receptionist.sql
-- Helper function used by RLS policies on lng_* tables.
-- Returns true iff the calling user has an active location_members row with
-- lab_role = 'receptionist'.
--
-- Pairs with the existing is_admin() and auth_location_id() helpers.
--
-- Rollback: DROP FUNCTION public.auth_is_receptionist();

create or replace function public.auth_is_receptionist()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from public.location_members lm
      join public.accounts a on a.id = lm.account_id
     where a.auth_user_id = auth.uid()
       and lm.lab_role = 'receptionist'
       and lm.status = 'active'
  );
$$;

comment on function public.auth_is_receptionist() is
  'True if the current user has an active location_members row with lab_role = receptionist. Used in RLS for lng_* tables.';
