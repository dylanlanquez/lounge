-- 20260605000001_lng_cron_watchdog.sql
--
-- Closes the silent-failure hole behind the 2026-06-05 incident: three
-- scheduled jobs were deleted from cron.job during ~11 May maintenance and
-- nothing noticed for 3.5 weeks. shopify_orders froze (patients showed "No
-- Shopify orders"), and EMAIL appointment reminders silently stopped while
-- the templates stayed enabled. No monitoring existed to catch a sweep that
-- stops firing.
--
-- This adds a watchdog that checks every critical pg_cron job on a schedule
-- and raises a loud, self-resolving lng_system_failures row the moment one
-- goes missing or stale. An external dead-man's-switch (healthchecks.io,
-- URL in lng_settings) covers the watchdog watching itself.
--
-- Pieces:
--   1. lng_cron_watchdog_expectations  — config: which jobs to watch + the
--      max time each may go without a successful run before we alarm.
--   2. lng_run_cron_watchdog()         — the checker, scheduled every 15 min.
--      Opens a critical lng_system_failures row for any missing/stale job and
--      auto-resolves it when the job recovers. Pings the dead-man's-switch.
--   3. lng_cron_health()               — read API for the Admin > System
--      health panel (clients cannot read the cron schema directly).
--   4. cron job lng-cron-watchdog.
--   5. Version-controls the schedules restored on 2026-06-05 (Shopify orders
--      sync + email reminders) so the cron setup finally lives in git.
--
-- Note on "successful run": we key off cron.job_run_details.status =
-- 'succeeded', i.e. the cron COMMAND ran. The sweeps fire net.http_post
-- asynchronously, so this reliably catches a deleted / non-firing job (the
-- 11 May failure mode) but not a job that fires yet whose edge function
-- later errors. Downstream-failure detection is a deliberate future add.
--
-- One-time secrets / config the operator needs in place:
--   • vault.lng_service_role_key — already in production; reused.
--   • lng_settings key 'cron_watchdog_healthcheck_url' (global, location_id
--     null) — the healthchecks.io ping URL. Until set, the heartbeat is
--     skipped silently; the in-DB checks still run.
--
-- Rollback:
--   select cron.unschedule('lng-cron-watchdog');
--   drop function public.lng_cron_health();
--   drop function public.lng_run_cron_watchdog();
--   drop table public.lng_cron_watchdog_expectations;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1. Expectations (config) ----------------------------------------------

create table if not exists public.lng_cron_watchdog_expectations (
  id            uuid primary key default gen_random_uuid(),
  jobname       text not null unique,
  description   text not null,
  max_staleness interval not null,
  must_exist    boolean not null default true,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now()
);

comment on table public.lng_cron_watchdog_expectations is
  'Allow-list of critical pg_cron jobs the watchdog monitors, with the max time each may go without a successful run before lng_run_cron_watchdog() raises a failure. Add a row to cover a new sweep; no code change needed.';

-- Internal config table: no client access. The watchdog + health RPC are
-- SECURITY DEFINER (owner postgres) and bypass RLS as table owner.
alter table public.lng_cron_watchdog_expectations enable row level security;

insert into public.lng_cron_watchdog_expectations (jobname, description, max_staleness, must_exist, enabled)
values
  ('sync-shopify-orders-daily',            'Shopify orders sync (daily 06:00 UTC)', interval '30 hours',   true, true),
  ('lng-appointment-reminders-hourly',     'Email appointment reminders (hourly)',  interval '150 minutes', true, true),
  ('lng-appointment-sms-reminders-hourly', 'SMS appointment reminders (hourly)',    interval '150 minutes', true, true),
  ('lng-meet-attendance-sweep-5min',       'Google Meet attendance sweep (5 min)',  interval '20 minutes',  true, true)
on conflict (jobname) do update
  set description   = excluded.description,
      max_staleness = excluded.max_staleness,
      must_exist    = excluded.must_exist,
      enabled       = excluded.enabled;

