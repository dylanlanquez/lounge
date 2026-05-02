-- 20260502000004_lng_ledger_view.sql
--
-- The Ledger surface (Lounge's audit-style record of every patient
-- interaction) needs a single sortable + filterable feed across two
-- separate origin tables:
--
--   • lng_appointments  — scheduled bookings (Calendly + native +
--                         manually-added). Status lives on the
--                         appointment row itself.
--   • lng_walk_ins      — drop-ins with no prior booking. Status
--                         lives on the linked lng_visits row, since
--                         walk-ins have no booked / cancelled /
--                         no-show lifecycle of their own.
--
-- A SQL view normalises both into a uniform row shape so the route
-- can use plain PostgREST filters / range() to read paged results
-- without an over-fetch + client-side merge dance.
--
-- The view is SECURITY INVOKER (default) so RLS on the underlying
-- tables still narrows results to whatever the calling JWT can see.
-- Reads only — no inserts / updates / deletes targeted at the view.
--
-- Rollback at the bottom.

-- ── Drop first so we can change the column shape on a re-apply ───
drop view if exists public.lng_ledger;

create view public.lng_ledger as
select
  -- Stable row id. For appointments, the appointment id; for walk-
  -- ins, the walk-in id. The kind column tells the consumer which
  -- table the row originated in.
  a.id                                   as id,
  'appointment'::text                    as kind,
  a.patient_id                           as patient_id,
  a.location_id                          as location_id,
  -- Ordering / filter axis. Appointments use start_at (booked time);
  -- walk-ins below use created_at (the drop-in moment) so both
  -- streams compare cleanly.
  a.start_at                             as event_at,
  a.end_at                               as end_at,
  a.status                               as status,
  a.source                               as source,
  a.event_type_label                     as service_label,
  a.appointment_ref                      as appointment_ref,
  a.cancel_reason                        as cancel_reason,
  a.notes                                as notes
from public.lng_appointments a

union all

select
  w.id                                   as id,
  'walk_in'::text                        as kind,
  w.patient_id                           as patient_id,
  w.location_id                          as location_id,
  w.created_at                           as event_at,
  -- Walk-ins don't have a scheduled end; reuse created_at so the
  -- shape stays uniform. Consumers that need a duration should fall
  -- back to the visit's closed_at when present.
  w.created_at                           as end_at,
  -- Walk-in status comes from the visit. visit.status enum is
  -- 'arrived' | 'in_chair' | 'complete' | 'unsuitable' | 'ended_early'.
  -- A walk-in always has a visit (Arrival flow inserts both in one
  -- transaction), so the LEFT JOIN should always find a row; the
  -- coalesce is defensive against historical data gaps and falls
  -- back to 'arrived' rather than leaking a NULL.
  coalesce(v.status, 'arrived')          as status,
  -- Distinct source value so the Ledger's source filter can pick
  -- walk-ins out without having to remember which tables they live
  -- in. The frontend exposes this as "Walk-in".
  'walk_in'::text                        as source,
  w.service_type                         as service_label,
  w.appointment_ref                      as appointment_ref,
  null::text                             as cancel_reason,
  v.notes                                as notes
from public.lng_walk_ins w
left join public.lng_visits v on v.walk_in_id = w.id;

comment on view public.lng_ledger is
  'Normalised union of lng_appointments + lng_walk_ins. Powers the Ledger route — every patient interaction at the lab in one feed, sortable by event_at, filterable by status / source / location / patient_id. SECURITY INVOKER so RLS on the underlying tables still applies.';

-- ── Rollback ─────────────────────────────────────────────────────
-- DROP VIEW IF EXISTS public.lng_ledger;
