-- 20260907000012_lng_cash_two_person_rule.sql
--
-- The two-person rule for the safe.
--
-- Policy (Dylan, 7 Sep 2026): the safe is only ever opened by one of
-- the named safe holders, in front of the camera, with the named
-- witness physically present. No codes, no PINs: the record is who
-- acted, who witnessed, and that it was on camera. The database refuses
-- any count or withdrawal that does not carry all three.
--
-- Model:
--   * Acting is the existing can_count_cash grant (it already gates
--     both Count cash and Take from safe). Narrowed here to Dylan and
--     Jade only.
--   * Witnessing is a new staff flag, is_safe_witness. Rob McCrindle
--     gets it. He has an account but was never a Lounge staff member,
--     so a staff row is created for him with no other permissions.
--   * Every lng_cash_counts and lng_cash_withdrawals row records
--     witness_id, witnessed_at and on_camera. A BEFORE INSERT trigger
--     enforces: witness present, witness is an active safe witness,
--     witness is not the actor, on_camera is true.
--
-- Historical rows predate the rule and keep null witness columns; the
-- trigger only guards new inserts.
--
-- Data statements are written so they no-op on the schema-only shadow.

-- ── Witness flag ─────────────────────────────────────────────────────
alter table public.lng_staff_members
  add column if not exists is_safe_witness boolean not null default false;

comment on column public.lng_staff_members.is_safe_witness is
  'May be recorded as the second person present when the safe is opened (counts and withdrawals). Does not grant any action on its own.';

-- ── Witness columns on the two safe-action tables ────────────────────
alter table public.lng_cash_counts
  add column if not exists witness_id uuid references public.accounts(id) on delete restrict,
  add column if not exists witnessed_at timestamptz,
  add column if not exists on_camera boolean;

alter table public.lng_cash_withdrawals
  add column if not exists witness_id uuid references public.accounts(id) on delete restrict,
  add column if not exists witnessed_at timestamptz,
  add column if not exists on_camera boolean;

create index if not exists lng_cash_counts_witness_idx on public.lng_cash_counts (witness_id);
create index if not exists lng_cash_withdrawals_witness_idx on public.lng_cash_withdrawals (witness_id);

-- ── Enforcement ──────────────────────────────────────────────────────
create or replace function public.lng_cash_assert_two_person(
  p_actor uuid,
  p_witness uuid,
  p_on_camera boolean,
  p_what text
)
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if p_witness is null then
    raise exception 'A % needs a safe witness present. Pick the witness before saving.', p_what
      using errcode = '23514';
  end if;
  if p_witness = p_actor then
    raise exception 'The safe witness must be a different person from the one doing the %.', p_what
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.lng_staff_members sm
     where sm.account_id = p_witness
       and sm.status = 'active'
       and sm.is_safe_witness = true
  ) then
    raise exception 'The chosen witness is not an active safe witness. Only staff flagged as Safe witness in Admin can witness a %.', p_what
      using errcode = '23514';
  end if;
  if coalesce(p_on_camera, false) is distinct from true then
    raise exception 'A % must be done in front of the camera. Confirm the camera before saving.', p_what
      using errcode = '23514';
  end if;
end
$function$;

create or replace function public.lng_cash_counts_two_person()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.lng_cash_assert_two_person(new.counted_by, new.witness_id, new.on_camera, 'cash count');
  if new.witnessed_at is null then new.witnessed_at := now(); end if;
  return new;
end
$function$;

drop trigger if exists lng_cash_counts_two_person on public.lng_cash_counts;
create trigger lng_cash_counts_two_person
  before insert on public.lng_cash_counts
  for each row
  execute function public.lng_cash_counts_two_person();

create or replace function public.lng_cash_withdrawals_two_person()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.lng_cash_assert_two_person(new.taken_by, new.witness_id, new.on_camera, 'withdrawal from the safe');
  if new.witnessed_at is null then new.witnessed_at := now(); end if;
  return new;
end
$function$;

drop trigger if exists lng_cash_withdrawals_two_person on public.lng_cash_withdrawals;
create trigger lng_cash_withdrawals_two_person
  before insert on public.lng_cash_withdrawals
  for each row
  execute function public.lng_cash_withdrawals_two_person();

-- The witness columns are part of the immutable record: no update
-- path exists for them (lng_cash_counts_update only allows pending
-- rows and the client never writes these fields after insert).

-- ── Data: who may act, who may witness ───────────────────────────────
-- No-ops on the shadow (no accounts rows there).

-- Only Dylan and Jade may count cash or take from the safe.
update public.lng_staff_members sm
   set can_count_cash = (a.login_email in ('dylan@lanquez.com', 'jade@venneir.com'))
  from public.accounts a
 where a.id = sm.account_id
   and (sm.can_count_cash = true or a.login_email in ('dylan@lanquez.com', 'jade@venneir.com'));

-- Rob McCrindle is the safe witness. Staff row with no other grants;
-- Reports is off explicitly because it defaults on.
insert into public.lng_staff_members (account_id, location_id, is_safe_witness, can_view_reports)
select a.id, a.location_id, true, false
  from public.accounts a
 where a.login_email = 'robb80@hotmail.co.uk'
on conflict (account_id) do update
   set is_safe_witness = true;

-- ── Safe position: carry the witness on withdrawal lines ─────────────
-- Same function as 20260907000011 with the witness name parts added to
-- withdrawal lines and to the anchor count, so the Activity card and
-- the count history can say who was present.
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
  if not (public.auth_can_count_cash() or public.auth_can_view_financials()) then
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
           acc.first_name as actor_first,
           acc.last_name  as actor_last,
           acc.name       as actor_name,
           wit.first_name as witness_first,
           wit.last_name  as witness_last,
           wit.name       as witness_name
      from public.lng_cash_withdrawals x
      left join public.accounts acc on acc.id = x.taken_by
      left join public.accounts wit on wit.id = x.witness_id
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
      - coalesce((select sum(amount_pence) from wd), 0),
    'baseline_pence', v_baseline,
    'location_id', v_loc,
    'period_start', v_since,
    'period_end', v_end,
    'payment_count', (select count(*) from pay_flagged where not fully_refunded),
    'refunded_sale_count', (select count(*) from pay_flagged where fully_refunded),
    'refund_count', (select count(*) from moved_ref),
    'withdrawal_count', (select count(*) from wd),
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
            'actor_first', actor_first,
            'actor_last', actor_last,
            'actor_name', actor_name,
            'witness_first', witness_first,
            'witness_last', witness_last,
            'witness_name', witness_name
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
