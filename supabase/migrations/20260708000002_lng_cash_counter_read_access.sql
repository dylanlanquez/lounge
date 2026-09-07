-- 20260708000002_lng_cash_counter_read_access.sql
--
-- Fix: staff who can count cash but not view financials computed a
-- wildly wrong safe balance.
--
-- The Cash counts page is reachable by can_count_cash OR
-- can_view_financials, and "what should be in the safe right now" is
-- summed on the client from four inputs:
--   baseline  <- last signed lng_cash_counts row
--   + cash     <- lng_payments (readable by ALL staff)
--   - refunds  <- lng_payment_refunds
--   - cashout  <- lng_cash_withdrawals
--
-- But the SELECT policies on lng_cash_counts and lng_cash_withdrawals
-- only granted auth_can_view_financials(). A counter without the
-- financials flag therefore read the payments but NOT the counts or
-- the withdrawals, so their session silently computed:
--   baseline 0 (no count visible -> window falls back to 1970)
--   + every cash payment ever
--   - 0 withdrawals (the bank deposit was invisible)
-- e.g. Jade Cassidy (can_count_cash=true, can_view_financials=false)
-- saw £914 (sum of all cash payments) instead of the true £284.
--
-- The same gap corrupts the count a counter CREATES: createCashCount
-- reads these tables to snapshot expected_pence, so a counter would
-- sign off a count with baseline 0 and no withdrawals subtracted.
--
-- Counters already INSERT counts + withdrawals (auth_can_count_cash()),
-- so being unable to read them back was never intentional. Widen the
-- reads to auth_can_view_financials() OR auth_can_count_cash() on the
-- counts, withdrawals, and their snapshot line tables, and give
-- counters read access to CASH refunds (the only refunds that move the
-- safe) so the fourth input is complete too. Result: every account that
-- can reach the page computes the same number.
--
-- drop-then-create so re-running against a refreshed shadow is clean.

-- ── counts ──────────────────────────────────────────────────────────
drop policy if exists lng_cash_counts_read on public.lng_cash_counts;
create policy lng_cash_counts_read on public.lng_cash_counts
  for select to authenticated
  using (public.auth_can_view_financials() or public.auth_can_count_cash());

-- ── withdrawals ─────────────────────────────────────────────────────
drop policy if exists lng_cash_withdrawals_read on public.lng_cash_withdrawals;
create policy lng_cash_withdrawals_read on public.lng_cash_withdrawals
  for select to authenticated
  using (public.auth_can_view_financials() or public.auth_can_count_cash());

-- ── count snapshot lines (per-count statement + PDF) ────────────────
drop policy if exists lng_cash_count_lines_read on public.lng_cash_count_lines;
create policy lng_cash_count_lines_read on public.lng_cash_count_lines
  for select to authenticated
  using (public.auth_can_view_financials() or public.auth_can_count_cash());

drop policy if exists lng_cash_count_withdrawal_lines_read on public.lng_cash_count_withdrawal_lines;
create policy lng_cash_count_withdrawal_lines_read on public.lng_cash_count_withdrawal_lines
  for select to authenticated
  using (public.auth_can_view_financials() or public.auth_can_count_cash());

-- ── cash refunds (the only refunds that move the safe) ──────────────
-- Additive policy: leaves the existing admin / receptionist reads in
-- place and grants counters read on cash-method refunds only, so the
-- safe calc can subtract them without exposing card refunds broadly.
drop policy if exists lng_payment_refunds_cash_counter_select on public.lng_payment_refunds;
create policy lng_payment_refunds_cash_counter_select on public.lng_payment_refunds
  for select to authenticated
  using (public.auth_can_count_cash() and method = 'cash');
