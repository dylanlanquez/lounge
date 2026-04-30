-- 20260430000018_lng_visit_paid_status_deposit.sql
--
-- Fix: lng_visit_paid_status didn't count the appointment deposit
-- toward amount_paid_pence. A £100 cart with a £25 Calendly deposit
-- and £75 collected at the till stayed marked partially_paid forever
-- (£75 < £100). The In Clinic card displayed the bare bill, never
-- the outstanding balance.
--
-- Three corrections in one place — the view is the source of truth:
--
--   1. amount_paid_pence now sums succeeded lng_payments PLUS the
--      appointment's paid deposit (deposit_status = 'paid'). Walk-ins
--      have no appointment so the deposit term collapses to 0.
--   2. paid_status uses the new combined sum, so a deposit that
--      covers the rest of the bill flips the row to 'paid' without
--      the till ever charging anything.
--   3. amount_due_pence stays as c.total_pence (the bill) — that's
--      still the right number for "what was owed in total", and the
--      consumers compute outstanding as due - paid client-side.
--
-- Idempotent CREATE OR REPLACE; no data migration needed.

create or replace view public.lng_visit_paid_status as
select
  v.id  as visit_id,
  c.id  as cart_id,
  c.total_pence as amount_due_pence,
  (
    coalesce(sum(p.amount_pence) filter (where p.status = 'succeeded'), 0)
    + coalesce(max(case when a.deposit_status = 'paid' then a.deposit_pence else 0 end), 0)
  )::int as amount_paid_pence,
  case
    when c.total_pence is null or c.total_pence = 0 then 'free_visit'
    when (
      coalesce(sum(p.amount_pence) filter (where p.status = 'succeeded'), 0)
      + coalesce(max(case when a.deposit_status = 'paid' then a.deposit_pence else 0 end), 0)
    ) >= c.total_pence
      then 'paid'
    when (
      coalesce(sum(p.amount_pence) filter (where p.status = 'succeeded'), 0)
      + coalesce(max(case when a.deposit_status = 'paid' then a.deposit_pence else 0 end), 0)
    ) > 0
      then 'partially_paid'
    else 'owed'
  end as paid_status
from public.lng_visits v
left join public.lng_carts        c on c.visit_id = v.id
left join public.lng_payments     p on p.cart_id = c.id
left join public.lng_appointments a on a.id = v.appointment_id
group by v.id, c.id, c.total_pence;

comment on view public.lng_visit_paid_status is
  'Derived paid status per visit. amount_paid_pence sums succeeded lng_payments AND the paid Calendly deposit (when one was taken). paid_status reflects the combined coverage; free_visit when the cart total is zero. Recomputed on read.';

-- ── Rollback ───────────────────────────────────────────────────────────────
-- create or replace view public.lng_visit_paid_status as
-- select
--   v.id  as visit_id,
--   c.id  as cart_id,
--   c.total_pence as amount_due_pence,
--   coalesce(sum(p.amount_pence) filter (where p.status = 'succeeded'), 0)::int as amount_paid_pence,
--   case
--     when c.total_pence is null or c.total_pence = 0 then 'free_visit'
--     when coalesce(sum(p.amount_pence) filter (where p.status = 'succeeded'), 0) >= c.total_pence then 'paid'
--     when coalesce(sum(p.amount_pence) filter (where p.status = 'succeeded'), 0) > 0 then 'partially_paid'
--     else 'owed'
--   end as paid_status
-- from public.lng_visits v
-- left join public.lng_carts    c on c.visit_id = v.id
-- left join public.lng_payments p on p.cart_id = c.id
-- group by v.id, c.id, c.total_pence;
