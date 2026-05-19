-- 20260519000016_lng_cart_discounts_notified_recipients.sql
--
-- Adds two jsonb columns to lng_cart_discounts recording who was
-- notified by email at action time. The timeline reads these to
-- show "Notified: Alice, Bob" alongside the existing "Discount
-- applied" event, so a staff member glancing at the audit trail can
-- see exactly which managers were informed without leaving the
-- visit page.
--
-- Why store the recipient list on the row rather than join against
-- the lng_settings recipient list at render time: that list is
-- mutable. If admin removes a recipient next week, the historical
-- timeline would silently retcon to "they were never notified",
-- which is the wrong audit story. Snapshotting at action time
-- preserves the truth.
--
-- Default is the empty array so historical rows render cleanly
-- (the timeline treats an empty list as "no manager notifications
-- on this event" and just doesn't render the sub-line).
--
-- Rollback at the bottom.

alter table public.lng_cart_discounts
  add column if not exists applied_notified_account_ids jsonb not null default '[]'::jsonb,
  add column if not exists removed_notified_account_ids jsonb not null default '[]'::jsonb;

comment on column public.lng_cart_discounts.applied_notified_account_ids is
  'JSONB array of accounts.id strings the manager_notification email was dispatched to when the discount was applied. Snapshotted from manager_notifications.recipient_account_ids at action time so the audit survives changes to the recipient list. Empty array = no managers notified.';

comment on column public.lng_cart_discounts.removed_notified_account_ids is
  'Same shape as applied_notified_account_ids, but recorded when the discount was removed. Independent because the recipient list can change between apply and remove; the timeline shows whichever set was active at each event.';

-- ── Rollback ───────────────────────────────────────────────────────────────
-- ALTER TABLE public.lng_cart_discounts
--   DROP COLUMN IF EXISTS applied_notified_account_ids,
--   DROP COLUMN IF EXISTS removed_notified_account_ids;
