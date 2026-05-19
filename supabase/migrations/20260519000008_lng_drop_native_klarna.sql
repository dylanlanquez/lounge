-- 20260519000008_lng_drop_native_klarna.sql
--
-- Reverses 20260519000007_lng_klarna_in_store.sql.
--
-- Stripe shipped klarna_display_qr_code support on Terminal smart
-- readers on 2026-04-22 — the customer scans a QR directly on the
-- S700 screen, opens Klarna, pays. That obsoletes the direct
-- Klarna API integration we built in the prior migration: Stripe
-- handles the full Klarna handshake, the reader displays the QR,
-- and webhook + refund use the existing terminal-* edge functions.
--
-- We're switching to Stripe's path for these reasons:
--   • UX is strictly better (QR on the reader, not the tablet —
--     the customer's eye is already on the reader since they're
--     being asked to pay there).
--   • No new infrastructure (no Klarna API credentials to rotate,
--     no webhook handler with its own token-bound trust anchor, no
--     cross-verification call, no separate refund endpoint).
--   • Reuses the existing terminal-payments + terminal-refund +
--     terminal-webhook reconciliation we already know works.
--
-- payment_journey='klarna' STAYS on lng_payments — we still need
-- to know which transactions were Klarna for reporting. The
-- distinction now lives purely on the journey column (which has
-- always supported 'klarna'); the method goes back to
-- 'card_terminal' the same way Clearpay already works.
--
-- ── Safe-to-drop check ────────────────────────────────────────────
-- Verified pre-apply: zero rows in lng_klarna_sessions, zero rows
-- in lng_payments with method='klarna', zero rows in
-- lng_payment_refunds with method='klarna'. The native flow never
-- went live, so this is a clean teardown — no data migration.

-- 1. Drop the table. The publication membership is removed
--    automatically when the table goes away; `ALTER PUBLICATION ...
--    DROP TABLE IF EXISTS` isn't valid SQL (the IF EXISTS form
--    doesn't apply to publication tables), so we just rely on the
--    cascade behaviour of DROP TABLE.
drop table if exists public.lng_klarna_sessions;

-- 2. Revert the method enum widening on lng_payments. Since no
--    rows have method='klarna' (verified above), the constraint
--    flips cleanly with no data tidy.
alter table public.lng_payments
  drop constraint if exists lng_payments_method_check;
alter table public.lng_payments
  add constraint lng_payments_method_check
  check (method in ('card_terminal', 'cash', 'gift_card', 'account_credit'));

comment on column public.lng_payments.method is
  'Payment medium: card_terminal (S700 tap or QR scan via Stripe Terminal — covers cards + Klarna + Clearpay), cash, gift_card (placeholder), account_credit (placeholder). payment_journey distinguishes the customer experience (standard / klarna / clearpay).';

-- 3. Same for the refunds method enum.
alter table public.lng_payment_refunds
  drop constraint if exists lng_payment_refunds_method_check;
alter table public.lng_payment_refunds
  add constraint lng_payment_refunds_method_check
  check (method in ('cash', 'card_terminal', 'gift_card', 'account_credit'));

comment on column public.lng_payment_refunds.method is
  'Refund medium. Must match the parent payment.method. Klarna refunds use method=card_terminal (Stripe processes them through the same /refunds endpoint as card refunds).';

-- ── Rollback ──────────────────────────────────────────────────────
-- Re-apply 20260519000007 to restore the table + enum values.
