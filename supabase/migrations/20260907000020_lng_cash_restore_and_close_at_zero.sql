-- 20260907000020_lng_cash_restore_and_close_at_zero.sql
--
-- Three things from Dylan's review on 7 Sep 2026, in one place.
--
-- 1. Restore a voided count (super admin). The 7 Sep count was voided by
--    accident. lng_cash_restore_count flips 'disputed' back to 'signed'
--    (the signer was kept on void) and strips the "Voided: ..." line
--    from the notes, logging the event.
--
-- 2. Put-back double count. With a count voided, a reversed withdrawal
--    in that window is no longer deducted AND its put-back adjustment
--    was still added, so the cash counted twice (£863.10 instead of
--    £774.60). The safe position now ignores a put-back whose linked
--    withdrawal sits inside the open window: the reversal alone already
--    accounts for it there. The adjustment applies only while that
--    withdrawal's period is closed by a signed count.
--
-- 3. Close the 3 July count at £0. £560 was counted and signed at
--    17:54:28, then £560 was banked at 17:55:04, thirty-six seconds
--    later. The banking therefore landed in the NEXT period and the
--    7 Sep count opened with "£560 opening, −£560 bank deposit". Dylan
--    wants that close to read as what it was: safe emptied, next period
--    starts from £0. The 3 July count's period_end moves to just after
--    the banking, its expected and counted become £0 with the bank
--    deposit snapshotted on it, and the 7 Sep count's period_start
--    follows. The 7 Sep expected figure does not change
--    (560 + 1949 − 1262.90 − 560 = 0 + 1949 − 1262.90 = 686.10).

