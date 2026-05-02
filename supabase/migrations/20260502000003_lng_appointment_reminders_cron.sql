-- 20260502000003_lng_appointment_reminders_cron.sql
--
-- Schedules the hourly sweep that calls the
-- send-appointment-reminders edge function. Runs at minute 0 of
-- every hour; the edge function looks at appointments 23-25 hours
-- away from "now" and sends reminders for those that haven't
-- already been notified.
--
-- ── One-time setup the operator needs to do ───────────────────────
--
-- The cron job authenticates against the edge function using the
-- project's service-role key. We don't ship the key in this file
-- (it's a secret). Instead the operator stores it in
-- Supabase Vault, once, via the Dashboard:
--
--   1. Open Supabase Dashboard → Project Settings → Vault.
--   2. Add a new secret named exactly: lng_service_role_key
--      with value = the project's service_role JWT (Project
--      Settings → API → service_role key).
--   3. (Optional) Add a second secret lng_reminders_cron_secret
--      with any random string AND set the same value as the
--      function's LNG_REMINDERS_CRON_SECRET env var; the function
--      accepts either auth path so this is belt-and-braces.
--
-- After the secret is in Vault this migration's cron job will
-- start authenticating successfully on the next hourly tick.
-- Until then the call returns 401 and lng_system_failures records
-- the rejection — visible in Admin → System failures.
--
-- ── Why a SQL helper function ─────────────────────────────────────
--
-- pg_cron schedules a SQL command, not an HTTP call. We wrap the
-- net.http_post + vault lookup in a stable function so the cron
-- definition stays simple and the migration can document the
-- behaviour in one place.
--
-- Rollback:
--   select cron.unschedule('lng-appointment-reminders-hourly');
--   drop function public.lng_run_appointment_reminders_sweep();

-- ── 1. Extensions ─────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── 2. SQL helper function ────────────────────────────────────────
--
-- Reads the service role key from vault and POSTs to the edge
-- function. Returns the request id from pg_net so cron's job_run_details
-- table holds something useful for ops debugging.
--
-- SECURITY DEFINER because the cron user (postgres) might not have
-- direct vault read access on every project setup. The function is
-- locked down to only callable by superuser-equivalent + cron.

create or replace function public.lng_run_appointment_reminders_sweep()
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
  v_url := 'https://npuvhxakffxqoszytkxw.supabase.co/functions/v1/send-appointment-reminders';

  -- Pull the service role JWT from vault. If it's missing the
  -- request still goes out but the edge function rejects it; that
  -- failure surfaces in lng_system_failures and the operator
  -- knows to populate the secret.
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

revoke all on function public.lng_run_appointment_reminders_sweep() from public;

comment on function public.lng_run_appointment_reminders_sweep() is
  'pg_cron entry point for the 24h-before reminder sweep. Reads vault.lng_service_role_key for auth, POSTs to send-appointment-reminders edge function. Scheduled hourly at :00 by lng-appointment-reminders-hourly.';

-- ── 3. Schedule ──────────────────────────────────────────────────

-- Unschedule any existing job with the same name so re-running this
-- migration is idempotent.
select cron.unschedule('lng-appointment-reminders-hourly')
where exists (
  select 1 from cron.job where jobname = 'lng-appointment-reminders-hourly'
);

select cron.schedule(
  'lng-appointment-reminders-hourly',
  '0 * * * *', -- every hour at :00
  $$ select public.lng_run_appointment_reminders_sweep() $$
);
