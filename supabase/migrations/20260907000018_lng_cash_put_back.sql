-- 20260907000018_lng_cash_put_back.sql
--
-- "Put it back": a reversed withdrawal whose cash is still in the safe
-- but was NOT part of the last count.
--
-- Case from 7 Sep 2026: "WHW supplies" £88.50 was paid by card, but a
-- cash withdrawal was recorded by mistake and the count was signed
-- with that deduction in it. Reversing it (20260907000016) restated the
-- count's expected, on the assumption the cash was inside the counted
-- total. Dylan's instruction: the £88.50 must come back into Right now.
--
-- Model: a cash ADJUSTMENT row in the open period (+amount, reason,
-- who, when, linked to the withdrawal). The safe position adds
-- adjustments to the running balance and returns them as lines, so the
-- activity card, CSV and PDF all show "+£88.50 · put back". If the
-- reversal had restated a count, the restatement is undone (the count
-- did not include the cash after all).
--
-- Two ways in, both super admin only:
--   * lng_cash_reverse_withdrawal(..., p_put_back => true) for a new
--     reversal: no restatement, adjustment created.
--   * lng_cash_put_back_withdrawal(withdrawal_id, reason) for a
--     withdrawal reversed earlier: undo the restatement, create the
--     adjustment. Idempotent via put_back_adjustment_id.

