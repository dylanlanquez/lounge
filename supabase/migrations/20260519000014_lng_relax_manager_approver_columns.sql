-- 20260519000014_lng_relax_manager_approver_columns.sql
--
-- Manager-approval flow has changed: there is no longer a per-action
-- manager picker on the discount / refund / void sheets. Instead, a
-- configurable list of managers in Admin → Emails → General gets an
-- emailed notification after each action ("manager_notification"
-- template, sent by the send-manager-notification edge function).
--
-- The audit tables stay — they remain the source of truth for who
-- did what and when — but the historical approver field becomes
-- optional. Historical rows keep their stamped approvers; new rows
-- written after this migration may leave the column NULL because the
-- new flow records "manager awareness" out-of-band via email.
--
-- Two tables affected:
--
--   * lng_cart_discounts.approved_by — drop NOT NULL, drop the
--     approver_distinct check (no longer relevant: there is no
--     approver to compare against the applier).
--
--   * lng_payment_refunds.approver_account_id — drop NOT NULL, drop
--     the two_staff_check (same reason).
--
-- Rollback at the bottom.

-- ── lng_cart_discounts ─────────────────────────────────────────────────────

alter table public.lng_cart_discounts
  drop constraint if exists lng_cart_discounts_approver_distinct;

alter table public.lng_cart_discounts
  alter column approved_by drop not null;

comment on column public.lng_cart_discounts.approved_by is
  'Historical: the manager who approved this row when the per-action manager picker was in use (pre 19 May 2026). New rows leave this NULL; the post-hoc audit trail lives in the email sent by send-manager-notification + the corresponding lng_event_log row.';

-- ── lng_payment_refunds ────────────────────────────────────────────────────

alter table public.lng_payment_refunds
  drop constraint if exists lng_payment_refunds_two_staff_check;

alter table public.lng_payment_refunds
  alter column approver_account_id drop not null;

comment on column public.lng_payment_refunds.approver_account_id is
  'Historical: the manager who approved this row when the per-action manager picker was in use (pre 19 May 2026). New rows leave this NULL; the post-hoc audit trail lives in the email sent by send-manager-notification + the corresponding lng_event_log row.';

-- ── Rollback ───────────────────────────────────────────────────────────────
-- ALTER TABLE public.lng_cart_discounts
--   ALTER COLUMN approved_by SET NOT NULL,
--   ADD CONSTRAINT lng_cart_discounts_approver_distinct
--     CHECK (approved_by <> applied_by OR applied_by IS NULL);
--
-- ALTER TABLE public.lng_payment_refunds
--   ALTER COLUMN approver_account_id SET NOT NULL,
--   ADD CONSTRAINT lng_payment_refunds_two_staff_check
--     CHECK (performed_by_account_id <> approver_account_id);
