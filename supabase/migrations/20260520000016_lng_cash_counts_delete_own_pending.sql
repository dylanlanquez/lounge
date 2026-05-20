-- 20260520000016_lng_cash_counts_delete_own_pending.sql
--
-- Allow a counter to delete their own pending cash counts so the
-- submit flow can roll back if signCashCount fails after
-- createCashCount has already inserted a pending row.
--
-- Without this policy a failed-sign attempt (e.g. constraint
-- violation, RLS rejection, network blip) left an orphan pending
-- row in the safe history that staff would see alongside the
-- successful retry — confusing and impossible to clean up from the
-- app. Signed rows stay immutable; only the row's original counter
-- can delete it, and only while it's still pending.
--
-- Limited to `status = 'pending'` so signed audit history can never
-- be deleted via the client. Limited to `counted_by =
-- auth_account_id()` so staff can only clear their own scratch
-- rows, not someone else's.

create policy lng_cash_counts_delete_own_pending on public.lng_cash_counts
  for delete to authenticated
  using (
    public.auth_can_count_cash()
    and status = 'pending'
    and counted_by = public.auth_account_id()
  );

-- ── Rollback ────────────────────────────────────────────────────────
-- drop policy if exists lng_cash_counts_delete_own_pending on public.lng_cash_counts;
