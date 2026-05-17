-- 20260518000002_lng_appointments_overlap_guard.sql
--
-- Database-level overlap safety net. Until this migration, every
-- booking path (createAppointment, rescheduleAppointment, widget-
-- create-appointment, widget-reschedule-booking) ran the conflict
-- check in the *app* before inserting, and the database itself
-- enforced nothing. Two failure modes:
--
--   1. Race condition. Two staff click Save in the same window —
--      both checks pass, both inserts land, the chair is double-
--      booked. No advisory lock or GIST exclusion constraint to
--      catch it.
--   2. Bypass paths. The Calendly webhook (calendly-webhook/index.ts)
--      inserts directly with no conflict check, trusting Calendly's
--      own availability gate. If Calendly is misconfigured or two
--      webhooks fire near-simultaneously, overlapping rows land.
--
-- This migration adds a single guarantee: every active appointment
-- row, no matter who inserts it, has its per-pool capacity checked
-- after the row + its phases hit the DB. If the check finds any
-- pool over capacity, the row is either rejected (staff / widget /
-- manual) or saved with a loud `lng_system_failures` entry (walk-ins
-- and Calendly — paths where rejection isn't acceptable because the
-- patient is already in the chair or the webhook can't 5xx without
-- losing the booking entirely).
--
-- ── Trigger ordering ──────────────────────────────────────────────
-- The guard is a CONSTRAINT TRIGGER, INITIALLY IMMEDIATE. Constraint
-- triggers fire AFTER all non-constraint AFTER triggers, which means
-- the phase materialiser (lng_appointments_materialise_phases) has
-- run and the new appointment's phase rows are visible by the time
-- the guard inspects them. Without that ordering, the guard would
-- see the appointment but no phases and report a false negative.
--
-- ── Re-uses the existing conflict checker ─────────────────────────
-- lng_booking_check_conflict is the source of truth for "does this
-- appointment overlap with any existing pool consumption?". Calling
-- it from the trigger with exclude_appointment_id = NEW.id means
-- the new row's own phases are excluded from the count, so the
-- check measures only existing other-appointment phases. Same code
-- path the app pre-check uses; one definition of "conflict".
--
-- ── Walk-in / Calendly policy ─────────────────────────────────────
-- Walk-in rows carry walk_in_id IS NOT NULL. Calendly rows carry
-- source = 'calendly'. Both bypass the raise and instead log to
-- lng_system_failures at severity 'warning' with the full conflict
-- payload. The appointment timeline picks failures up via its OR
-- query on context->>appointment_id, so the receptionist sees the
-- collision inline on both the appointment and the patient profile.
--
-- ── Status filter ─────────────────────────────────────────────────
-- Mirrors the conflict checker: only 'booked', 'arrived',
-- 'in_progress' rows participate. Terminal statuses (cancelled,
-- no_show, complete, rescheduled) skip the guard entirely — they
-- can't collide with anything.
--
-- ── Idempotency ───────────────────────────────────────────────────
-- DROP TRIGGER + CREATE FUNCTION OR REPLACE. Re-runnable.

create or replace function public.lng_appointments_overlap_guard_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  conflict_count int;
  conflicts_json jsonb;
  is_walkin      boolean;
  is_calendly    boolean;
begin
  -- Only active rows can collide. Terminal statuses skip the check.
  if new.status not in ('booked', 'arrived', 'in_progress') then
    return new;
  end if;

  -- A row without a service_type has no phases (the materialiser
  -- short-circuits) and therefore nothing to check. Walk-in markers
  -- are the main example today — they have service_type NULL on the
  -- lng_appointments row and live on the lng_walk_ins side. The
  -- guard is a no-op for them; the schedule still surfaces the
  -- marker and a future walk-in audit can add a separate check on
  -- the walk-in side without affecting this path.
  if new.service_type is null then
    return new;
  end if;

  select count(*) filter (where conflict_kind is not null),
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'conflict_kind',     conflict_kind,
               'pool_id',           pool_id,
               'pool_capacity',     pool_capacity,
               'current_count',     current_count,
               'phase_index',       phase_index,
               'phase_label',       phase_label,
               'conflict_start_at', conflict_start_at,
               'conflict_end_at',   conflict_end_at
             )
           ) filter (where conflict_kind is not null),
           '[]'::jsonb
         )
    into conflict_count, conflicts_json
    from public.lng_booking_check_conflict(
      new.location_id,
      new.service_type,
      new.start_at,
      new.end_at,
      new.id,
      new.repair_variant,
      new.product_key,
      new.arch
    );

  if conflict_count = 0 then
    return new;
  end if;

  is_walkin   := new.walk_in_id is not null;
  is_calendly := new.source = 'calendly';

  if is_walkin or is_calendly then
    -- Save and flag. Walk-ins are unavoidable (patient is already
    -- at the door); Calendly webhooks can't be rejected without
    -- losing the booking entirely. The lng_system_failures row
    -- surfaces on the appointment + patient timelines so staff
    -- see the collision in context.
    insert into public.lng_system_failures (severity, source, message, context)
    values (
      'warning',
      'lng_appointments_overlap_guard',
      case
        when is_walkin   then 'Walk-in saved despite overlap with an existing booking'
        when is_calendly then 'Calendly booking saved despite overlap with an existing booking'
      end,
      jsonb_build_object(
        'appointment_id', new.id,
        'patient_id',     new.patient_id,
        'service_type',   new.service_type,
        'start_at',       new.start_at,
        'end_at',         new.end_at,
        'source',         new.source,
        'walk_in_id',     new.walk_in_id,
        'conflicts',      conflicts_json
      )
    );
    return new;
  end if;

  -- Hard fail for everything else (manual, native, widget). The
  -- code 23P01 ('exclusion_violation') is the closest Postgres
  -- has to "this row would violate an exclusion-like constraint"
  -- without needing a real GIST exclusion; the app surfaces this
  -- as a "slot was just taken" error so the operator picks again.
  raise exception 'OVERLAP: appointment % overlaps an existing booking. Conflicts: %', new.id, conflicts_json
    using errcode = '23P01';
end;
$$;

revoke all on function public.lng_appointments_overlap_guard_trg() from public;

comment on function public.lng_appointments_overlap_guard_trg() is
  'AFTER INSERT/UPDATE constraint trigger on lng_appointments. Re-runs lng_booking_check_conflict against the just-materialised phases to enforce overlap prevention at the database level — so every path that writes an appointment (staff, widget, Calendly, walk-in, any future path) is gated by the same rule. Walk-in (walk_in_id NOT NULL) and Calendly (source = calendly) bypasses log to lng_system_failures with severity warning instead of raising, since those flows must always save. Everything else raises with SQLSTATE 23P01.';

-- Trigger name prefixed with zz_ so it runs after the materialise
-- trigger (lng_appointments_materialise_phases) — non-constraint
-- AFTER triggers fire in alphabetical order. Constraint triggers
-- always come after non-constraint AFTER triggers regardless of
-- naming, but the prefix makes the intent visible in pg_trigger.
drop trigger if exists zz_appointments_overlap_guard on public.lng_appointments;
create constraint trigger zz_appointments_overlap_guard
  after insert or update of start_at, end_at, status, service_type,
        repair_variant, product_key, arch, location_id
  on public.lng_appointments
  initially immediate
  for each row
  execute function public.lng_appointments_overlap_guard_trg();

-- ── Rollback ──────────────────────────────────────────────────────
-- drop trigger if exists zz_appointments_overlap_guard on public.lng_appointments;
-- drop function if exists public.lng_appointments_overlap_guard_trg();