-- ── Adjustments ──────────────────────────────────────────────────────
create table if not exists public.lng_cash_adjustments (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete restrict,
  -- Positive = cash added to the running balance, negative = removed.
  amount_pence integer not null check (amount_pence <> 0),
  reason text not null,
  withdrawal_id uuid references public.lng_cash_withdrawals(id) on delete restrict,
  created_by uuid not null references public.accounts(id) on delete restrict,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.lng_cash_adjustments is
  'Super-admin corrections to the running safe balance that are not payments, refunds or withdrawals: currently "put back" a reversed withdrawal whose cash never left the safe and was not in the last count.';

create index if not exists lng_cash_adjustments_loc_time_idx
  on public.lng_cash_adjustments (location_id, occurred_at);

alter table public.lng_cash_adjustments enable row level security;
drop policy if exists lng_cash_adjustments_read on public.lng_cash_adjustments;
create policy lng_cash_adjustments_read on public.lng_cash_adjustments
  for select to authenticated
  using (public.auth_can_view_financials() or public.auth_can_count_cash() or public.auth_can_view_safe());
-- No insert/update/delete policies: written only by the SECURITY
-- DEFINER functions below.

alter table public.lng_cash_withdrawals
  add column if not exists restated_count_id uuid references public.lng_cash_counts(id) on delete set null,
  add column if not exists put_back_adjustment_id uuid references public.lng_cash_adjustments(id) on delete set null;

-- Backfill restated_count_id from the event log for reversals made
-- before this column existed (the WHW reversal).
update public.lng_cash_withdrawals w
   set restated_count_id = (e.payload->>'restated_count_id')::uuid
  from public.lng_event_log e
 where e.source = 'cash_counts'
   and e.event_type = 'cash_withdrawal_reversed'
   and (e.payload->>'withdrawal_id')::uuid = w.id
   and e.payload->>'restated_count_id' is not null
   and w.restated_count_id is null;
-- The very first reversal was restated by the 20260907000016 backfill
-- rather than by the function; link it too.
update public.lng_cash_withdrawals w
   set restated_count_id = c.id
  from public.lng_cash_counts c
 where w.reversed_at is not null
   and w.restated_count_id is null
   and c.status = 'signed'
   and c.location_id = w.location_id
   and w.taken_at > c.period_start
   and w.taken_at <= c.period_end
   and exists (
     select 1 from public.lng_event_log e
      where e.event_type = 'cash_withdrawal_restated_count'
        and (e.payload->>'withdrawal_id')::uuid = w.id
   );

-- ── Put back an already-reversed withdrawal ──────────────────────────
create or replace function public.lng_cash_put_back_withdrawal(p_withdrawal_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me uuid;
  v_row public.lng_cash_withdrawals%rowtype;
  v_adj_id uuid;
  v_expected_before integer;
  v_expected_after integer;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only the super admin can put a withdrawal back.' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Say why the cash is being put back.' using errcode = '22023';
  end if;
  select a.id into v_me from public.accounts a where a.auth_user_id = auth.uid();
  select * into v_row from public.lng_cash_withdrawals where id = p_withdrawal_id for update;
  if v_row.id is null then
    raise exception 'Withdrawal not found.' using errcode = 'P0002';
  end if;
  if v_row.reversed_at is null then
    raise exception 'Reverse the withdrawal first, then put it back.' using errcode = '22023';
  end if;
  if v_row.put_back_adjustment_id is not null then
    raise exception 'This withdrawal was already put back.' using errcode = '22023';
  end if;

  -- The cash was not in the count after all: undo the restatement.
  if v_row.restated_count_id is not null then
    select expected_pence into v_expected_before from public.lng_cash_counts where id = v_row.restated_count_id;
    if v_expected_before is not null then
      v_expected_after := greatest(0, v_expected_before - v_row.amount_pence);
      update public.lng_cash_counts set expected_pence = v_expected_after where id = v_row.restated_count_id;
    end if;
  end if;

  insert into public.lng_cash_adjustments (location_id, amount_pence, reason, withdrawal_id, created_by)
  values (v_row.location_id, v_row.amount_pence, trim(p_reason), v_row.id, v_me)
  returning id into v_adj_id;

  update public.lng_cash_withdrawals set put_back_adjustment_id = v_adj_id where id = v_row.id;

  insert into public.lng_event_log (source, event_type, account_id, location_id, payload)
  values (
    'cash_counts', 'cash_withdrawal_put_back', v_me, v_row.location_id,
    jsonb_build_object(
      'withdrawal_id', v_row.id, 'amount_pence', v_row.amount_pence, 'note', v_row.note,
      'adjustment_id', v_adj_id, 'reason', trim(p_reason),
      'unrestated_count_id', v_row.restated_count_id,
      'count_expected_before', v_expected_before, 'count_expected_after', v_expected_after
    )
  );

  return jsonb_build_object(
    'withdrawal_id', v_row.id, 'adjustment_id', v_adj_id, 'amount_pence', v_row.amount_pence,
    'unrestated_count_id', v_row.restated_count_id,
    'count_expected_before', v_expected_before, 'count_expected_after', v_expected_after
  );
end
$function$;

revoke all on function public.lng_cash_put_back_withdrawal(uuid, text) from public;
grant execute on function public.lng_cash_put_back_withdrawal(uuid, text) to authenticated;

-- ── Reverse with an explicit choice ──────────────────────────────────
drop function if exists public.lng_cash_reverse_withdrawal(uuid, text);
create or replace function public.lng_cash_reverse_withdrawal(p_withdrawal_id uuid, p_reason text, p_put_back boolean default false)
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
  v_adj_id uuid;
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
     set reversed_at = now(), reversed_by = v_me, reversal_reason = trim(p_reason)
   where id = p_withdrawal_id;

  if not v_in_open_period then
    if coalesce(p_put_back, false) then
      -- The cash never left and was not in the count: add it back to the
      -- running balance now, leave the count's figures as signed.
      insert into public.lng_cash_adjustments (location_id, amount_pence, reason, withdrawal_id, created_by)
      values (v_row.location_id, v_row.amount_pence, trim(p_reason), v_row.id, v_me)
      returning id into v_adj_id;
      update public.lng_cash_withdrawals set put_back_adjustment_id = v_adj_id where id = v_row.id;
    else
      -- The cash never left and WAS in the count: the count's expected
      -- was too low by this amount; restate it.
      select * into v_count
        from public.lng_cash_counts
       where status = 'signed' and location_id = v_row.location_id
         and v_row.taken_at > period_start and v_row.taken_at <= period_end
       order by period_end limit 1 for update;
      if v_count.id is not null then
        v_expected_before := v_count.expected_pence;
        v_expected_after := v_count.expected_pence + v_row.amount_pence;
        update public.lng_cash_counts set expected_pence = v_expected_after where id = v_count.id;
        update public.lng_cash_withdrawals set restated_count_id = v_count.id where id = v_row.id;
      end if;
    end if;
  end if;

  insert into public.lng_event_log (source, event_type, account_id, location_id, payload)
  values (
    'cash_counts', 'cash_withdrawal_reversed', v_me, v_row.location_id,
    jsonb_build_object(
      'withdrawal_id', p_withdrawal_id, 'amount_pence', v_row.amount_pence, 'reason', v_row.reason,
      'note', v_row.note, 'taken_at', v_row.taken_at, 'taken_by', v_row.taken_by,
      'reversal_reason', trim(p_reason), 'moves_balance', v_in_open_period or coalesce(p_put_back, false),
      'put_back', coalesce(p_put_back, false), 'adjustment_id', v_adj_id,
      'restated_count_id', v_count.id, 'count_expected_before', v_expected_before, 'count_expected_after', v_expected_after
    )
  );

  return jsonb_build_object(
    'withdrawal_id', p_withdrawal_id,
    'moves_balance', v_in_open_period or coalesce(p_put_back, false),
    'put_back', coalesce(p_put_back, false),
    'adjustment_id', v_adj_id,
    'restated_count_id', v_count.id,
    'count_expected_before', v_expected_before,
    'count_expected_after', v_expected_after
  );
end
$function$;

revoke all on function public.lng_cash_reverse_withdrawal(uuid, text, boolean) from public;
grant execute on function public.lng_cash_reverse_withdrawal(uuid, text, boolean) to authenticated;

-- Realtime: the Cash counts page refreshes on adjustment inserts.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lng_cash_adjustments'
     ) then
    alter publication supabase_realtime add table public.lng_cash_adjustments;
  end if;
end $$;
