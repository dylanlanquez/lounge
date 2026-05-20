-- 20260520000011_lng_admin_reset_mfa_rpc.sql
--
-- SECURITY DEFINER function that lets the lng-reset-2fa edge
-- function purge every enrolled MFA factor for a target auth user.
-- Replaces the previous approach (admin.schema('auth').from(
-- 'mfa_factors').delete()) which fails at runtime because PostgREST
-- only exposes the schemas listed in db.schemas (public + a couple
-- of others by default); auth is not in that list, so the delete
-- returns a non-2xx and the admin sees "Could not reset 2FA. Edge
-- Function returned a non-2xx status code".
--
-- Gating: the function checks auth_is_lng_admin() so a non-admin
-- caller cannot mass-purge other users' MFA factors even though
-- SECURITY DEFINER lifts the caller's effective privileges. Returns
-- the number of factors removed so the UI can show a meaningful
-- success message.
--
-- The caller is the user_jwt the edge function received (not the
-- service role) — service-role calls bypass auth.uid() so they'd
-- be rejected by auth_is_lng_admin. To make this callable from the
-- edge function, the edge function creates a user-scoped client
-- with the bearer JWT and invokes the RPC there.

create or replace function public.lng_admin_reset_mfa(
  p_target_auth_user_id uuid
) returns integer
language plpgsql
security definer
set search_path = public, pg_catalog, auth
as $$
declare
  v_removed integer;
begin
  if p_target_auth_user_id is null then
    raise exception 'p_target_auth_user_id required';
  end if;

  -- Caller must be an active Lounge admin. auth_is_lng_admin checks
  -- lng_staff_members.is_admin where status='active' for auth.uid().
  if not public.auth_is_lng_admin() then
    raise exception 'Lounge admin only' using errcode = '42501';
  end if;

  delete from auth.mfa_factors
   where user_id = p_target_auth_user_id;
  get diagnostics v_removed = row_count;

  return v_removed;
end;
$$;

revoke all on function public.lng_admin_reset_mfa(uuid) from public;
grant execute on function public.lng_admin_reset_mfa(uuid) to authenticated;

comment on function public.lng_admin_reset_mfa(uuid) is
  'Deletes every auth.mfa_factors row for the target user. SECURITY DEFINER so the caller (admin JWT) can reach into the auth schema. Self-gated via auth_is_lng_admin so non-admin callers cannot purge factors.';

notify pgrst, 'reload schema';
