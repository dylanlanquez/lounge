-- Customer-facing booking widget gained a "Pay now (full bill) vs
-- Pay on the day" choice at the summary step. When the customer
-- picks "Pay now", widget-create-payment-intent issues a Stripe
-- PaymentIntent for the resolved full price (unit_price, or
-- both_arches_price when arch='both') instead of the
-- widget_deposit_pence, and widget-create-appointment verifies the
-- PI against that full amount.
--
-- The existing deposit_* columns still receive the captured pence
-- (so reports/cart credit calculations keep working), but staff
-- surfaces need to distinguish "deposit secured £25 of £399" from
-- "paid in full at booking — no balance on the day". This flag is
-- that distinction.
--
-- Default FALSE so every pre-existing row is treated as "not paid
-- in full at booking" (correct for everything before this change).
ALTER TABLE lng_appointments
  ADD COLUMN paid_in_full_at_booking boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN lng_appointments.paid_in_full_at_booking IS
  'TRUE when the customer paid the full service price at booking via the widget "Pay now" choice. Distinct from deposit_pence/deposit_status which describe a partial up-front payment. Staff surfaces flip "Deposit paid £X" → "Paid in full" when this is TRUE.';