-- 2. Watchdog checker ----------------------------------------------------

create or replace function public.lng_run_cron_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e             record;
  v_exists      boolean;
  v_last        timestamptz;
  v_status      text;
  v_checked     int := 0;
  v_problems    int := 0;
  v_msg         text;
  v_hc_url      text;
begin
  for e in
    select jobname, description, max_staleness, must_exist, created_at
    from public.lng_cron_watchdog_expectations
    where enabled
  loop
    v_checked := v_checked + 1;

    select exists (select 1 from cron.job j where j.jobname = e.jobname)
      into v_exists;

    -- Most recent SUCCESSFUL run of the currently-scheduled job of this
    -- name. If the job was deleted the join yields nothing -> v_last null.
    select max(d.start_time)
      into v_last
      from cron.job_run_details d
      join cron.job j on j.jobid = d.jobid
     where j.jobname = e.jobname
       and d.status = 'succeeded';

    -- 'pending' = exists but no successful run yet AND we have not been
    -- watching longer than its staleness window (a just-scheduled job has
    -- no run history until its first fire). Not a problem; avoids a false
    -- alarm the moment a job is added.
    if e.must_exist and not v_exists then
      v_status := 'missing';
    elsif v_last is not null and v_last < now() - e.max_staleness then
      v_status := 'stale';
    elsif v_last is null and e.created_at < now() - e.max_staleness then
      v_status := 'stale';
    elsif v_last is null then
      v_status := 'pending';
    else
      v_status := 'healthy';
    end if;

    if v_status in ('healthy', 'pending') then
      -- Self-resolve any open watchdog alert for this job.
      update public.lng_system_failures
         set resolved_at = now(),
             resolution_notes = 'Auto-resolved: scheduled job "' || e.jobname || '" healthy again.'
       where source = 'cron_watchdog'
         and resolved_at is null
         and context ->> 'jobname' = e.jobname;
    else
      v_problems := v_problems + 1;
      v_msg := case v_status
        when 'missing' then
          'Scheduled job "' || e.jobname || '" is missing from cron.job (deleted or never created).'
        else
          'Scheduled job "' || e.jobname || '" has not run successfully within ' ||
          e.max_staleness::text || ' (last success: ' || coalesce(v_last::text, 'never') || ').'
      end;

      if exists (
        select 1 from public.lng_system_failures
        where source = 'cron_watchdog'
          and resolved_at is null
          and context ->> 'jobname' = e.jobname
      ) then
        -- Refresh the open row rather than spawn duplicates each tick.
        update public.lng_system_failures
           set message = v_msg,
               context = jsonb_build_object(
                 'jobname', e.jobname, 'status', v_status,
                 'last_success', v_last, 'description', e.description)
         where source = 'cron_watchdog'
           and resolved_at is null
           and context ->> 'jobname' = e.jobname;
      else
        insert into public.lng_system_failures (source, severity, message, context)
        values ('cron_watchdog', 'critical', v_msg,
                jsonb_build_object(
                  'jobname', e.jobname, 'status', v_status,
                  'last_success', v_last, 'description', e.description));
      end if;
    end if;
  end loop;

  -- Dead-man's-switch heartbeat. If THIS watchdog stops running, the
  -- external monitor stops receiving pings and alerts a human. Skipped
  -- silently until the URL is configured in lng_settings.
  select value #>> '{}'
    into v_hc_url
    from public.lng_settings
   where key = 'cron_watchdog_healthcheck_url'
     and location_id is null
   limit 1;

  if v_hc_url is not null and v_hc_url <> '' then
    perform net.http_post(
      url := v_hc_url,
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('checked', v_checked, 'problems', v_problems),
      timeout_milliseconds := 10000
    );
  end if;

  return jsonb_build_object('checked', v_checked, 'problems', v_problems, 'ran_at', now());
end;
$$;

revoke all on function public.lng_run_cron_watchdog() from public;

