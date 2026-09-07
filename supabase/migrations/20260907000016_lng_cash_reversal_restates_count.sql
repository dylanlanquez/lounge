-- 20260907000016_lng_cash_reversal_restates_count.sql
--
-- Reversing a withdrawal that sits inside a signed count now corrects
-- that count.
--
-- The counted total on a signed count is what was physically in the
-- safe, so "Right now" (which starts from it) must not move when a
-- withdrawal in that closed period is reversed. What WAS wrong is the
-- count's expected figure: it was computed with a withdrawal that never
-- happened, so the count looked more "over" than it really was.
--
-- Dylan reversed "WHW supplies" (£88.50) inside the 7 Sep count on
-- 7 Sep 2026 and asked why nothing moved. With this change the count's
-- expected goes from £686.10 to £774.60 and its difference from £105.13
-- over to £16.63 over, and the reversal sheet says exactly that before
-- the button is pressed.
--
-- lng_cash_counts.expected_pence is a plain column (variance_pence is
-- generated from it), so the restatement is a single update, recorded
-- in lng_event_log alongside the reversal. The withdrawal snapshot line
-- on the count stays as it was, flagged reversed on screen and in the
-- PDF, so the original picture is never lost.

create or replace function public.lng_cash_reverse_withdrawal(p_withdrawal_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me uuid;
  v_row public.lng_cash_withdrawals%rowtype;
  v_count public.lng_cash_counts%rowtype;
  v_last_period_end timestamptz;
  v_in_open_period boolean;
  v_expected_before integer;
  v_expected_after integer;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only the super admin can reverse a withdrawal.' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Say why this withdrawal is being reversed.' using errcode = '22023';
  end if;
  select a.id into v_me from public.accounts a where a.auth_user_id = auth.uid();
  select * into v_row from public.lng_cash_withdrawals where id = p_withdrawal_id for update;
  if v_row.id is null then
    raise exception 'Withdrawal not found.' using errcode = 'P0002';
  end if;
  if v_row.reversed_at is not null then
    raise exception 'This withdrawal was already reversed.' using errcode = '22023';
  end if;

  select max(period_end) into v_last_period_end
    from public.lng_cash_counts
   where status = 'signed' and location_id = v_row.location_id;
  v_in_open_period := v_last_period_end is null or v_row.taken_at > v_last_period_end;

  update public.lng_cash_withdrawals
     set reversed_at = now(),
         reversed_by = v_me,
         reversal_reason = trim(p_reason)
   where id = p_withdrawal_id;

  -- Closed period: restate the signed count this withdrawal belongs to.
  if not v_in_open_period then
    select * into v_count
      from public.lng_cash_counts
     where status = 'signed'
       and location_id = v_row.location_id
       and v_row.taken_at > period_start
       and v_row.taken_at <= period_end
     order by period_end
     limit 1
     for update;
    if v_count.id is not null then
      v_expected_before := v_count.expected_pence;
      v_expected_after := v_count.expected_pence + v_row.amount_pence;
      update public.lng_cash_counts
         set expected_pence = v_expected_after
       where id = v_count.id;
    end if;
  end if;

  insert into public.lng_event_log (source, event_type, account_id, location_id, payload)
  values (
    'cash_counts',
    'cash_withdrawal_reversed',
    v_me,
    v_row.location_id,
    jsonb_build_object(
      'withdrawal_id', p_withdrawal_id,
      'amount_pence', v_row.amount_pence,
      'reason', v_row.reason,
      'note', v_row.note,
      'taken_at', v_row.taken_at,
      'taken_by', v_row.taken_by,
      'reversal_reason', trim(p_reason),
      'moves_balance', v_in_open_period,
      'restated_count_id', v_count.id,
      'count_expected_before', v_expected_before,
      'count_expected_after', v_expected_after
    )
  );

  return jsonb_build_object(
    'withdrawal_id', p_withdrawal_id,
    'moves_balance', v_in_open_period,
    'restated_count_id', v_count.id,
    'count_expected_before', v_expected_before,
    'count_expected_after', v_expected_after
  );
end
$function$;

-- One-off: apply the same restatement to reversals made before this
-- change (the WHW supplies reversal on 7 Sep 2026). Idempotent: only
-- reversals with no restatement event are touched.
do $$
declare
  r record;
begin
  for r in
    select w.*
      from public.lng_cash_withdrawals w
     where w.reversed_at is not null
       and not exists (
         select 1 from public.lng_event_log e
          where e.source = 'cash_counts'
            and e.event_type = 'cash_withdrawal_restated_count'
            and (e.payload->>'withdrawal_id')::uuid = w.id
       )
  loop
    update public.lng_cash_counts c
       set expected_pence = c.expected_pence + r.amount_pence
     where c.status = 'signed'
       and c.location_id = r.location_id
       and r.taken_at > c.period_start
       and r.taken_at <= c.period_end;
    if found then
      insert into public.lng_event_log (source, event_type, account_id, location_id, payload)
      values (
        'cash_counts',
        'cash_withdrawal_restated_count',
        r.reversed_by,
        r.location_id,
        jsonb_build_object('withdrawal_id', r.id, 'amount_pence', r.amount_pence, 'note', 'Backfill for a reversal made before 20260907000016')
      );
    end if;
  end loop;
end $$;
