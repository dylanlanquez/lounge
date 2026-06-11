-- MOTO (telephone / card-not-present) payments.
--
-- Adds the "Over the phone" payment path alongside the in-person S700
-- Terminal flow. A MOTO charge is collected with Stripe Elements on the
-- tablet (PaymentMethod created client-side), then confirmed server-side in
-- the lng-moto-payment edge function with payment_method_options[card][moto].
--
-- This migration is purely additive:
--   1. lng_payments.method gains 'card_moto' so MOTO charges sit in the same
--      payments ledger as every other method (cart reconciliation, Meridian
--      linkage and split-payment maths are unchanged).
--   2. lng_moto_payments mirrors lng_terminal_payments but without the
--      reader/location columns (a phone charge has no physical reader). It
--      links a lng_payments row to its Stripe PaymentIntent and records the
--      decline_code for staff troubleshooting.
--
-- Nothing here touches the in-person flow: lng_terminal_payments, the
-- terminal-* functions and the terminal-webhook are all left exactly as they
-- are. The MOTO PaymentIntent deliberately omits the metadata.cart_id key the
-- terminal-webhook keys on, so that webhook is a guaranteed no-op for MOTO
-- and the lng-moto-payment function is the single writer of MOTO outcomes.

begin;

-- 1. Allow 'card_moto' in the payments ledger.
alter table public.lng_payments
  drop constraint lng_payments_method_check;
alter table public.lng_payments
  add constraint lng_payments_method_check
  check (method = any (array[
    'card_terminal'::text,
    'cash'::text,
    'gift_card'::text,
    'account_credit'::text,
    'klarna'::text,
    'card_moto'::text
  ]));

-- 2. MOTO payment link table (mirror of lng_terminal_payments, no reader).
create table public.lng_moto_payments (
  id                        uuid primary key default gen_random_uuid(),
  payment_id                uuid not null unique references public.lng_payments(id) on delete cascade,
  stripe_payment_intent_id  text not null unique,
  idempotency_key           text not null unique,
  -- Stripe decline_code (e.g. 'insufficient_funds') when the bank refuses
  -- the charge. Drives the staff-facing message + next action. Null on
  -- success or on a non-decline error.
  decline_code              text,
  raw_result                jsonb,
  created_at                timestamptz not null default now(),
  succeeded_at              timestamptz,
  updated_at                timestamptz not null default now()
);

comment on table public.lng_moto_payments is
  'Card-not-present (telephone) payments confirmed server-side with the Stripe MOTO flag. One row per lng_payments row of method card_moto.';

alter table public.lng_moto_payments enable row level security;

-- Read policies mirror lng_terminal_payments exactly. All writes go through
-- the service-role edge function (which bypasses RLS), so there are no
-- insert/update policies for authenticated callers by design.
create policy lng_moto_payments_admin_select
  on public.lng_moto_payments for select
  to authenticated
  using (public.is_admin());

create policy lng_moto_payments_staff_select
  on public.lng_moto_payments for select
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin());

commit;