comment on function public.lng_run_cron_watchdog() is
  'pg_cron entry point. Checks every enabled lng_cron_watchdog_expectations job for existence + recency of a successful run; opens/auto-resolves a cron_watchdog lng_system_failures row per job and pings the healthchecks.io dead-man''s-switch. Scheduled every 15 min by lng-cron-watchdog.';

-- 3. Read API for the Admin > System health panel -----------------------

create or replace function public.lng_cron_health()
returns table (
  jobname       text,
  description   text,
  enabled       boolean,
  job_exists    boolean,
  last_success  timestamptz,
  max_staleness interval,
  status        text
)
language sql
security definer
set search_path = public
as $$
  select
    e.jobname,
    e.description,
    e.enabled,
    exists (select 1 from cron.job j where j.jobname = e.jobname) as job_exists,
    ls.last_success,
    e.max_staleness,
    case
      when not e.enabled then 'disabled'
      when e.must_exist and not exists (select 1 from cron.job j where j.jobname = e.jobname) then 'missing'
      when ls.last_success is not null and ls.last_success < now() - e.max_staleness then 'stale'
      when ls.last_success is null and e.created_at < now() - e.max_staleness then 'stale'
      when ls.last_success is null then 'pending'
      else 'healthy'
    end as status
  from public.lng_cron_watchdog_expectations e
  left join lateral (
    select max(d.start_time) as last_success
    from cron.job_run_details d
    join cron.job j on j.jobid = d.jobid
    where j.jobname = e.jobname
      and d.status = 'succeeded'
  ) ls on true
  order by e.jobname;
$$;

revoke all on function public.lng_cron_health() from public;
grant execute on function public.lng_cron_health() to authenticated;

comment on function public.lng_cron_health() is
  'Read-only health summary of monitored cron jobs for the Admin > System health panel. Returns per-job existence, last successful run, and derived status (healthy/stale/missing/disabled). No patient data.';

-- 4. Schedule the watchdog ----------------------------------------------

select cron.unschedule('lng-cron-watchdog')
where exists (select 1 from cron.job where jobname = 'lng-cron-watchdog');

select cron.schedule(
  'lng-cron-watchdog',
  '*/15 * * * *',
  $$ select public.lng_run_cron_watchdog() $$
);

-- 5. Version-control the schedules restored on 2026-06-05 ----------------
--    (created live during the incident; captured here so they exist in git
--    and cannot silently vanish unrecorded again).

create or replace function public.lng_run_sync_shopify_orders_sweep()
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
  v_url := 'https://npuvhxakffxqoszytkxw.supabase.co/functions/v1/sync-shopify-orders';

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
    body := '{"mode":"daily"}'::jsonb,
    timeout_milliseconds := 120000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.lng_run_sync_shopify_orders_sweep() from public;

comment on function public.lng_run_sync_shopify_orders_sweep() is
  'pg_cron entry point for the daily Shopify orders sync. Reads vault.lng_service_role_key, POSTs mode=daily to the sync-shopify-orders edge function (7-day look-back). Scheduled by sync-shopify-orders-daily. Restored 2026-06-05 after the external scheduler was lost in ~11 May maintenance.';

select cron.unschedule('sync-shopify-orders-daily')
where exists (select 1 from cron.job where jobname = 'sync-shopify-orders-daily');

select cron.schedule(
  'sync-shopify-orders-daily',
  '0 6 * * *',
  $$ select public.lng_run_sync_shopify_orders_sweep() $$
);

-- lng_run_appointment_reminders_sweep() already exists (pre-dates this
-- migration); only its schedule was lost. Re-assert it idempotently.
select cron.unschedule('lng-appointment-reminders-hourly')
where exists (select 1 from cron.job where jobname = 'lng-appointment-reminders-hourly');

select cron.schedule(
  'lng-appointment-reminders-hourly',
  '0 * * * *',
  $$ select public.lng_run_appointment_reminders_sweep() $$
);
