-- 20260430000005_lng_appointments_walk_in_id.sql
--
-- A walk-in arrival currently writes three rows that represent the same
-- real-world event:
--
--   1. lng_walk_ins         - the walk-in record itself
--   2. lng_visits           - the visit row (walk_in_id set, appointment_id NULL
--                             due to the schema's exactly-one constraint)
--   3. lng_appointments     - a "marker" row with source='manual' and
--                             event_type_label='Walk-in' so the schedule
--                             surfaces (today / week strip / patient
--                             timeline) include walk-ins alongside Calendly
--                             bookings.
--
-- Row 3 has no foreign key back to row 1 or row 2. Every consumer of
-- lng_appointments that also reads lng_visits has had to reinvent dedup
-- using fragile heuristics (patient_id + start_at proximity) and the
-- patient profile timeline currently shows the walk-in twice as a
-- result.
--
-- This migration adds a real walk_in_id FK to lng_appointments so the
-- marker points at its walk-in directly. Consumers can then dedup with
-- a single equality check, and click-through from the schedule can
-- resolve the marker to the underlying walk-in / visit without
-- guessing.

alter table lng_appointments
  add column if not exists walk_in_id uuid
  references lng_walk_ins(id) on delete cascade;

comment on column lng_appointments.walk_in_id is
  'When set, this row is a calendar marker for a walk-in arrival rather than a scheduled booking. Points to the lng_walk_ins row that recorded the arrival. Mutually exclusive with patient-booked rows (source=calendly|native), which leave this NULL.';

create index if not exists idx_lng_appointments_walk_in_id
  on lng_appointments(walk_in_id) where walk_in_id is not null;

-- ── Backfill ──────────────────────────────────────────────────────────
-- Existing manual 'Walk-in' markers were inserted before the FK existed,
-- so they need linking now. For each unlinked marker we find the visit
-- at the same patient_id whose opened_at is closest to the marker's
-- start_at within a 5-minute window (the marker is created right after
-- the visit, typically within ~50ms; 5 minutes is a generous safety net
-- for any clock drift). The visit's walk_in_id becomes the marker's
-- walk_in_id.
--
-- DISTINCT ON (a.id) + ORDER BY abs-distance keeps the match 1:1 even
-- if a single patient has multiple walk-ins close together.

with pairs as (
  select distinct on (a.id)
    a.id as appointment_id,
    v.walk_in_id
  from lng_appointments a
  join lng_visits v on v.patient_id = a.patient_id
  where a.source = 'manual'
    and a.event_type_label = 'Walk-in'
    and a.walk_in_id is null
    and v.walk_in_id is not null
    and abs(extract(epoch from (a.start_at - v.opened_at))) < 300
  order by a.id, abs(extract(epoch from (a.start_at - v.opened_at))) asc
)
update lng_appointments a
  set walk_in_id = pairs.walk_in_id
  from pairs
  where a.id = pairs.appointment_id;
