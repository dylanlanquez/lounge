-- Adds card_brand + card_last4 to lng_payments and lng_appointments.
-- Populated by the Stripe webhooks on payment_intent.succeeded so the
-- RefundSheet can render "Visa ending in 4242" on the "Going back to"
-- row instead of the generic "Card at the till".
--
-- Cash + gift-card payments stay NULL — the columns only carry data
-- for card-backed sources.

alter table lng_payments
  add column if not exists card_brand text,
  add column if not exists card_last4 text;

alter table lng_appointments
  add column if not exists card_brand text,
  add column if not exists card_last4 text;

-- Light sanity check on last4. Stripe always returns 4 digits, but
-- guarding the column means a bad webhook payload can never leak a
-- truncated string into the UI.
alter table lng_payments
  drop constraint if exists lng_payments_card_last4_shape,
  add constraint lng_payments_card_last4_shape
    check (card_last4 is null or card_last4 ~ '^[0-9]{4}$');

alter table lng_appointments
  drop constraint if exists lng_appointments_card_last4_shape,
  add constraint lng_appointments_card_last4_shape
    check (card_last4 is null or card_last4 ~ '^[0-9]{4}$');

comment on column lng_payments.card_brand is
  'Stripe card brand (e.g. visa, mastercard) for the source card. NULL for cash, gift cards, or pre-launch payments captured before the webhook started recording card details.';
comment on column lng_payments.card_last4 is
  'Last 4 digits of the card used. NULL when not applicable (cash) or not yet captured by the webhook.';
comment on column lng_appointments.card_brand is
  'Stripe card brand for the widget-paid deposit. NULL when no deposit was taken, or when captured before the webhook started recording these.';
comment on column lng_appointments.card_last4 is
  'Last 4 digits of the deposit card. NULL when no deposit, or when not yet captured.';
