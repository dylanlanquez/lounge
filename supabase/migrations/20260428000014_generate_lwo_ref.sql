-- 20260428_14_generate_lwo_ref.sql
-- Generates a per-day-monotonic LWO reference: LWO-YYYYMMDD-NNNN.
-- Atomic against concurrent inserts via the row-level lock implicit in UPDATE.
--
-- Day rollover handled inside the UPDATE: when the stored day differs from today,
-- counter resets to 1 (and we return 1).
--
-- Per `06-patient-identity.md §5`.
--
-- Rollback: DROP FUNCTION public.generate_lwo_ref();

create or replace function public.generate_lwo_ref()
returns text
language plpgsql
as $$
declare
  v_year  int := extract(year  from now())::int;
  v_month int := extract(month from now())::int;
  v_day   int := extract(day   from now())::int;
  v_n     int;
begin
  update public.lng_lwo_sequences
     set year       = case when year = v_year and month = v_month and day = v_day then year       else v_year  end,
         month      = case when year = v_year and month = v_month and day = v_day then month      else v_month end,
         day        = case when year = v_year and month = v_month and day = v_day then day        else v_day   end,
         next_value = case when year = v_year and month = v_month and day = v_day then next_value + 1 else 2     end,
         updated_at = now()
   where id = 1
   returning (case when year = v_year and month = v_month and day = v_day then next_value - 1 else 1 end)
     into v_n;

  if v_n is null then
    raise exception 'lng_lwo_sequences row missing — was migration 01 applied?';
  end if;

  return format('LWO-%s%s%s-%s',
    lpad(v_year::text,  4, '0'),
    lpad(v_month::text, 2, '0'),
    lpad(v_day::text,   2, '0'),
    lpad(v_n::text,     4, '0'));
end;
$$;

comment on function public.generate_lwo_ref() is
  'Returns the next LWO reference (LWO-YYYYMMDD-NNNN). Atomically increments lng_lwo_sequences.';
