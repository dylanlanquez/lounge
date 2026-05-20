-- 20260520000010_lng_payments_staff_cash_insert.sql
--
-- Lets active Lounge staff record cash payments from the till.
--
-- Original policy set (20260513000008) intentionally restricted
-- lng_payments writes to admins only, with a comment that "inserts
-- flow through service-role-backed edge functions (terminal-start-
-- payment, cash payment recorder)". The terminal path is wired
-- correctly — it goes through the service-role edge function — but
-- the cash path never had a recorder function. recordCashPayment
-- in src/lib/queries/payments.ts has always done a direct client-
-- side insert. The till worked only because every cashier was also
-- an admin during pre-launch testing.
--
-- Now that non-admin staff are taking real cash payments from
-- patients, the till errors with "new row violates row-level
-- security policy" the moment a cashier without is_admin tries to
-- record cash. This adds a tightly-scoped INSERT policy that
-- mirrors the till's actual write shape:
--
--   * method must be cash (terminal/Klarna/BNPL stay on the service-
--     role edge function path so we're not opening up card writes)
--   * status must be succeeded (the cashier confirms the cash is in
--     the drawer at insert time; processing/failed cash makes no
--     sense)
--   * taken_by must be the caller's own account, or NULL — the
--     client falls back to NULL on a rare auth_account_id RPC
--     failure rather than blocking the till
--   * caller must be active lng staff (or super-admin), same gate
--     every other staff-write policy uses

create policy lng_payments_staff_insert_cash
  on public.lng_payments
  for insert
  to authenticated
  with check (
    (public.auth_is_lng_staff() or public.auth_is_super_admin())
    and method = 'cash'
    and status = 'succeeded'
    and (taken_by is null or taken_by = public.auth_account_id())
  );

notify pgrst, 'reload schema';
