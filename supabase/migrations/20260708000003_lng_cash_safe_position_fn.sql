-- 20260708000003_lng_cash_safe_position_fn.sql
--
-- Single source of truth for "what should be in the safe right now".
--
-- Until now this figure was summed on the CLIENT from four separately
-- RLS-gated tables (lng_cash_counts, lng_payments, lng_payment_refunds,
-- lng_cash_withdrawals). Because each table has its own read policy, the
-- answer depended on WHO was asking: a counter without can_view_financials
-- could not read the anchor count or the withdrawals, so their browser
-- silently computed baseline 0 + every cash payment ever and never
-- subtracted the bank deposit (Jade Cassidy saw £914 instead of £284).
-- A second surface (Reports -> Cash drawer) computed the same figure a
-- THIRD way, omitting withdrawals and refunds entirely. Three consumers,
-- three possible numbers, for one physical safe.
--
-- This function makes the computation authoritative and identical for
-- every caller:
--   * SECURITY DEFINER, so it reads all four inputs with one consistent
--     access level rather than the caller's patchwork of RLS grants.
--   * ONE authorization boundary at the top (can_count_cash OR
--     can_view_financials); everyone allowed past it computes the same
--     number by construction.
--   * LOCATION AWARE. Each location keeps its own safe and its own count
--     chain. p_location_id defaults to the caller's own account location
--     (the /cash-counts case); financials viewers may pass an explicit
--     location (the multi-location Reports case). A counter may only read
--     their own location's safe. The previous client hook anchored on the
--     globally-latest signed count regardless of location, which happened
--     to work only because all cash lives at one location today.
--
-- Algorithm (unchanged in spirit from the client, corrected in reach):
--   baseline  = last SIGNED count at this location (actual_pence, else 0)
--   window    = (last count period_end, now]   -- half-open, so a payment
--               exactly on a count boundary is never counted twice
--   + cash payments kept in the window (succeeded/cancelled, minus any
--     that were fully refunded in-window -- those net to zero and are
--     reported as refunded_sale lines, never as cash in)
--   - cash refunds that actually moved the safe (partial clawbacks and
--     refunds against prior-period sales; a full same-window refund is
--     already netted by excluding its sale)
--   - cash withdrawals in the window (bank deposit, float top-up, etc.)
--
-- Returns a JSON object shaped for the client: the number, the baseline,
-- per-kind counts, earliest/latest activity, the anchor count, and the
-- interleaved activity lines (newest first). Patient / actor names are
-- returned as raw first/last parts so the client keeps ownership of
-- presentation (Title-casing) while the server owns the money maths.

create or replace function public.lng_cash_safe_position(p_location_id uuid default null)
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
  v_end timestamptz := now();
  v_baseline integer;
  v_last_id uuid;
  v_last_period_end timestamptz;
  v_last_actual integer;
  v_last_signed_at timestamptz;
  v_result jsonb;
begin
  -- Single authorization boundary.
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
  -- A counter may only read their own location's safe; reading another
  -- location's position is a financials-viewer capability.
  if p_location_id is not null
     and p_location_id <> v_caller_loc
     and not public.auth_can_view_financials() then
    raise exception 'not authorized to view another location''s cash position'
      using errcode = '42501';
  end if;

  -- Anchor: the most recent SIGNED count at this location.
  select id, period_end, actual_pence, signed_off_at
    into v_last_id, v_last_period_end, v_last_actual, v_last_signed_at
    from public.lng_cash_counts
   where status = 'signed'
     and location_id = v_loc
   order by period_end desc, signed_off_at desc nulls last, id
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
           c.total_pence as cart_total_pence
      from public.lng_payments p
      join public.lng_carts c on c.id = p.cart_id
      join public.lng_visits v on v.id = c.visit_id
      left join public.patients pt on pt.id = v.patient_id
      left join public.lng_appointments ap on ap.id = v.appointment_id
      left join public.lng_walk_ins wi on wi.id = v.walk_in_id
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
           acc.first_name as actor_first,
           acc.last_name  as actor_last,
           acc.name       as actor_name
      from public.lng_cash_withdrawals x
      left join public.accounts acc on acc.id = x.taken_by
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
        'signed_off_at', v_last_signed_at
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
            'cart_total_pence', cart_total_pence
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
            'visit_id', visit_id
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
            'actor_first', actor_first,
            'actor_last', actor_last,
            'actor_name', actor_name
          )
          from wd
        ) lines_src
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end
$function$;

comment on function public.lng_cash_safe_position(uuid) is
  'Authoritative "what should be in the safe right now" for one location. SECURITY DEFINER so every permitted caller (can_count_cash OR can_view_financials) gets the identical figure, computed from all four inputs regardless of the caller''s per-table RLS. Defaults to the caller''s own location; financials viewers may pass another. Returns number + baseline + counts + activity lines as JSON.';

revoke all on function public.lng_cash_safe_position(uuid) from public;
grant execute on function public.lng_cash_safe_position(uuid) to authenticated;