-- ── 1. Restore a voided count ────────────────────────────────────────
create or replace function public.lng_cash_restore_count(p_count_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me uuid;
  v_row public.lng_cash_counts%rowtype;
  v_notes text;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only the super admin can restore a voided count.' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Say why this count is being restored.' using errcode = '22023';
  end if;
  select a.id into v_me from public.accounts a where a.auth_user_id = auth.uid();
  select * into v_row from public.lng_cash_counts where id = p_count_id for update;
  if v_row.id is null then
    raise exception 'Count not found.' using errcode = 'P0002';
  end if;
  if v_row.status <> 'disputed' then
    raise exception 'Only a voided count can be restored (this one is %).', v_row.status using errcode = '22023';
  end if;
  if v_row.signed_off_by is null or v_row.signed_off_at is null then
    raise exception 'This count has no signature to restore.' using errcode = '22023';
  end if;
  -- Drop the "Voided: ..." line the void appended.
  v_notes := nullif(trim(regexp_replace(coalesce(v_row.notes, ''), E'(^|\\n)Voided: [^\\n]*', '', 'g')), '');

  update public.lng_cash_counts
     set status = 'signed', notes = v_notes
   where id = p_count_id;

  insert into public.lng_event_log (source, event_type, account_id, location_id, payload)
  values ('cash_counts', 'cash_count_restored', v_me, v_row.location_id,
          jsonb_build_object('count_id', p_count_id, 'period_end', v_row.period_end, 'reason', trim(p_reason)));

  return jsonb_build_object('count_id', p_count_id);
end
$function$;

revoke all on function public.lng_cash_restore_count(uuid, text) from public;
grant execute on function public.lng_cash_restore_count(uuid, text) to authenticated;

-- ── 2. Safe position v7: put-back applies only to closed periods ──────
create or replace function public.lng_cash_safe_position(
  p_location_id uuid default null,
  p_period_end timestamptz default null,
  p_include_clues boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller_loc uuid;
  v_loc uuid;
  v_since timestamptz;
  v_end timestamptz;
  v_baseline integer;
  v_last_id uuid;
  v_last_period_end timestamptz;
  v_last_actual integer;
  v_last_expected integer;
  v_last_variance integer;
  v_last_signed_at timestamptz;
  v_last_witness_first text;
  v_last_witness_last text;
  v_last_witness_name text;
  v_result jsonb;
  v_clues jsonb := null;
begin
  if not (public.auth_can_count_cash() or public.auth_can_view_financials() or public.auth_can_view_safe()) then
    raise exception 'not authorized to view the cash position'
      using errcode = '42501';
  end if;

  select a.location_id into v_caller_loc
    from public.accounts a
   where a.auth_user_id = auth.uid();

  v_loc := coalesce(p_location_id, v_caller_loc);
  if v_loc is null then
    raise exception 'no location for cash position: account has no location set and none was supplied'
      using errcode = '22004';
  end if;
  if p_location_id is not null
     and p_location_id <> v_caller_loc
     and not public.auth_can_view_financials() then
    raise exception 'not authorized to view another location''s cash position'
      using errcode = '42501';
  end if;

  v_end := coalesce(p_period_end, now());
  if v_end > now() + interval '1 minute' then
    raise exception 'cash position period_end % is in the future', v_end
      using errcode = '22007';
  end if;

  select c.id, c.period_end, c.actual_pence, c.expected_pence, c.variance_pence, c.signed_off_at,
         w.first_name, w.last_name, w.name
    into v_last_id, v_last_period_end, v_last_actual, v_last_expected, v_last_variance, v_last_signed_at,
         v_last_witness_first, v_last_witness_last, v_last_witness_name
    from public.lng_cash_counts c
    left join public.accounts w on w.id = c.witness_id
   where c.status = 'signed'
     and c.location_id = v_loc
     and c.period_end <= v_end
   order by c.period_end desc, c.signed_off_at desc nulls last, c.id
   limit 1;

  v_since := coalesce(v_last_period_end, timestamptz '1970-01-01 00:00:00+00');
  v_baseline := coalesce(v_last_actual, 0);

  with pay as (
    select p.id,
           p.amount_pence,
           p.succeeded_at,
           v.id as visit_id,
           pt.first_name as patient_first,
           pt.last_name  as patient_last,
           coalesce(ap.appointment_ref, wi.appointment_ref) as appointment_ref,
           c.total_pence as cart_total_pence,
           acc.first_name as actor_first,
           acc.last_name  as actor_last,
           acc.name       as actor_name
      from public.lng_payments p
      join public.lng_carts c on c.id = p.cart_id
      join public.lng_visits v on v.id = c.visit_id
      left join public.patients pt on pt.id = v.patient_id
      left join public.lng_appointments ap on ap.id = v.appointment_id
      left join public.lng_walk_ins wi on wi.id = v.walk_in_id
      left join public.accounts acc on acc.id = p.taken_by
     where p.method = 'cash'
       and p.status in ('succeeded', 'cancelled')
       and p.succeeded_at > v_since
       and p.succeeded_at <= v_end
       and v.location_id = v_loc
  ),
  ref as (
    select r.id,
           r.amount_pence,
           r.refunded_at,
           r.payment_id
      from public.lng_payment_refunds r
      join public.lng_payments p on p.id = r.payment_id
      join public.lng_carts c on c.id = p.cart_id
      join public.lng_visits v on v.id = c.visit_id
     where r.method = 'cash'
       and r.status = 'succeeded'
       and r.refunded_at > v_since
       and r.refunded_at <= v_end
       and v.location_id = v_loc
  ),
  refunded_by_payment as (
    select payment_id, sum(amount_pence) as refunded_total
      from ref
     group by payment_id
  ),
  pay_flagged as (
    select pay.*,
           (coalesce(rbp.refunded_total, 0) > 0
            and coalesce(rbp.refunded_total, 0) >= pay.amount_pence) as fully_refunded
      from pay
      left join refunded_by_payment rbp on rbp.payment_id = pay.id
  ),
  wd as (
    select x.id,
           x.amount_pence,
           x.reason,
           x.note,
           x.taken_at,
           x.on_camera,
           x.reversed_at,
           x.reversal_reason,
           acc.first_name as actor_first,
           acc.last_name  as actor_last,
           acc.name       as actor_name,
           wit.first_name as witness_first,
           wit.last_name  as witness_last,
           wit.name       as witness_name,
           rev.first_name as reverser_first,
           rev.last_name  as reverser_last,
           rev.name       as reverser_name
      from public.lng_cash_withdrawals x
      left join public.accounts acc on acc.id = x.taken_by
      left join public.accounts wit on wit.id = x.witness_id
      left join public.accounts rev on rev.id = x.reversed_by
     where x.taken_at > v_since
       and x.taken_at <= v_end
       and x.location_id = v_loc
  ),
  adj as (
    select j.id,
           j.amount_pence,
           j.reason,
           j.occurred_at,
           j.withdrawal_id,
           w.note as withdrawal_note,
           acc.first_name as actor_first,
           acc.last_name  as actor_last,
           acc.name       as actor_name
      from public.lng_cash_adjustments j
      left join public.lng_cash_withdrawals w on w.id = j.withdrawal_id
      left join public.accounts acc on acc.id = j.created_by
     where j.occurred_at > v_since
       and j.occurred_at <= v_end
       and j.location_id = v_loc
       -- A put-back only applies while its withdrawal sits in a period
       -- closed by a signed count. If that withdrawal is inside THIS
       -- window (e.g. the count was voided), the reversal alone already
       -- leaves the cash in the balance; adding the put-back too would
       -- count it twice.
       and (w.id is null or w.taken_at <= v_since)
  ),
  moved_ref as (
    select ref.id,
           ref.amount_pence,
           ref.refunded_at,
           ref.payment_id,
           pk.patient_first,
           pk.patient_last
      from ref
      left join pay_flagged pk on pk.id = ref.payment_id
     where coalesce(pk.fully_refunded, false) = false
  )
  select jsonb_build_object(
    'expected_in_safe_pence',
      v_baseline
      + coalesce((select sum(amount_pence) from pay_flagged where not fully_refunded), 0)
      - coalesce((select sum(amount_pence) from moved_ref), 0)
      - coalesce((select sum(amount_pence) from wd where reversed_at is null), 0)
      + coalesce((select sum(amount_pence) from adj), 0),
    'baseline_pence', v_baseline,
    'location_id', v_loc,
    'period_start', v_since,
    'period_end', v_end,
    'payment_count', (select count(*) from pay_flagged where not fully_refunded),
    'refunded_sale_count', (select count(*) from pay_flagged where fully_refunded),
    'refund_count', (select count(*) from moved_ref),
    'withdrawal_count', (select count(*) from wd where reversed_at is null),
    'adjustment_count', (select count(*) from adj),
    'earliest_payment_at', (
      select min(t) from (
        select succeeded_at as t from pay_flagged
        union all select refunded_at from moved_ref
        union all select taken_at from wd
        union all select occurred_at from adj
      ) s
    ),
    'latest_payment_at', (
      select max(t) from (
        select succeeded_at as t from pay_flagged
        union all select refunded_at from moved_ref
        union all select taken_at from wd
        union all select occurred_at from adj
      ) s
    ),
    'last_signed_count',
      case when v_last_id is null then null
      else jsonb_build_object(
        'id', v_last_id,
        'period_end', v_last_period_end,
        'actual_pence', v_last_actual,
        'expected_pence', v_last_expected,
        'variance_pence', v_last_variance,
        'signed_off_at', v_last_signed_at,
        'witness_first', v_last_witness_first,
        'witness_last', v_last_witness_last,
        'witness_name', v_last_witness_name
      ) end,
    'lines', coalesce((
      select jsonb_agg(line order by (line->>'taken_at') desc)
        from (
          select jsonb_build_object(
            'kind', 'payment',
            'payment_id', id,
            'amount_pence', amount_pence,
            'taken_at', succeeded_at,
            'patient_first', patient_first,
            'patient_last', patient_last,
            'appointment_ref', appointment_ref,
            'visit_id', visit_id,
            'cart_total_pence', cart_total_pence,
            'actor_first', actor_first,
            'actor_last', actor_last,
            'actor_name', actor_name
          ) as line
          from pay_flagged where not fully_refunded
          union all
          select jsonb_build_object(
            'kind', 'refunded_sale',
            'payment_id', id,
            'amount_pence', amount_pence,
            'taken_at', succeeded_at,
            'patient_first', patient_first,
            'patient_last', patient_last,
            'visit_id', visit_id,
            'actor_first', actor_first,
            'actor_last', actor_last,
            'actor_name', actor_name
          )
          from pay_flagged where fully_refunded
          union all
          select jsonb_build_object(
            'kind', 'refund',
            'refund_id', id,
            'amount_pence', amount_pence,
            'taken_at', refunded_at,
            'patient_first', patient_first,
            'patient_last', patient_last
          )
          from moved_ref
          union all
          select jsonb_build_object(
            'kind', 'withdrawal',
            'withdrawal_id', id,
            'amount_pence', amount_pence,
            'taken_at', taken_at,
            'reason', reason,
            'note', note,
            'on_camera', on_camera,
            'reversed_at', reversed_at,
            'reversal_reason', reversal_reason,
            'actor_first', actor_first,
            'actor_last', actor_last,
            'actor_name', actor_name,
            'witness_first', witness_first,
            'witness_last', witness_last,
            'witness_name', witness_name,
            'reverser_first', reverser_first,
            'reverser_last', reverser_last,
            'reverser_name', reverser_name
          )
          from wd
          union all
          select jsonb_build_object(
            'kind', 'adjustment',
            'adjustment_id', id,
            'amount_pence', amount_pence,
            'taken_at', occurred_at,
            'reason', reason,
            'withdrawal_id', withdrawal_id,
            'withdrawal_note', withdrawal_note,
            'actor_first', actor_first,
            'actor_last', actor_last,
            'actor_name', actor_name
          )
          from adj
        ) lines_src
    ), '[]'::jsonb)
  ) into v_result;

  if p_include_clues then
    select jsonb_build_object(
      'other_payments', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'payment_id', p.id,
                 'method', p.method,
                 'amount_pence', p.amount_pence,
                 'taken_at', p.succeeded_at,
                 'patient_first', pt.first_name,
                 'patient_last', pt.last_name,
                 'appointment_ref', coalesce(ap.appointment_ref, wi.appointment_ref),
                 'visit_id', v.id,
                 'actor_first', acc.first_name,
                 'actor_last', acc.last_name,
                 'actor_name', acc.name
               ) order by p.succeeded_at desc)
          from public.lng_payments p
          join public.lng_carts c on c.id = p.cart_id
          join public.lng_visits v on v.id = c.visit_id
          left join public.patients pt on pt.id = v.patient_id
          left join public.lng_appointments ap on ap.id = v.appointment_id
          left join public.lng_walk_ins wi on wi.id = v.walk_in_id
          left join public.accounts acc on acc.id = p.taken_by
         where p.method <> 'cash'
           and p.status = 'succeeded'
           and p.succeeded_at > v_since
           and p.succeeded_at <= v_end
           and v.location_id = v_loc
      ), '[]'::jsonb),
      'open_balances', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'visit_id', v.id,
                 'opened_at', v.opened_at,
                 'owed_pence', ps.amount_due_pence - ps.amount_paid_pence - coalesce(ps.written_off_pence, 0),
                 'patient_first', pt.first_name,
                 'patient_last', pt.last_name,
                 'appointment_ref', coalesce(ap.appointment_ref, wi.appointment_ref)
               ) order by v.opened_at desc)
          from public.lng_visit_paid_status ps
          join public.lng_visits v on v.id = ps.visit_id
          left join public.patients pt on pt.id = v.patient_id
          left join public.lng_appointments ap on ap.id = v.appointment_id
          left join public.lng_walk_ins wi on wi.id = v.walk_in_id
         where v.location_id = v_loc
           and v.opened_at > v_since
           and v.opened_at <= v_end
           and ps.amount_due_pence is not null
           and ps.amount_due_pence - ps.amount_paid_pence - coalesce(ps.written_off_pence, 0) > 0
      ), '[]'::jsonb)
    ) into v_clues;
    v_result := v_result || jsonb_build_object('clues', v_clues);
  end if;

  return v_result;
