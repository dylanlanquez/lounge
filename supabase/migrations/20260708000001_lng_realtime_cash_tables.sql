-- 20260708000001_lng_realtime_cash_tables.sql
--
-- Add the remaining cash-balance tables to the `supabase_realtime`
-- publication so every open device converges on the one shared safe.
--
-- Background: the Cash counts page recomputes "what should be in the
-- safe right now" on the client from raw rows (useCashPosition). That
-- number is the single source of truth for the one physical safe, so
-- every device has to re-sync when it moves. lng_payments was already
-- in the publication (20260430000004), but a cash payment is only one
-- of the four things that move the balance. A bank deposit / float
-- top-up (lng_cash_withdrawals), a cash refund (lng_payment_refunds),
-- and a fresh signed count that resets the baseline (lng_cash_counts)
-- were NOT publishing changes, so a kiosk left open all day kept
-- rendering the balance it computed at load time while the DB had
-- already moved on. That is how two staff ended up looking at two
-- different numbers for the same safe.
--
-- Replica identity stays DEFAULT (primary key only): useCashPosition /
-- useCashCounts re-fetch on any change and never read OLD row values
-- out of the change payload, so DEFAULT is enough and avoids the WAL
-- volume penalty of FULL. Same rationale as 20260430000004.
--
-- Idempotent: each table is only added if it isn't already a member,
-- so re-running against a refreshed shadow doesn't error.

do $$
declare
  t text;
  tables text[] := array[
    'lng_payment_refunds',
    'lng_cash_withdrawals',
    'lng_cash_counts'
  ];
begin
  foreach t in array tables loop
    if not exists (
      select 1
        from pg_publication_tables
       where pubname    = 'supabase_realtime'
         and schemaname = 'public'
         and tablename  = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

-- Rollback (manual; only runs if the operator types it):
--
-- do $$
-- declare
--   t text;
--   tables text[] := array[
--     'lng_payment_refunds','lng_cash_withdrawals','lng_cash_counts'];
-- begin
--   foreach t in array tables loop
--     if exists (
--       select 1 from pg_publication_tables
--        where pubname='supabase_realtime' and schemaname='public' and tablename=t
--     ) then
--       execute format('alter publication supabase_realtime drop table public.%I', t);
--     end if;
--   end loop;
-- end $$;
