-- 20260506000008_lng_sync_parcel_codes_cron.sql
--
-- Schedules the every-3-minute sweep that calls the
-- sync-parcel-codes edge function. Finds dispatched Lounge visits
-- whose parcel_code is still null, queries Checkpoint's
-- shipping_queue for the DPD code, writes it back to lng_visits
-- (fires Realtime → open visit pages update automatically), then
-- sends the patient dispatch email.
--
-- Rollback:
--   select cron.unschedule('lng-sync-parcel-codes');
--   drop function public.lng_run_sync_parcel_codes();

-- ── 1. Extensions ─────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── 2. SQL helper function ────────────────────────────────────────

create or replace function public.lng_run_sync_parcel_codes()
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
  v_url := 'https://npuvhxakffxqoszytkxw.supabase.co/functions/v1/sync-parcel-codes';

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

revoke all on function public.lng_run_sync_parcel_codes() from public;

comment on function public.lng_run_sync_parcel_codes() is
  'pg_cron entry point for the parcel-code sync sweep. Reads vault.lng_service_role_key for auth, POSTs to sync-parcel-codes edge function. Scheduled every 3 minutes by lng-sync-parcel-codes.';

-- ── 3. Schedule ──────────────────────────────────────────────────

select cron.unschedule('lng-sync-parcel-codes')
where exists (
  select 1 from cron.job where jobname = 'lng-sync-parcel-codes'
);

select cron.schedule(
  'lng-sync-parcel-codes',
  '*/3 * * * *',
  $$ select public.lng_run_sync_parcel_codes() $$
);
