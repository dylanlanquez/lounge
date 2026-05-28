-- 20260528000001_lng_meet_attendance_sweep_cron.sql
--
-- Closes the silent-failure hole behind the LAP-00518 incident on
-- 2026-05-28. Google Meet publishes participantSessions AFTER a
-- conference closes, but the in-card 30s poll cut out at end_at and
-- the page-load auto-fetch short-circuited once conference_started_at
-- was set, so nothing in the system pulled the post-meeting publication
-- unless an operator manually clicked Refresh.
--
-- Two pieces:
--
--   1. lng_upsert_meet_attendance_session — race-safe upsert RPC used by
--      both meet-fetch-attendance and the new sweep. The merge clause
--      uses coalesce(EXCLUDED.left_at, existing.left_at) so a still-
--      in-progress read (where Google returned endTime=null for an
--      active session) cannot clobber a completed read from a
--      concurrent caller. Same coalesce semantics on duration_seconds
--      and meet_user_id. is_host uses OR so a host flag, once set,
--      cannot be revoked by a later read that missed the user-id match.
--
--   2. lng_run_meet_attendance_sweep + cron schedule — every 5 minutes,
--      POST to the meet-attendance-sweep edge function using the
--      service-role key from the shared Vault entry. The edge function
--      decides which appointments to walk (window, dedupe, dead-letter
--      guard).
--
-- One-time secrets the operator needs in place:
--
--   • vault.lng_service_role_key — already in production for the SMS
--     and email reminder crons; reused here.
--
-- Rollback:
--   select cron.unschedule('lng-meet-attendance-sweep-5min');
--   drop function public.lng_run_meet_attendance_sweep();
--   drop function public.lng_upsert_meet_attendance_session(
--     uuid, text, text, timestamptz, timestamptz, int, boolean, text
--   );

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1. Race-safe upsert ----------------------------------------------------

create or replace function public.lng_upsert_meet_attendance_session(
  p_appointment_id uuid,
  p_meet_session_name text,
  p_participant_name text,
  p_joined_at timestamptz,
  p_left_at timestamptz,
  p_duration_seconds int,
  p_is_host boolean,
  p_meet_user_id text
) returns void
language sql
security definer
set search_path = public
as $$
  insert into lng_meet_attendance (
    appointment_id,
    meet_session_name,
    participant_name,
    participant_email,
    joined_at,
    left_at,
    duration_seconds,
    is_host,
    meet_user_id
  ) values (
    p_appointment_id,
    p_meet_session_name,
    p_participant_name,
    null,
    p_joined_at,
    p_left_at,
    p_duration_seconds,
    p_is_host,
    p_meet_user_id
  )
  on conflict (appointment_id, meet_session_name) do update
    set participant_name  = excluded.participant_name,
        joined_at         = excluded.joined_at,
        -- Never let a NULL incoming value (still-in-progress session)
        -- clobber a non-null stored value (completed session) from a
        -- concurrent reader.
        left_at           = coalesce(excluded.left_at, lng_meet_attendance.left_at),
        duration_seconds  = coalesce(excluded.duration_seconds, lng_meet_attendance.duration_seconds),
        -- is_host = true is sticky. If any read sees this participant
        -- match a known host user-id, the flag stays true even if a
        -- later read failed to match (e.g. host record temporarily
        -- inactive at the moment of fetch).
        is_host           = lng_meet_attendance.is_host or excluded.is_host,
        meet_user_id      = coalesce(excluded.meet_user_id, lng_meet_attendance.meet_user_id),
        updated_at        = now();
$$;

revoke all on function public.lng_upsert_meet_attendance_session(
  uuid, text, text, timestamptz, timestamptz, int, boolean, text
) from public;

grant execute on function public.lng_upsert_meet_attendance_session(
  uuid, text, text, timestamptz, timestamptz, int, boolean, text
) to service_role;

comment on function public.lng_upsert_meet_attendance_session(
  uuid, text, text, timestamptz, timestamptz, int, boolean, text
) is
  'Race-safe upsert for lng_meet_attendance. Merge clause coalesces left_at and duration_seconds so a still-in-progress read cannot overwrite a completed read with NULL. is_host is sticky via OR. Called by meet-fetch-attendance and meet-attendance-sweep edge functions.';

-- 2. Cron entrypoint -----------------------------------------------------

create or replace function public.lng_run_meet_attendance_sweep()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_key text;
  v_request_id bigint;
begin
  v_url := 'https://npuvhxakffxqoszytkxw.supabase.co/functions/v1/meet-attendance-sweep';

  select decrypted_secret into v_key
    from vault.decrypted_secrets
   where name = 'lng_service_role_key'
   limit 1;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(v_key, '')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.lng_run_meet_attendance_sweep() from public;

comment on function public.lng_run_meet_attendance_sweep() is
  'pg_cron entry point for the 5-minutely Meet attendance sweep. Reads vault.lng_service_role_key, POSTs to meet-attendance-sweep edge function. Scheduled every 5 min by lng-meet-attendance-sweep-5min.';

-- Idempotent re-schedule.
select cron.unschedule('lng-meet-attendance-sweep-5min')
where exists (
  select 1 from cron.job where jobname = 'lng-meet-attendance-sweep-5min'
);

select cron.schedule(
  'lng-meet-attendance-sweep-5min',
  '*/5 * * * *',
  $$ select public.lng_run_meet_attendance_sweep() $$
);
