-- 20260428000022_lng_appointments_deposit_status.sql
--
-- Add deposit_status so the till can distinguish a successful deposit from
-- a failed attempt. Calendly bookings can land with payment.successful =
-- false (card declined, PayPal cancellation, etc.) — Lounge needs to show
-- those as a payment-error state on the detail sheet so the receptionist
-- knows to chase before checkout.
--
-- States:
--   'paid'    successful capture (Calendly's payment.successful === true)
--   'failed'  attempt recorded but payment did not complete
--   (NULL)    no deposit info captured (event type takes no deposit, or
--             pre-deposit-ingest legacy row)
--
-- Pending state is omitted: Calendly's webhook only fires AFTER the
-- payment terminates, so we never see in-flight states. If that changes
-- we'll add it.
--
-- Backfill: every existing deposit row pre-dates this migration and was
-- only inserted on success (extractDeposit dropped failures), so all
-- existing non-null deposits get status='paid'.
--
-- Rollback:
--   ALTER TABLE public.lng_appointments
--     DROP CONSTRAINT lng_appointments_deposit_shape,
--     DROP COLUMN deposit_status,
--     ADD CONSTRAINT lng_appointments_deposit_shape CHECK (
--       (deposit_pence is null and deposit_provider is null and deposit_paid_at is null)
--       or (deposit_pence is not null and deposit_pence >= 0 and deposit_provider is not null)
--     );

alter table public.lng_appointments
  add column if not exists deposit_status text
    check (deposit_status is null or deposit_status in ('paid', 'failed'));

-- Existing deposit rows are by definition successful (failures weren't
-- captured before this migration). Backfill them so the new CHECK passes.
update public.lng_appointments
  set deposit_status = 'paid'
  where deposit_pence is not null and deposit_status is null;

alter table public.lng_appointments
  drop constraint if exists lng_appointments_deposit_shape;

-- New shape: deposit_status is the gating field. When set, deposit_pence
-- and deposit_provider must also be set (the attempted amount + provider,
-- regardless of success). When null, every deposit field is null.
alter table public.lng_appointments
  add constraint lng_appointments_deposit_shape check (
    (deposit_status is null
      and deposit_pence is null
      and deposit_provider is null
      and deposit_paid_at is null)
    or
    (deposit_status in ('paid', 'failed')
      and deposit_pence is not null
      and deposit_pence >= 0
      and deposit_provider is not null)
  );

comment on column public.lng_appointments.deposit_status is
  'paid | failed | NULL. NULL means no deposit info captured. Pending state is not used — Calendly webhooks fire after the payment terminates.';
