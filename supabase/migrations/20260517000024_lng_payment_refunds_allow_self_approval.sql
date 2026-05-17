-- 20260517000024_lng_payment_refunds_allow_self_approval.sql
--
-- Drop the lng_payment_refunds_two_staff_check constraint so a
-- manager can issue + approve a refund on the same row. Combined
-- with the password removal in the client, the approver field
-- becomes a logging choice rather than a verification step.
-- Per Dylan: speed > strict two-staff proof.

alter table public.lng_payment_refunds
  drop constraint if exists lng_payment_refunds_two_staff_check;
