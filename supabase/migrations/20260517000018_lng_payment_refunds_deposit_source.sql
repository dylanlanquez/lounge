-- lng_payment_refunds — accept widget-deposit refunds.
--
-- The first refund migration assumed every refund had a parent
-- lng_payments row. That covered cash + card-at-till but missed the
-- biggest real-world case: the customer paid in full via the public
-- booking widget. That payment lives on lng_appointments
-- (deposit_external_id is the Stripe PI; deposit_pence is the
-- captured amount) and never becomes an lng_payments row.
--
-- This migration relaxes the schema so a refund can attach to EITHER
-- a payment OR an appointment-deposit:
--
--   • payment_id is now nullable.
--   • deposit_appointment_id (FK → lng_appointments) is new.
--   • A check constraint forces exactly one of them per row.
--   • A trigger keeps method consistent with the source (deposit
--     refunds are always card_terminal — Stripe-issued).

alter table public.lng_payment_refunds
  alter column payment_id drop not null,
  add column if not exists deposit_appointment_id uuid references public.lng_appointments(id) on delete restrict;

alter table public.lng_payment_refunds
  add constraint lng_payment_refunds_exactly_one_source_check
    check (
      (payment_id is not null and deposit_appointment_id is null)
      or
      (payment_id is null and deposit_appointment_id is not null)
    );

create index if not exists lng_payment_refunds_deposit_appointment_idx
  on public.lng_payment_refunds (deposit_appointment_id)
  where deposit_appointment_id is not null;

comment on column public.lng_payment_refunds.deposit_appointment_id is
  'Set when the refund is against the appointment''s widget-time deposit (lng_appointments.deposit_external_id). Mutually exclusive with payment_id; the check constraint enforces exactly-one. Refunds against an appointment deposit route through the same terminal-refund edge function — they call Stripe /refunds against the deposit''s PI.';

-- The receptionist RLS policy joined through lng_payments to reach
-- the visit / location. Deposit refunds don't have a payment_id, so
-- we expand the policy to also allow rows whose deposit_appointment
-- _id points at an appointment in the receptionist's location.
drop policy if exists lng_payment_refunds_receptionist_select
  on public.lng_payment_refunds;

create policy lng_payment_refunds_receptionist_select
  on public.lng_payment_refunds for select
  to authenticated
  using (
    public.auth_is_receptionist()
    and (
      payment_id in (
        select p.id from public.lng_payments p
          join public.lng_carts c on c.id = p.cart_id
          join public.lng_visits v on v.id = c.visit_id
         where v.location_id = public.auth_location_id()
      )
      or
      deposit_appointment_id in (
        select a.id from public.lng_appointments a
         where a.location_id = public.auth_location_id()
      )
    )
  );
