-- 20260516000004_lng_sms_reminders_cron.sql
--
-- Schedules the hourly sweep that POSTs to send-appointment-sms-reminders.
-- Mirrors the email-reminder cron migration (20260502000003) but
-- targets the SMS twin function so the two channels stamp + retry
-- independently.
--
-- One-time secrets the operator needs in place for this to actually
-- send (all already in production at the time of this migration):
--
--   • vault.lng_service_role_key — service-role JWT used to auth the
--     edge-function call. Set via Dashboard → Project Settings →
--     Vault. Shared with the email-reminders cron.
--   • TWILIO_ACCOUNT_SID + TWILIO_MESSAGING_SERVICE_SID — Twilio
--     account + Messaging Service that routes the SMS through the
--     best sender (alphanumeric where supported, long code
--     otherwise).
--   • One of:
--       TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET (scoped, preferred)
--       OR TWILIO_AUTH_TOKEN (master Auth Token, fall-back). The
--     shared helper accepts either pair — see
--     supabase/functions/_shared/twilioSms.ts.
--
-- Rollback:
--   select cron.unschedule('lng-appointment-sms-reminders-hourly');
--   drop function public.lng_run_appointment_sms_reminders_sweep();

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.lng_run_appointment_sms_reminders_sweep()
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
  v_url := 'https://npuvhxakffxqoszytkxw.supabase.co/functions/v1/send-appointment-sms-reminders';

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

revoke all on function public.lng_run_appointment_sms_reminders_sweep() from public;

comment on function public.lng_run_appointment_sms_reminders_sweep() is
  'pg_cron entry point for the 24h-before SMS reminder sweep. Reads vault.lng_service_role_key for auth, POSTs to send-appointment-sms-reminders edge function. Scheduled hourly at :00 by lng-appointment-sms-reminders-hourly.';

-- Idempotent re-schedule.
select cron.unschedule('lng-appointment-sms-reminders-hourly')
where exists (
  select 1 from cron.job where jobname = 'lng-appointment-sms-reminders-hourly'
);

select cron.schedule(
  'lng-appointment-sms-reminders-hourly',
  '0 * * * *', -- every hour at :00, alongside the email sweep
  $$ select public.lng_run_appointment_sms_reminders_sweep() $$
);
