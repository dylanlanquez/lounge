-- Staff sessions admin surface.
--
-- The Admin "Sessions" tab needs to show, per staff member, where and when
-- they are signed in so an admin can spot a shared/misused account and force a
-- remote sign-out. The source of truth is GoTrue's auth.sessions / auth.users,
-- which is owned by supabase_auth_admin and is NOT exposed through PostgREST.
-- Two SECURITY DEFINER functions (owned by postgres, which holds DELETE on the
-- auth tables) bridge that gap, each gated by auth_is_lng_admin() so only a
-- full Lounge admin can read session state or revoke a session.

-- ---------------------------------------------------------------------------
-- Read: one row per staff member, sessions aggregated as a jsonb array.
-- ---------------------------------------------------------------------------
create or replace function public.lng_admin_staff_sessions()
returns table (
  staff_member_id  uuid,
  account_id       uuid,
  first_name       text,
  last_name        text,
  login_email      text,
  status           text,
  is_admin         boolean,
  is_manager       boolean,
  last_sign_in_at  timestamptz,
  sessions         jsonb
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.auth_is_lng_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return query
    select
      sm.id,
      a.id,
      a.first_name,
      a.last_name,
      a.login_email,
      sm.status,
      sm.is_admin,
      sm.is_manager,
      u.last_sign_in_at,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', s.id,
            'created_at', s.created_at,
            'refreshed_at', s.refreshed_at,
            'not_after', s.not_after,
            'ip', host(s.ip),
            'user_agent', s.user_agent
          )
          order by s.refreshed_at desc nulls last
        ) filter (where s.id is not null),
        '[]'::jsonb
      ) as sessions
    from public.lng_staff_members sm
    join public.accounts a on a.id = sm.account_id
    left join auth.users u on u.id = a.auth_user_id
    left join auth.sessions s on s.user_id = a.auth_user_id
    group by sm.id, a.id, a.first_name, a.last_name, a.login_email,
             sm.status, sm.is_admin, sm.is_manager, u.last_sign_in_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Force logout: revoke every server-side session for one staff member.
-- Deleting auth.sessions cascades to auth.refresh_tokens (FK on delete
-- cascade); we also sweep any session-less refresh tokens by user_id so the
-- account cannot mint a new access token. Returns the session count removed.
-- ---------------------------------------------------------------------------
create or replace function public.lng_admin_force_logout(p_staff_member_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_target_auth_id uuid;
  v_target_email   text;
  v_sessions_killed integer := 0;
begin
  if not public.auth_is_lng_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select a.auth_user_id, a.login_email
    into v_target_auth_id, v_target_email
    from public.lng_staff_members sm
    join public.accounts a on a.id = sm.account_id
   where sm.id = p_staff_member_id;

  if v_target_auth_id is null then
    raise exception 'staff member not found or has no auth account'
      using errcode = 'P0002';
  end if;

  -- Session-less legacy tokens (no FK cascade reaches these).
  delete from auth.refresh_tokens
   where user_id = v_target_auth_id::text;

  with gone as (
    delete from auth.sessions
     where user_id = v_target_auth_id
     returning 1
  )
  select count(*) into v_sessions_killed from gone;

  -- Loud audit trail. Definer context can write the event log.
  insert into public.lng_event_log (source, event_type, account_id, payload)
  values (
    'lng_admin_force_logout',
    'staff_session_revoked',
    public.auth_account_id(),
    jsonb_build_object(
      'target_staff_member_id', p_staff_member_id,
      'target_email', v_target_email,
      'sessions_killed', v_sessions_killed
    )
  );

  return v_sessions_killed;
end;
$$;

revoke all on function public.lng_admin_staff_sessions() from public, anon;
revoke all on function public.lng_admin_force_logout(uuid) from public, anon;
grant execute on function public.lng_admin_staff_sessions() to authenticated;
grant execute on function public.lng_admin_force_logout(uuid) to authenticated;
