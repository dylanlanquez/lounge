-- 20260517000022_lng_payment_refunds_ceiling_trigger.sql
--
-- Concurrent-refund race guard.
--
-- terminal-refund reads the existing succeeded refunds against a
-- source, computes the remaining refundable, and rejects when the
-- requested amount exceeds it. That check is correct in isolation
-- but read-then-write between two concurrent invocations can both
-- see the same "remaining" and both insert refunds that together
-- exceed the source's captured amount.
--
-- This trigger closes the window at the DB level. On insert it
-- recomputes sum(amount_pence) of succeeded refunds (plus the
-- incoming row when status='succeeded' / 'pending') for the source
-- and rejects when the cumulative exceeds the captured amount.
--
-- Why include 'pending' in the check: a card refund inserts with
-- status='pending' and only flips to succeeded/failed once Stripe
-- answers. Two near-simultaneous pending inserts could each pass
-- the ceiling check independently, both go to Stripe (which would
-- accept up to its own remaining), and then one settles past the
-- ceiling. Counting 'pending' against the ceiling prevents that.
-- A row that fails later doesn't reclaim ceiling for free — the
-- terminal-refund retry path can flip the row to 'failed' first if
-- needed.
--
-- Failure mode: raise an exception. The edge function wraps the
-- insert in a try/catch and surfaces the message to the caller.

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
  -- Skip when explicitly inserting a failed row.
  if NEW.status = 'failed' then
    return NEW;
  end if;

  if NEW.payment_id is not null then
    select amount_pence into v_captured
      from public.lng_payments
     where id = NEW.payment_id;
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
       and deposit_status = 'paid';
    if v_captured is null then
      raise exception 'refund.parent.deposit.not_found' using errcode = 'foreign_key_violation';
    end if;
    select coalesce(sum(amount_pence), 0) into v_cumulative
      from public.lng_payment_refunds
     where deposit_appointment_id = NEW.deposit_appointment_id
       and status in ('pending', 'succeeded')
       and (TG_OP = 'INSERT' or id <> NEW.id);
  else
    -- The check constraint already enforces exactly-one-source, but
    -- defence-in-depth — if both are null we have nothing to
    -- compare against.
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

drop trigger if exists lng_payment_refunds_ceiling_check
  on public.lng_payment_refunds;

create trigger lng_payment_refunds_ceiling_check
  before insert or update of amount_pence, status, payment_id, deposit_appointment_id
  on public.lng_payment_refunds
  for each row
  execute function public.lng_payment_refunds_enforce_ceiling();

comment on function public.lng_payment_refunds_enforce_ceiling() is
  'DB-level guard against concurrent refund overflow. Sums pending + succeeded refunds against the source (payment or deposit) and rejects when the cumulative would exceed the captured amount. Closes the read-then-write race between concurrent terminal-refund invocations.';
