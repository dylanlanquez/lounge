-- 20260907000010_lng_cash_count_denominations.sql
--
-- Denomination breakdown for a cash count ("how it was counted").
--
-- Context: the 7 Sep 2026 count read £2,076.16 against an expected
-- £1,949.00 and nobody could tell whether the safe or the software was
-- wrong. Both earlier counts had matched "expected" to the penny with
-- round-hundred totals, which is exactly what a typed-in expected figure
-- looks like and nothing like a physical count. A single free-text
-- total gives no evidence either way.
--
-- The proven fix is the till-count sheet every bank and retailer uses:
-- the counter records HOW MANY of each note and coin, the system does
-- the arithmetic, and the breakdown is stored with the count. That
--   * removes adding-up mistakes (the most common source of a
--     "difference"),
--   * proves a physical count happened,
--   * and lets a later reader see instantly that, say, £127.16 of a
--     surplus is entirely coins, which a recorded cash payment (always
--     whole pounds) can never produce.
--
-- One row per denomination per count. Immutable once the count is
-- signed: inserts are only allowed while the parent count is pending,
-- and a trigger refuses to sign a count whose breakdown does not add up
-- to the counted total, so the stored evidence can never disagree with
-- the headline figure.

create table if not exists public.lng_cash_count_denominations (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references public.lng_cash_counts(id) on delete cascade,
  -- UK circulating notes and coins, in pence.
  denomination_pence integer not null
    check (denomination_pence in (5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1)),
  quantity integer not null check (quantity >= 0),
  created_at timestamptz not null default now(),
  unique (count_id, denomination_pence)
);

comment on table public.lng_cash_count_denominations is
  'How a cash count was physically counted: quantity of each note and coin. Written with the count, immutable once signed. Sum must equal lng_cash_counts.actual_pence (enforced by trigger on sign-off).';

create index if not exists lng_cash_count_denominations_count_idx
  on public.lng_cash_count_denominations (count_id);

alter table public.lng_cash_count_denominations enable row level security;

-- Read: same audience as the count itself.
drop policy if exists lng_cash_count_denominations_read on public.lng_cash_count_denominations;
create policy lng_cash_count_denominations_read on public.lng_cash_count_denominations
  for select to authenticated
  using (public.auth_can_view_financials() or public.auth_can_count_cash());

-- Insert: counters only, and only onto a count that is still pending.
drop policy if exists lng_cash_count_denominations_insert on public.lng_cash_count_denominations;
create policy lng_cash_count_denominations_insert on public.lng_cash_count_denominations
  for insert to authenticated
  with check (
    public.auth_can_count_cash()
    and exists (
      select 1 from public.lng_cash_counts c
       where c.id = count_id and c.status = 'pending'
    )
  );

-- Delete: the counter may clear their own pending count's rows (retry
-- after a failed submit). Signed rows are never deletable.
drop policy if exists lng_cash_count_denominations_delete_pending on public.lng_cash_count_denominations;
create policy lng_cash_count_denominations_delete_pending on public.lng_cash_count_denominations
  for delete to authenticated
  using (
    public.auth_can_count_cash()
    and exists (
      select 1 from public.lng_cash_counts c
       where c.id = count_id
         and c.status = 'pending'
         and c.counted_by = public.auth_account_id()
    )
  );

-- Integrity: a count cannot be signed if its breakdown disagrees with
-- the counted total. Loud failure, never a silent mismatch.
create or replace function public.lng_cash_counts_check_denominations()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sum bigint;
  v_rows integer;
begin
  if new.status = 'signed' and coalesce(old.status, '') <> 'signed' then
    select coalesce(sum(denomination_pence * quantity), 0), count(*)
      into v_sum, v_rows
      from public.lng_cash_count_denominations
     where count_id = new.id;
    if v_rows > 0 and new.actual_pence is distinct from v_sum::integer then
      raise exception
        'cash count %: denomination breakdown adds up to % pence but the counted total is % pence',
        new.id, v_sum, new.actual_pence
        using errcode = '23514';
    end if;
  end if;
  return new;
end
$function$;

drop trigger if exists lng_cash_counts_check_denominations on public.lng_cash_counts;
create trigger lng_cash_counts_check_denominations
  before update on public.lng_cash_counts
  for each row
  execute function public.lng_cash_counts_check_denominations();
