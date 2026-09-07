-- 20260907000019_lng_cash_safe_position_v6.sql
--
-- Safe position, sixth edition: adds lng_cash_adjustments (the "put
-- back" rows from 20260907000018) to the running balance and returns
-- them as 'adjustment' lines. Everything else as 20260907000015.

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
