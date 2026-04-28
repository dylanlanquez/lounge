-- 20260428000021_lng_appointments_deposit.sql
--
-- Some Calendly event types take a deposit at booking time (e.g. £25 to
-- secure a Same-day Appliance slot). The deposit is paid through Calendly's
-- PayPal connection — funds land directly in Venneir's PayPal, not the
-- Stripe account Lounge runs the till on. Lounge needs to:
--   1. Capture the deposit info from the invitee.created webhook so the
--      receptionist sees it on the booking detail sheet.
--   2. Subtract it from the cart total at the till so they only collect
--      the balance — without this, patients get charged twice.
--
-- All columns nullable. NULL across the board = no deposit on this booking
-- (event type doesn't require one, or the booking pre-dates this column).
-- A populated deposit_external_id with no other fields would be a partial-
-- ingest bug; the webhook writes them as a unit.
--
-- Refunds are handled manually in PayPal — Lounge does not track refund
-- status. The receptionist refunds out-of-band; the deposit_pence here
-- continues to reflect the original captured amount for audit.
--
-- Rollback:
--   ALTER TABLE public.lng_appointments
--     DROP COLUMN deposit_pence,
--     DROP COLUMN deposit_currency,
--     DROP COLUMN deposit_provider,
--     DROP COLUMN deposit_external_id,
--     DROP COLUMN deposit_paid_at;

alter table public.lng_appointments
  add column if not exists deposit_pence       integer,
  add column if not exists deposit_currency    text,
  add column if not exists deposit_provider    text
    check (deposit_provider is null or deposit_provider in ('paypal', 'stripe')),
  add column if not exists deposit_external_id text,
  add column if not exists deposit_paid_at     timestamptz;

-- A non-null deposit must have an amount and a provider. Catches partial
-- writes from a misbehaving ingest.
alter table public.lng_appointments
  add constraint lng_appointments_deposit_shape
  check (
    (deposit_pence is null and deposit_provider is null and deposit_paid_at is null)
    or
    (deposit_pence is not null and deposit_pence >= 0 and deposit_provider is not null)
  );

comment on column public.lng_appointments.deposit_pence is
  'Deposit paid at booking time, in pence. NULL when the event type takes no deposit, or the booking pre-dates Calendly deposit ingest.';
comment on column public.lng_appointments.deposit_provider is
  'Source of the deposit: paypal (current) or stripe (future). NULL when no deposit.';
comment on column public.lng_appointments.deposit_external_id is
  'PayPal transaction id (or Stripe charge id, future). Used for matching when reconciling against PayPal payouts.';
