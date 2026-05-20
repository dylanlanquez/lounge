-- 20260520000005_lng_record_staff_sign_in_rpc.sql
--
-- RPC the AuthProvider calls on every SIGNED_IN event so the Admin
-- Staff tab can surface "last active". SECURITY DEFINER because the
-- staff member needs to write to their own row's last_sign_in_at,
-- which is otherwise locked down by RLS to admins only — and we
-- want the write to happen without giving every authenticated user
-- a general write grant on lng_staff_members.
--
-- The function looks up the caller's account_id via auth.uid() and
-- updates ONLY their row. Idempotent. Fire-and-forget on the
-- client; a failure here must never block sign-in.

create or replace function public.lng_record_staff_sign_in()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- auth.uid() returns null for unauthenticated callers; we exit
  -- quietly rather than erroring so the client-side fire-and-forget
  -- doesn't surface a confusing log line.
  if auth.uid() is null then
    return;
  end if;

  update public.lng_staff_members
     set last_sign_in_at = now()
   where account_id = (
     select id from public.accounts where auth_user_id = auth.uid()
   );
end$$;

comment on function public.lng_record_staff_sign_in() is
  'Bumps lng_staff_members.last_sign_in_at = now() for the calling auth.uid(). Called fire-and-forget by the AuthProvider on SIGNED_IN events. Surfaces as the "Last active" timestamp in Admin > Staff.';

grant execute on function public.lng_record_staff_sign_in() to authenticated;
