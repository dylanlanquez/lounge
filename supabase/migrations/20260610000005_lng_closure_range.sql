-- 20260610000005_lng_closure_range.sql
--
-- Range support for clinic closures. A closure is still stored one row
-- per (date, type) in lng_closures (so all the existing enforcement —
-- lng_is_closed, the checker gate, the virtual guard — keeps working
-- unchanged). These RPCs just let the admin set / clear a contiguous
-- span of dates in one atomic, admin-gated call instead of N round
-- trips.
--
-- Additive; safe to apply any time. Apply: shadow first, then Meridian.

-- Upsert every date in [p_from, p_to] (inclusive) as a closure for the
-- given scope. Returns the number of dates written. A single-day
-- closure is just p_from = p_to.
create or replace function public.lng_add_closure_range(
  p_from         date,
  p_to           date,
  p_service_type text default null,
  p_reason       text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lo    date;
  v_hi    date;
  v_count int := 0;
  d       date;
begin
  if not public.is_admin() then
    raise exception 'Only admins can add closures' using errcode = '42501';
  end if;
  if p_from is null or p_to is null then
    raise exception 'from and to are required' using errcode = '22023';
  end if;
  if p_service_type is not null and p_service_type not in (
       'denture_repair', 'click_in_veneers', 'same_day_appliance',
       'impression_appointment', 'virtual_impression_appointment', 'other'
     ) then
    raise exception 'Unknown service_type %', p_service_type using errcode = '22023';
  end if;

  v_lo := least(p_from, p_to);
  v_hi := greatest(p_from, p_to);
  -- Guard against a runaway span (a malformed UI shouldn't be able to
  -- write years of rows).
  if v_hi - v_lo > 366 then
    raise exception 'Closure range too long (max 366 days)' using errcode = '22023';
  end if;

  for d in select dd::date from generate_series(v_lo, v_hi, interval '1 day') dd loop
    insert into public.lng_closures (closed_date, service_type, reason, created_by)
    values (d, p_service_type, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid())
    on conflict (closed_date, service_type) do update
      set reason     = excluded.reason,
          updated_at = now();
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
revoke all on function public.lng_add_closure_range(date, date, text, text) from public;
grant execute on function public.lng_add_closure_range(date, date, text, text) to authenticated;
comment on function public.lng_add_closure_range(date, date, text, text) is
  'Admin-gated. Upserts a closure for every date in [from,to] (inclusive) for the given scope (service_type null = whole clinic). Returns the count. Single day = from=to.';

-- Bulk delete (used to clear a whole range / group in one call).
create or replace function public.lng_delete_closures(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can delete closures' using errcode = '42501';
  end if;
  delete from public.lng_closures where id = any(p_ids);
end;
$$;
revoke all on function public.lng_delete_closures(uuid[]) from public;
grant execute on function public.lng_delete_closures(uuid[]) to authenticated;

NOTIFY pgrst, 'reload schema';