end
$function$;

-- ── 3. Data: restore the 7 Sep count; close 3 July at £0 ─────────────
-- No-ops on the shadow (rows absent).
do $$
declare
  v_jul  uuid := 'f3366324-f76a-4d6d-83f6-25350452b99d';
  v_sep  uuid := 'a0424fb9-983e-4034-bbfb-48613e59fb5d';
  v_bank uuid := '01204a9a-6637-49de-b3d9-38d991fe4d5e';
  v_bank_at timestamptz;
  v_dylan uuid;
begin
  select taken_at into v_bank_at from public.lng_cash_withdrawals where id = v_bank;
  if v_bank_at is null then return; end if;
  select id into v_dylan from public.accounts where login_email = 'dylan@lanquez.com';

  -- Restore the accidentally voided 7 Sep count.
  update public.lng_cash_counts
     set status = 'signed',
         notes = nullif(trim(regexp_replace(coalesce(notes, ''), E'(^|\\n)Voided: [^\\n]*', '', 'g')), '')
   where id = v_sep and status = 'disputed';

  -- 3 July: the banking belongs to the close. Period ends just after it,
  -- expected and counted read £0, bank deposit snapshotted on the count.
  update public.lng_cash_counts
     set period_end = v_bank_at + interval '1 second',
         expected_pence = 0,
         actual_pence = 0,
         notes = concat_ws(E'\n', nullif(notes, ''), '£560.00 counted and banked at close. Closed at £0.00.')
   where id = v_jul and expected_pence = 56000;
  insert into public.lng_cash_count_withdrawal_lines (count_id, withdrawal_id, amount_pence, reason_snapshot, note_snapshot, taken_at, taken_by_name_snapshot)
  select v_jul, w.id, w.amount_pence, w.reason, w.note, w.taken_at, 'Dylan Lane'
    from public.lng_cash_withdrawals w
   where w.id = v_bank
     and not exists (select 1 from public.lng_cash_count_withdrawal_lines l where l.count_id = v_jul and l.withdrawal_id = v_bank);

  -- 7 Sep: starts where 3 July now ends; the bank deposit is no longer in its period.
  update public.lng_cash_counts
     set period_start = v_bank_at + interval '1 second'
   where id = v_sep;
  delete from public.lng_cash_count_withdrawal_lines where count_id = v_sep and withdrawal_id = v_bank;

  insert into public.lng_event_log (source, event_type, account_id, location_id, payload)
  values ('cash_counts', 'cash_count_restored', v_dylan, '89ba5824-30bf-4386-a878-f307096bb402',
          jsonb_build_object('count_id', v_sep, 'reason', 'Voided by accident (Dylan, 7 Sep 2026). Restored by migration 20260907000020.')),
         ('cash_counts', 'cash_count_closed_at_zero', v_dylan, '89ba5824-30bf-4386-a878-f307096bb402',
          jsonb_build_object('count_id', v_jul, 'bank_withdrawal_id', v_bank, 'note', '3 July close restated: £560 counted and banked at close, period now ends after the banking and reads £0.'));
end $$;
