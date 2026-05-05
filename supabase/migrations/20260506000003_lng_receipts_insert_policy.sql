-- 20260506000003_lng_receipts_insert_policy.sql
--
-- Adds an INSERT RLS policy on lng_receipts so receptionists can queue
-- a receipt row from the client (Pay.tsx) immediately after a payment
-- succeeds. The write is scoped to payments that belong to their
-- location via cart → visit → location. The send-receipt edge function
-- then reads the row with service-role and handles delivery.
--
-- Rollback: drop policy lng_receipts_receptionist_insert on public.lng_receipts;

create policy lng_receipts_receptionist_insert
  on public.lng_receipts for insert
  to authenticated
  with check (
    public.auth_is_receptionist()
    and payment_id in (
      select p.id from public.lng_payments p
        join public.lng_carts c   on c.id = p.cart_id
        join public.lng_visits v  on v.id = c.visit_id
       where v.location_id = public.auth_location_id()
    )
  );
