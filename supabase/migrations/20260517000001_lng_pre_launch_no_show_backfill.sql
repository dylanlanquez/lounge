-- 20260517000001_lng_pre_launch_no_show_backfill.sql
--
-- Wires the "Lounge launch date" into lng_settings and adds a one-shot
-- callable function that flips every still-booked, end-elapsed row to
-- no_show with a clearly-labelled cancel_reason. The goal: a clean
-- schedule + report surface on launch day, without surfacing the new
-- late-alert icon on rows that pre-date the no-show workflow ever
-- being a thing.
--
-- Rules baked in (per Dylan):
--   • Only touch rows where status='booked' — anything already moved
--     (arrived / joined / complete / no_show / cancelled / rescheduled)
--     has been actively handled and stays as-is.
--   • Only touch rows where end_at < launch_date — a booking sitting
--     in the future (e.g. Monday 11:00 with launch at Monday 08:00)
--     is a real upcoming appointment, not a backfill candidate.
--   • The launch_date is read at function-call time from lng_settings
--     so the cutoff stays editable until the function actually runs.
--     Calling the function without a date set raises and returns 0.
--
-- Apply order: shadow first → verify counts → Meridian.
-- The function is idempotent — calling it twice updates zero extra
-- rows the second time (everything's already no_show).

-- ── 1. Settings row ────────────────────────────────────────────────
-- JSONB value initially null. Dylan sets it via Supabase Studio
-- (or psql) when launch is finalised, e.g.:
--   update public.lng_settings
--      set value = to_jsonb('2026-05-19T08:00:00+01:00'::timestamptz)
--    where location_id is null and key = 'lounge.launch_date';
-- Stored as an ISO timestamptz so the function can compare directly
-- against end_at (also timestamptz) without timezone guesswork.

insert into public.lng_settings (location_id, key, value, description) values
  (null,
   'lounge.launch_date',
   'null'::jsonb,
   'The instant Lounge went live (ISO timestamptz string in JSONB). Drives lng_pre_launch_no_show_backfill() and any future "since launch" reporting filters. Null until Dylan finalises the cutover; setting it does not auto-run anything.')
on conflict (key) where location_id is null do nothing;

-- ── 2. One-shot cleanup function ───────────────────────────────────
-- Returns the number of rows updated so the operator gets immediate
-- feedback. Wrapped in plpgsql so we can raise a clear notice when
-- launch_date is unset rather than silently no-op'ing.
--
-- cancel_reason wording deliberately reads as a clear backfill tag,
-- not a bland 'no_show' enum value — when staff hover the timeline
-- entry, they see exactly why the row was flipped.

create or replace function public.lng_pre_launch_no_show_backfill()
returns integer
language plpgsql
security invoker
as $$
declare
  v_launch  timestamptz;
  v_raw     jsonb;
  v_count   integer;
begin
  select value
    into v_raw
    from public.lng_settings
   where location_id is null
     and key = 'lounge.launch_date';

  -- Settings row missing or value is null → refuse to run blindly.
  if v_raw is null or v_raw = 'null'::jsonb then
    raise notice 'lounge.launch_date not set in lng_settings — nothing to do. Set it first, then call this function again.';
    return 0;
  end if;

  -- jsonb → text → timestamptz. The text cast strips JSON quoting
  -- when the value is a JSON string ("2026-05-19T08:00:00+01:00").
  begin
    v_launch := (v_raw #>> '{}')::timestamptz;
  exception when others then
    raise exception 'lounge.launch_date is set but unparseable as timestamptz: %', v_raw;
  end;

  update public.lng_appointments
     set status        = 'no_show',
         cancel_reason = 'Pre-Lounge launch backfill, not a real no-show'
   where status = 'booked'
     and end_at  < v_launch;

  get diagnostics v_count = row_count;
  raise notice 'lng_pre_launch_no_show_backfill: flipped % booked row(s) older than %.', v_count, v_launch;
  return v_count;
end;
$$;

comment on function public.lng_pre_launch_no_show_backfill() is
  'One-shot cleanup. Reads lng_settings.lounge.launch_date, then flips every lng_appointments row with status=''booked'' AND end_at < launch_date to status=''no_show'' with cancel_reason marked as a pre-launch backfill. Safe to call multiple times; only untouched booked rows older than launch_date are affected. Returns the number of rows updated.';

-- ── Rollback ───────────────────────────────────────────────────────
-- drop function if exists public.lng_pre_launch_no_show_backfill();
-- delete from public.lng_settings where location_id is null and key = 'lounge.launch_date';
-- Note: the appointment rows already flipped to no_show won't be
-- reverted by the rollback; if you need to undo a backfill run, do:
--   update public.lng_appointments
--      set status='booked', cancel_reason=null
--    where status='no_show'
--      and cancel_reason='Pre-Lounge launch backfill, not a real no-show';
