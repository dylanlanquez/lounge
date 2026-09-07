-- 20260907000017_lng_cash_write_off_difference.sql
--
-- Write off a count's difference, super admin only.
--
-- After the envelopes have been checked and the reversals made, a
-- count can still be a few pounds over or short with no further
-- explanation. Dylan wants a clean slate: accept the difference with a
-- note so the count reads as matched, while the original expected and
-- the amount written off stay on the record.
--
-- Mechanics: expected_pence is set to actual_pence (variance_pence, a
-- generated column, becomes 0) and the original difference is kept in
-- written_off_pence with who, when, and why. Right now is unaffected:
-- it already starts from the counted total. Logged to lng_event_log.

alter table public.lng_cash_counts
  add column if not exists written_off_pence integer,
  add column if not exists written_off_at timestamptz,
  add column if not exists written_off_by uuid references public.accounts(id) on delete restrict,
  add column if not exists write_off_reason text;

comment on column public.lng_cash_counts.written_off_pence is
  'Original difference (counted minus expected) accepted by the super admin with a note. Positive = was over, negative = was short. expected_pence was set to actual_pence at that moment.';

create or replace function public.lng_cash_write_off_difference(p_count_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me uuid;
  v_row public.lng_cash_counts%rowtype;
  v_diff integer;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only the super admin can write off a difference.' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Say why the difference is being written off.' using errcode = '22023';
  end if;
  select a.id into v_me from public.accounts a where a.auth_user_id = auth.uid();
  select * into v_row from public.lng_cash_counts where id = p_count_id for update;
  if v_row.id is null then
    raise exception 'Count not found.' using errcode = 'P0002';
  end if;
  if v_row.status <> 'signed' then
    raise exception 'Only a signed count can have its difference written off (this one is %).', v_row.status using errcode = '22023';
  end if;
  if v_row.actual_pence is null then
    raise exception 'This count has no counted total.' using errcode = '22023';
  end if;
  if v_row.written_off_at is not null then
    raise exception 'This count''s difference was already written off.' using errcode = '22023';
  end if;
  v_diff := v_row.actual_pence - v_row.expected_pence;
  if v_diff = 0 then
    raise exception 'This count already matches. There is no difference to write off.' using errcode = '22023';
  end if;

  update public.lng_cash_counts
     set expected_pence = actual_pence,
         written_off_pence = v_diff,
         written_off_at = now(),
         written_off_by = v_me,
         write_off_reason = trim(p_reason)
   where id = p_count_id;

  insert into public.lng_event_log (source, event_type, account_id, location_id, payload)
  values (
    'cash_counts',
    'cash_count_difference_written_off',
    v_me,
    v_row.location_id,
    jsonb_build_object(
      'count_id', p_count_id,
      'period_end', v_row.period_end,
      'expected_before', v_row.expected_pence,
      'actual_pence', v_row.actual_pence,
      'written_off_pence', v_diff,
      'reason', trim(p_reason)
    )
  );

  return jsonb_build_object('count_id', p_count_id, 'written_off_pence', v_diff);
end
$function$;

revoke all on function public.lng_cash_write_off_difference(uuid, text) from public;
grant execute on function public.lng_cash_write_off_difference(uuid, text) to authenticated;
