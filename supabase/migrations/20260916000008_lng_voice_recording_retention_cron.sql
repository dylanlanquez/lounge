-- 20260916000008_lng_voice_recording_retention_cron.sql
--
-- Daily pg_cron entry point for voice-recording-retention-sweep,
-- same shape as 20260528000001_lng_meet_attendance_sweep_cron.sql's
-- lng_run_meet_attendance_sweep: reads the shared vault service-role
-- key, POSTs to the edge function as a Bearer credential. Daily is
-- enough for a retention sweep — this isn't chasing a live-data race
-- the way the 5-minute Meet-attendance cadence was.
--
-- Rollback:
--   select cron.unschedule('lng-voice-recording-retention-daily');
--   drop function public.lng_run_voice_recording_retention_sweep();

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.lng_run_voice_recording_retention_sweep()
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
  v_url := 'https://npuvhxakffxqoszytkxw.supabase.co/functions/v1/voice-recording-retention-sweep';

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

revoke all on function public.lng_run_voice_recording_retention_sweep() from public;

comment on function public.lng_run_voice_recording_retention_sweep() is
  'pg_cron entry point for the daily voice call recording/transcript retention sweep. Reads vault.lng_service_role_key, POSTs to voice-recording-retention-sweep edge function. Scheduled daily by lng-voice-recording-retention-daily. Only matters once voice_call.recording_enabled is turned on — until then there is nothing for it to find.';

select cron.unschedule('lng-voice-recording-retention-daily')
where exists (
  select 1 from cron.job where jobname = 'lng-voice-recording-retention-daily'
);

select cron.schedule(
  'lng-voice-recording-retention-daily',
  '0 3 * * *',
  $$ select public.lng_run_voice_recording_retention_sweep() $$
);
