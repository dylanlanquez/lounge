-- 20260907000014_lng_cash_safe_viewer_and_total_only.sql
--
-- Two follow-ups from Dylan's review of the 7 Sep cash-count work.
--
-- 1. Who sees the safe. The Cash counts page and its top-bar wallet
--    icon were reachable by anyone with can_count_cash OR
--    can_view_financials. Dylan wants exactly three people to see it:
--    Jade and Dylan (safe holders) and Stephen Vazquez (view only).
--    Financials access no longer opens the page. A new staff flag,
--    can_view_safe ("Safe viewer" in Admin -> Staff), grants read-only
--    access; safe holders see it by virtue of being holders.
--
--    The read side follows the same rule: the safe-position function and
--    the SELECT policies on the cash tables accept can_view_safe too.
--    can_view_financials stays on those reads because Admin -> Reports ->
--    Cash drawer still shows the same figure to finance viewers.
--
-- 2. Total only. The note-and-coin breakdown is gone from the count
--    sheet: the counter types the total. The denominations table and its
--    sign-off trigger (20260907000010) are dropped so nothing is left
--    half-used. No production row was ever written to it.
--
-- 3. No manager sign-off. The witness is the second person on a count;
--    the count is signed off by the witness (signed_off_by = witness_id),
--    which already satisfies the counter/signer distinct check because
--    the two-person trigger refuses a witness equal to the counter.
--    No schema change needed for this; noted here for the record.

-- ── 1. Safe viewer ──────────────────────────────────────────────────
alter table public.lng_staff_members
  add column if not exists can_view_safe boolean not null default false;

comment on column public.lng_staff_members.can_view_safe is
  'May open the Cash counts page read-only (see the safe figure, activity, past counts, exports). Safe holders (can_count_cash) see it without this flag.';

create or replace function public.auth_can_view_safe()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.auth_is_super_admin() or exists (
    select 1
      from public.lng_staff_members sm
      join public.accounts a on a.id = sm.account_id
     where a.auth_user_id = auth.uid()
       and sm.status = 'active'
       and sm.can_view_safe = true
  );
$function$;

revoke all on function public.auth_can_view_safe() from public;
grant execute on function public.auth_can_view_safe() to authenticated;

-- Read policies: holders, viewers, and finance readers.
drop policy if exists lng_cash_counts_read on public.lng_cash_counts;
create policy lng_cash_counts_read on public.lng_cash_counts
  for select to authenticated
  using (public.auth_can_view_financials() or public.auth_can_count_cash() or public.auth_can_view_safe());

drop policy if exists lng_cash_withdrawals_read on public.lng_cash_withdrawals;
create policy lng_cash_withdrawals_read on public.lng_cash_withdrawals
  for select to authenticated
  using (public.auth_can_view_financials() or public.auth_can_count_cash() or public.auth_can_view_safe());

drop policy if exists lng_cash_count_lines_read on public.lng_cash_count_lines;
create policy lng_cash_count_lines_read on public.lng_cash_count_lines
  for select to authenticated
  using (public.auth_can_view_financials() or public.auth_can_count_cash() or public.auth_can_view_safe());

drop policy if exists lng_cash_count_withdrawal_lines_read on public.lng_cash_count_withdrawal_lines;
create policy lng_cash_count_withdrawal_lines_read on public.lng_cash_count_withdrawal_lines
  for select to authenticated
  using (public.auth_can_view_financials() or public.auth_can_count_cash() or public.auth_can_view_safe());

-- Stephen Vazquez: view only. Dylan and Jade already hold can_count_cash.
update public.lng_staff_members sm
   set can_view_safe = true
  from public.accounts a
 where a.id = sm.account_id
   and a.login_email = 'stephen.vazquez@venneir.com';

-- ── 2. Drop the denomination breakdown ──────────────────────────────
drop trigger if exists lng_cash_counts_check_denominations on public.lng_cash_counts;
drop function if exists public.lng_cash_counts_check_denominations();
drop table if exists public.lng_cash_count_denominations;

-- ── 1b. Safe position: accept safe viewers at the single auth check ──
-- Only the authorization line changes from 20260907000012; the body is
-- repeated because plpgsql functions replace whole.
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

-- ── 4. Unrecorded envelopes logged on a count ────────────────────────
-- Every cash payment goes into the safe in an envelope marked with the
-- order number and the customer's name. When a count finds MORE cash
-- than Lounge expects, the counter takes out every envelope, matches
-- each one to the recorded payments, and logs the leftovers here: what
-- was on the envelope, how much was in it, and which employee processed
-- it. Immutable once the count is signed; Dylan reviews them from the
-- count's details.
create table if not exists public.lng_cash_count_unrecorded (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references public.lng_cash_counts(id) on delete cascade,
  amount_pence integer not null check (amount_pence > 0),
  order_ref text,
  customer_name text,
  -- Staff member whose name / handwriting is on the envelope.
  processed_by uuid references public.accounts(id) on delete restrict,
  note text,
  created_at timestamptz not null default now(),
  constraint lng_cash_count_unrecorded_has_detail
    check (coalesce(order_ref, '') <> '' or coalesce(customer_name, '') <> '')
);

comment on table public.lng_cash_count_unrecorded is
  'Envelopes found in the safe at a count that no recorded cash payment matches: envelope details, amount, and the employee who processed it. Written with the count, immutable once signed.';

create index if not exists lng_cash_count_unrecorded_count_idx
  on public.lng_cash_count_unrecorded (count_id);

alter table public.lng_cash_count_unrecorded enable row level security;

drop policy if exists lng_cash_count_unrecorded_read on public.lng_cash_count_unrecorded;
create policy lng_cash_count_unrecorded_read on public.lng_cash_count_unrecorded
  for select to authenticated
  using (public.auth_can_view_financials() or public.auth_can_count_cash() or public.auth_can_view_safe());

drop policy if exists lng_cash_count_unrecorded_insert on public.lng_cash_count_unrecorded;
create policy lng_cash_count_unrecorded_insert on public.lng_cash_count_unrecorded
  for insert to authenticated
  with check (
    public.auth_can_count_cash()
    and exists (
      select 1 from public.lng_cash_counts c
       where c.id = count_id and c.status = 'pending'
    )
  );
