-- 20260907000015_lng_cash_reversals_and_backdating.sql
--
-- Fixing mistakes on the safe record, super admin only.
--
-- 1. Reverse a withdrawal. A withdrawal typed twice, for the wrong
--    amount, or that never happened is REVERSED, never deleted: the row
--    stays, stamped with who reversed it, when, and why. The safe
--    position stops counting a reversed withdrawal, so the running
--    balance corrects itself for the open period. A withdrawal inside a
--    period already closed by a signed count is reversed for the record
--    only: that count's counted total already reflects what was
--    physically in the safe, so the balance does not move.
--
-- 2. Void a count. A count signed by mistake is marked 'disputed' with a
--    reason. The safe position only anchors on 'signed' counts, so the
--    anchor moves back to the previous count and every payment and
--    withdrawal in the voided window flows into the open period again.
--
-- 3. Backdate a withdrawal. Take from safe can carry the date the cash
--    actually left (a window cleaner paid on the 23rd, entered on the
--    7th). taken_at is now settable on insert, bounded: not in the
--    future, and not before the last signed count at that location
--    (otherwise it would land in a closed period and never move the
--    balance).
--
-- Both correction functions are SECURITY DEFINER with an explicit
-- auth_is_super_admin() gate, and every use lands in lng_event_log.

-- ── 1. Withdrawal reversal columns ───────────────────────────────────
alter table public.lng_cash_withdrawals
  add column if not exists reversed_at timestamptz,
  add column if not exists reversed_by uuid references public.accounts(id) on delete restrict,
  add column if not exists reversal_reason text;

create index if not exists lng_cash_withdrawals_reversed_idx
  on public.lng_cash_withdrawals (reversed_at) where reversed_at is not null;

create or replace function public.lng_cash_reverse_withdrawal(p_withdrawal_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me uuid;
  v_row public.lng_cash_withdrawals%rowtype;
  v_last_period_end timestamptz;
  v_in_open_period boolean;
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
      'moves_balance', v_in_open_period
    )
  );

  return jsonb_build_object('withdrawal_id', p_withdrawal_id, 'moves_balance', v_in_open_period);
end
$function$;

revoke all on function public.lng_cash_reverse_withdrawal(uuid, text) from public;
grant execute on function public.lng_cash_reverse_withdrawal(uuid, text) to authenticated;

-- ── 2. Void a signed count ───────────────────────────────────────────
create or replace function public.lng_cash_void_count(p_count_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me uuid;
  v_row public.lng_cash_counts%rowtype;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only the super admin can void a count.' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Say why this count is being voided.' using errcode = '22023';
  end if;
  select a.id into v_me from public.accounts a where a.auth_user_id = auth.uid();
  select * into v_row from public.lng_cash_counts where id = p_count_id for update;
  if v_row.id is null then
    raise exception 'Count not found.' using errcode = 'P0002';
  end if;
  if v_row.status <> 'signed' then
    raise exception 'Only a signed count can be voided (this one is %).', v_row.status using errcode = '22023';
  end if;

  update public.lng_cash_counts
     set status = 'disputed',
         notes = concat_ws(E'\n', nullif(notes, ''), 'Voided: ' || trim(p_reason))
   where id = p_count_id;

  insert into public.lng_event_log (source, event_type, account_id, location_id, payload)
  values (
    'cash_counts',
    'cash_count_voided',
    v_me,
    v_row.location_id,
    jsonb_build_object(
      'count_id', p_count_id,
      'period_start', v_row.period_start,
      'period_end', v_row.period_end,
      'expected_pence', v_row.expected_pence,
      'actual_pence', v_row.actual_pence,
      'reason', trim(p_reason)
    )
  );

  return jsonb_build_object('count_id', p_count_id);
end
$function$;

revoke all on function public.lng_cash_void_count(uuid, text) from public;
grant execute on function public.lng_cash_void_count(uuid, text) to authenticated;

-- The signed_pair check requires signed_off_* to be null unless status
-- is 'signed'. A voided count keeps its signer for the record, so
-- widen the check to allow 'disputed' rows to carry the signature.
alter table public.lng_cash_counts drop constraint if exists lng_cash_counts_signed_pair;
alter table public.lng_cash_counts add constraint lng_cash_counts_signed_pair check (
  (status = 'pending' and signed_off_by is null and signed_off_at is null)
  or (status = 'signed' and signed_off_by is not null and signed_off_at is not null)
  or (status = 'disputed')
);

-- ── 3. Backdating guard on withdrawals ───────────────────────────────
create or replace function public.lng_cash_withdrawals_two_person()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_last_period_end timestamptz;
begin
  perform public.lng_cash_assert_two_person(new.taken_by, new.witness_id, new.on_camera, 'withdrawal from the safe');
  if new.witnessed_at is null then new.witnessed_at := now(); end if;
  if new.taken_at > now() + interval '1 minute' then
    raise exception 'A withdrawal cannot be dated in the future.' using errcode = '22007';
  end if;
  select max(period_end) into v_last_period_end
    from public.lng_cash_counts
   where status = 'signed' and location_id = new.location_id;
  if v_last_period_end is not null and new.taken_at <= v_last_period_end then
    raise exception 'A withdrawal cannot be dated before the last signed count (%). That period is closed.',
      to_char(v_last_period_end at time zone 'Europe/London', 'DD Mon YYYY HH24:MI')
      using errcode = '22007';
  end if;
  return new;
end
$function$;

-- ── 4. Safe position: skip reversed withdrawals, carry reversal on lines ──
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
      - coalesce((select sum(amount_pence) from wd where reversed_at is null), 0),
    'baseline_pence', v_baseline,
    'location_id', v_loc,
    'period_start', v_since,
    'period_end', v_end,
    'payment_count', (select count(*) from pay_flagged where not fully_refunded),
    'refunded_sale_count', (select count(*) from pay_flagged where fully_refunded),
    'refund_count', (select count(*) from moved_ref),
    'withdrawal_count', (select count(*) from wd where reversed_at is null),
    'earliest_payment_at', (
      select min(t) from (
        select succeeded_at as t from pay_flagged
        union all select refunded_at from moved_ref
        union all select taken_at from wd
      ) s
    ),
    'latest_payment_at', (
      select max(t) from (
        select succeeded_at as t from pay_flagged
        union all select refunded_at from moved_ref
        union all select taken_at from wd
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
