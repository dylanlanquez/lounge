-- 20260430000009_lng_status_rename.sql
--
-- Status enum cleanup. Three moves:
--
--   1. lng_visits.status renames + dormant drop:
--        opened       → arrived
--        in_progress  → in_chair
--        cancelled    → dropped (never written by any code path)
--
--      Rationale: the original tokens were database-y. Onlookers had
--      to learn what "opened" meant in this app's grammar. The new
--      tokens read literally and mirror the appointment lifecycle:
--      arrived (in waiting), in_chair (working), then complete or
--      unsuitable. cancelled was reserved but no path writes it; the
--      check constraint accepted it for nothing.
--
--   2. lng_visit_paid_status (a view) — relabel two of the four
--      possible paid_status outputs:
--        no_charge → free_visit
--        unpaid    → owed
--
--      The view recomputes on read so it's a CREATE OR REPLACE. No
--      stored data to migrate. Existing 'paid' / 'partially_paid'
--      stay as-is.
--
--   3. Backfill: rename existing rows in lng_visits before the
--      check constraint is rebuilt. Two writes:
--        UPDATE ... SET status='arrived'  WHERE status='opened';
--        UPDATE ... SET status='in_chair' WHERE status='in_progress';
--      We also defensively flip any rogue 'cancelled' to 'unsuitable'
--      so the constraint rebuild never trips on a stale row. Today
--      Meridian has zero rows in 'cancelled' (verified).
--
-- Rollback at the bottom.

-- ── 1. Drop the OLD check constraint first ────────────────────────────────
-- Otherwise the UPDATE statements below would be blocked by the
-- existing constraint (it doesn't allow 'arrived' / 'in_chair'). The
-- table is briefly unconstrained on status; that's fine inside a
-- single transaction since no other writer can land in this window.
alter table public.lng_visits drop constraint if exists lng_visits_status_check;

-- ── 2. Backfill existing rows ──────────────────────────────────────────────
update public.lng_visits set status = 'arrived'    where status = 'opened';
update public.lng_visits set status = 'in_chair'   where status = 'in_progress';
update public.lng_visits set status = 'unsuitable' where status = 'cancelled';

-- ── 3. Add the new constraint with only the live values ───────────────────
alter table public.lng_visits
  add constraint lng_visits_status_check
  check (status in ('arrived', 'in_chair', 'complete', 'unsuitable'));

-- ── 3. Replace the paid_status view with the new label set ─────────────────
create or replace view public.lng_visit_paid_status as
select
  v.id  as visit_id,
  c.id  as cart_id,
  c.total_pence as amount_due_pence,
  coalesce(sum(p.amount_pence) filter (where p.status = 'succeeded'), 0)::int
       as amount_paid_pence,
  case
    when c.total_pence is null or c.total_pence = 0 then 'free_visit'
    when coalesce(sum(p.amount_pence) filter (where p.status = 'succeeded'), 0) >= c.total_pence
      then 'paid'
    when coalesce(sum(p.amount_pence) filter (where p.status = 'succeeded'), 0) > 0
      then 'partially_paid'
    else 'owed'
  end as paid_status
from public.lng_visits v
left join public.lng_carts    c on c.visit_id = v.id
left join public.lng_payments p on p.cart_id = c.id
group by v.id, c.id, c.total_pence;

comment on view public.lng_visit_paid_status is
  'Derived paid status per visit. Never stored. Recomputed on read. Possible values: free_visit, paid, partially_paid, owed.';

-- ── Rollback ───────────────────────────────────────────────────────────────
-- update public.lng_visits set status = 'opened'      where status = 'arrived';
-- update public.lng_visits set status = 'in_progress' where status = 'in_chair';
-- ALTER TABLE public.lng_visits DROP CONSTRAINT IF EXISTS lng_visits_status_check;
-- ALTER TABLE public.lng_visits
--   ADD CONSTRAINT lng_visits_status_check
--   CHECK (status IN ('opened', 'in_progress', 'complete', 'cancelled', 'unsuitable'));
-- (and re-create the view with no_charge / unpaid labels)
