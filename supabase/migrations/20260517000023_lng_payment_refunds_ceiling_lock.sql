-- 20260517000023_lng_payment_refunds_ceiling_lock.sql
--
-- Tighten the ceiling trigger from yesterday's migration so it
-- actually serialises across concurrent transactions.
--
-- The original version read v_captured + v_cumulative without a
-- row lock. Under PostgreSQL's default READ COMMITTED isolation
-- two concurrent inserts each see the parent payment's snapshot
-- before either has committed, both pass their independent checks,
-- and the committed sum can exceed the captured amount. Exactly
-- the race the trigger was meant to close.
--
-- Fix: SELECT ... FOR UPDATE the parent row (payment or
-- appointment) inside the trigger. The lock is held for the rest
-- of the calling transaction so the second concurrent refund
-- blocks waiting on the first, then re-reads cumulative after the
-- first commits.
--
-- Lock scope is brief — the rest of the refund insert is fast —
-- and doesn't escalate to anything riskier because the same
-- transaction already needs to write the refund row.

create or replace function public.lng_payment_refunds_enforce_ceiling()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_captured int;
  v_cumulative int;
begin
  -- Failed rows don't move money, skip.
  if NEW.status = 'failed' then
    return NEW;
  end if;

  if NEW.payment_id is not null then
    -- Row lock on the parent payment serialises concurrent refund
    -- inserts against the same source.
    select amount_pence into v_captured
      from public.lng_payments
     where id = NEW.payment_id
     for update;
    if v_captured is null then
      raise exception 'refund.parent.payment.not_found' using errcode = 'foreign_key_violation';
    end if;
    select coalesce(sum(amount_pence), 0) into v_cumulative
      from public.lng_payment_refunds
     where payment_id = NEW.payment_id
       and status in ('pending', 'succeeded')
       and (TG_OP = 'INSERT' or id <> NEW.id);
  elsif NEW.deposit_appointment_id is not null then
    select coalesce(deposit_pence, 0) into v_captured
      from public.lng_appointments
     where id = NEW.deposit_appointment_id
       and deposit_status = 'paid'
     for update;
    if v_captured is null then
      raise exception 'refund.parent.deposit.not_found' using errcode = 'foreign_key_violation';
    end if;
    select coalesce(sum(amount_pence), 0) into v_cumulative
      from public.lng_payment_refunds
     where deposit_appointment_id = NEW.deposit_appointment_id
       and status in ('pending', 'succeeded')
       and (TG_OP = 'INSERT' or id <> NEW.id);
  else
    raise exception 'refund.no_source' using errcode = 'check_violation';
  end if;

  if v_cumulative + NEW.amount_pence > v_captured then
    raise exception
      'refund.exceeds_ceiling: requested % + already_refunded % > captured %',
      NEW.amount_pence, v_cumulative, v_captured
      using errcode = 'check_violation';
  end if;

  return NEW;
end;
$$;

comment on function public.lng_payment_refunds_enforce_ceiling() is
  'DB-level guard against concurrent refund overflow. Sums pending + succeeded refunds against the source (payment or deposit) and rejects when the cumulative would exceed the captured amount. Locks the parent row (SELECT FOR UPDATE) so two concurrent refund inserts serialise — without the lock READ COMMITTED isolation lets both passes through.';
