-- 20260520000015_lng_legacy_baseline_allow_self_sign.sql
--
-- Allow the operator who counts a legacy_baseline count to ALSO
-- sign it off. Routine reconciliation counts keep the two-person
-- rule (counter ≠ signer) for the same anti-self-approval reason as
-- discounts + voids: pre-launch the operator may be the only staff
-- account in the system, which makes seeding the safe impossible
-- otherwise.
--
-- Original constraint (20260430000019 lng_cash_counts_counter_signer_distinct):
--   signed_off_by is null or signed_off_by <> counted_by
-- New constraint:
--   signed_off_by is null
--   OR signed_off_by <> counted_by
--   OR kind = 'legacy_baseline'
--
-- The kind column exists from 20260512000009 (default 'regular'),
-- so the `kind = 'legacy_baseline'` clause is safe to evaluate on
-- every row including rows inserted before that migration (kind
-- defaults to 'regular' for those, so the new clause never fires
-- and behaviour is unchanged for historical data).

alter table public.lng_cash_counts
  drop constraint if exists lng_cash_counts_counter_signer_distinct;

alter table public.lng_cash_counts
  add constraint lng_cash_counts_counter_signer_distinct check (
    signed_off_by is null
    or signed_off_by <> counted_by
    or kind = 'legacy_baseline'
  );

-- ── Rollback ────────────────────────────────────────────────────────
-- alter table public.lng_cash_counts
--   drop constraint if exists lng_cash_counts_counter_signer_distinct;
-- alter table public.lng_cash_counts
--   add constraint lng_cash_counts_counter_signer_distinct check (
--     signed_off_by is null or signed_off_by <> counted_by
--   );
