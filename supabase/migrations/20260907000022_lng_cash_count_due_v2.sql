-- 20260907000022_lng_cash_count_due_v2.sql
--
-- lng_cash_count_due, second edition. The first only answered "is a
-- count outstanding?", which left a rota day silent once the count was
-- signed, so the person on the rota saw nothing at all (Dylan, 7 Sep:
-- rota set for Monday, count already signed at 13:09, blank screen).
--
-- Now every rota day says something:
--   * due_date / overdue          — a count is outstanding (as before).
--   * done_today                   — today is a rota day and a count was
--                                    signed today: who, when, witness.
--   * next_due_date + responsible  — the next rota day after today (or
--                                    after the outstanding due date),
--                                    with cover applied.

create or replace function public.lng_cash_count_due(p_location_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_loc uuid;
  v_today date := (now() at time zone 'Europe/London')::date;
  v_last_signed date;
  v_due date;
  v_weekday smallint;
  v_assignee uuid;
  v_responsible uuid;
  v_name text;
  v_cover boolean := false;
  v_day date;
  v_lookback int := 0;
  v_today_is_rota boolean := false;
  v_done jsonb := null;
  v_next date;
  v_next_assignee uuid;
  v_next_responsible uuid;
  v_next_name text;
  v_next_cover boolean := false;
  v_i int;
begin
  select coalesce(p_location_id, a.location_id) into v_loc
    from public.accounts a where a.auth_user_id = auth.uid();
  if v_loc is null then
    return jsonb_build_object('due_date', null);
  end if;

  select max((period_end at time zone 'Europe/London')::date) into v_last_signed
    from public.lng_cash_counts
   where status = 'signed' and location_id = v_loc;

  select exists (
    select 1 from public.lng_cash_count_rota r
     where r.location_id = v_loc and r.enabled and r.weekday = extract(isodow from v_today)::smallint
  ) into v_today_is_rota;

  -- Outstanding: walk back from today to the latest rota day with no
  -- signed count on or after it.
  v_day := v_today;
  while v_lookback < 60 loop
    exit when v_last_signed is not null and v_day <= v_last_signed;
    v_weekday := extract(isodow from v_day)::smallint;
    select r.assignee_account_id into v_assignee
      from public.lng_cash_count_rota r
     where r.location_id = v_loc and r.weekday = v_weekday and r.enabled;
    if v_assignee is not null then
      v_due := v_day;
      exit;
    end if;
    v_day := v_day - 1;
    v_lookback := v_lookback + 1;
  end loop;

  if v_due is not null then
    select c.cover_account_id into v_responsible
      from public.lng_cash_count_rota_covers c
     where c.location_id = v_loc and v_due between c.from_date and c.to_date
     order by c.created_at desc limit 1;
    v_cover := v_responsible is not null;
    if v_responsible is null then v_responsible := v_assignee; end if;
    select coalesce(nullif(trim(concat_ws(' ', a.first_name, a.last_name)), ''), a.name) into v_name
      from public.accounts a where a.id = v_responsible;
  end if;

  -- Done today: today is a rota day and a count was signed today.
  if v_today_is_rota and v_last_signed = v_today then
    select jsonb_build_object(
             'signed_at', c.signed_off_at,
             'counted_by_name', coalesce(nullif(trim(concat_ws(' ', cb.first_name, cb.last_name)), ''), cb.name),
             'witness_name', coalesce(nullif(trim(concat_ws(' ', w.first_name, w.last_name)), ''), w.name),
             'actual_pence', c.actual_pence
           )
      into v_done
      from public.lng_cash_counts c
      left join public.accounts cb on cb.id = c.counted_by
      left join public.accounts w on w.id = c.witness_id
     where c.status = 'signed' and c.location_id = v_loc
       and (c.period_end at time zone 'Europe/London')::date = v_today
     order by c.period_end desc limit 1;
  end if;

  -- Next rota day strictly after today (or after the outstanding day).
  v_day := greatest(coalesce(v_due, v_today), v_today);
  v_i := 1;
  while v_i <= 14 loop
    v_day := v_day + 1;
    select r.assignee_account_id into v_next_assignee
      from public.lng_cash_count_rota r
     where r.location_id = v_loc and r.enabled and r.weekday = extract(isodow from v_day)::smallint;
    if v_next_assignee is not null then
      v_next := v_day;
      exit;
    end if;
    v_i := v_i + 1;
  end loop;
  if v_next is not null then
    select c.cover_account_id into v_next_responsible
      from public.lng_cash_count_rota_covers c
     where c.location_id = v_loc and v_next between c.from_date and c.to_date
     order by c.created_at desc limit 1;
    v_next_cover := v_next_responsible is not null;
    if v_next_responsible is null then v_next_responsible := v_next_assignee; end if;
    select coalesce(nullif(trim(concat_ws(' ', a.first_name, a.last_name)), ''), a.name) into v_next_name
      from public.accounts a where a.id = v_next_responsible;
  end if;

  return jsonb_build_object(
    'today', v_today,
    'today_is_rota_day', v_today_is_rota,
    'due_date', v_due,
    'overdue', v_due is not null and v_due < v_today,
    'responsible_account_id', v_responsible,
    'responsible_name', v_name,
    'is_cover', v_cover,
    'last_signed_date', v_last_signed,
    'done_today', v_done,
    'next_due_date', v_next,
    'next_responsible_account_id', v_next_responsible,
    'next_responsible_name', v_next_name,
    'next_is_cover', v_next_cover
  );
end
$function$;
