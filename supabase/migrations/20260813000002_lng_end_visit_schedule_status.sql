-- 20260813000002_lng_end_visit_schedule_status.sql
--
-- Companion to 20260813000001. That migration fixed walk-ins whose
-- visit reached 'complete'. This one closes the same class of hole on
-- the other two terminal visit states.
--
-- ── The bug ──────────────────────────────────────────────────────
-- lng_end_visit_early and lng_remove_cart_line flip lng_visits to
-- 'unsuitable' / 'ended_early' but never touch lng_appointments. The
-- schedule reads lng_appointments, and isAppointmentDimmed refuses to
-- dim an 'arrived' row at any age (it assumes the patient may still
-- be in the chair and the slot has over-run). So a visit that ended
-- because the patient walked out left its booking sitting at full
-- strength with an "Arrived" pill indefinitely.
--
-- Unlike 20260813000001 this is NOT walk-in specific. Measured
-- against Meridian on 13 Aug 2026: 14 visits sit in
-- unsuitable/ended_early, stranding 12 schedule rows on 'arrived' —
-- 11 booked appointments and 1 walk-in marker.
--
-- ── Chosen status: 'complete' ────────────────────────────────────
-- Dylan's call, made explicitly after the trade-off was put to him.
-- The alternative was a new 'ended' value in the status check
-- constraint with its own pill.
--
-- The known cost, recorded here so it does not later read as an
-- oversight: the schedule, the patient profile and the appointment
-- detail page will all show "Complete" for a booking where the
-- patient walked out or was found clinically unsuitable. That is a
-- friendlier word than what actually happened. The visit row remains
-- the accurate record — lng_visits.status keeps 'unsuitable' /
-- 'ended_early' along with visit_end_reason and visit_end_note, and
-- VisitDetail's header lifecycle line reads from those, so nothing is
-- lost, it is just not visible from the calendar. Revisit if staff
-- start mis-reading the schedule.
--
-- Reporting impact is contained: reports.ts buckets the funnel on
-- lng_visits.status, not appointment status, so the completed-visit
-- count is unaffected. The no-show rate keys on 'no_show' and is
-- likewise unaffected. virtualImpressions.ts treats 'complete' as a
-- concluded appointment, which these are.
--
-- ── Reverse path ─────────────────────────────────────────────────
-- lng_reverse_visit_end reopens a visit to 'arrived'. It now puts the
-- schedule row back to 'arrived' too. Without this, resuming a visit
-- would leave a dimmed "Complete" booking the receptionist could not
-- get back — a worse bug than the one being fixed.
--
-- ── Deliberately NOT changed ─────────────────────────────────────
-- jb_ref is untouched on these paths. completeVisit releases the job
-- box on a normal completion, but whether the lab still needs the box
-- for a visit that ended early is an operational question, not a
-- display one. Releasing it here would be a behaviour change nobody
-- asked for.
--
-- ── Apply order (per CLAUDE.md) ──────────────────────────────────
-- Write -> shadow (verify) -> Meridian. No destructive operations:
-- one new helper function, three CREATE OR REPLACE, and a narrow
-- idempotent backfill.

-- ── 1. Helper: point a visit's schedule row at a status ──────────
-- A visit identifies its schedule row one of two ways and never
-- both: appointment_id for a booked appointment, or walk_in_id for a
-- walk-in whose calendar marker in lng_appointments carries the FK
-- back. Every terminal transition below needs the same two-branch
-- resolution, so it lives in one place rather than being repeated
-- four times and drifting.
--
-- SECURITY DEFINER with execute revoked: this is internal plumbing
-- for the RPCs below, not a client-callable entry point. The callers
-- are themselves SECURITY DEFINER, so they run as the owner and keep
-- execute rights even though authenticated does not have them.

create or replace function public.lng_set_visit_schedule_status(
  p_visit_id uuid,
  p_status   text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_appointment_id uuid;
  v_walk_in_id     uuid;
begin
  select appointment_id, walk_in_id
    into v_appointment_id, v_walk_in_id
    from public.lng_visits
   where id = p_visit_id;

  if not found then
    raise exception 'Visit % not found', p_visit_id using errcode = 'P0002';
  end if;

  if v_appointment_id is not null then
    update public.lng_appointments
       set status = p_status
     where id = v_appointment_id;
  elsif v_walk_in_id is not null then
    update public.lng_appointments
       set status = p_status
     where walk_in_id = v_walk_in_id;
  end if;
end;
$$;

revoke all on function public.lng_set_visit_schedule_status(uuid, text) from public;

comment on function public.lng_set_visit_schedule_status(uuid, text) is
  'Internal. Sets the status of the lng_appointments row that represents a visit on the schedule, resolving either the booked appointment (lng_visits.appointment_id) or the walk-in calendar marker (lng_appointments.walk_in_id). Not client-callable; used by the end-visit / resume-visit RPCs.';

-- ── 2. lng_remove_cart_line ──────────────────────────────────────
-- Unchanged from 20260519000006 except for the schedule sync inside
-- the termination rule.

create or replace function public.lng_remove_cart_line(
  p_cart_item_id   uuid,
  p_visit_id       uuid,
  p_patient_id     uuid,
  p_reason         text,
  p_note           text,
  p_catalogue_id   uuid
)
returns table (visit_terminated boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id     uuid;
  v_cart_id        uuid;
  v_visit_status   text;
  v_line_name      text;
  v_active_count   int;
  v_unsuit_count   int;
  v_trimmed_note   text;
  v_terminated     boolean := false;
begin
  v_account_id   := public.auth_account_id();
  v_trimmed_note := nullif(btrim(coalesce(p_note, '')), '');

  if p_reason not in ('mistake', 'changed_mind', 'unsuitable') then
    raise exception 'Invalid removal reason: %', p_reason using errcode = '22023';
  end if;
  if p_reason = 'unsuitable' and v_trimmed_note is null then
    raise exception 'A reason note is required for unsuitable removals' using errcode = '22023';
  end if;
  if p_reason = 'unsuitable' and p_catalogue_id is null then
    raise exception 'Unsuitable removal requires a catalogue-backed line' using errcode = '22023';
  end if;

  select status into v_visit_status
    from public.lng_visits where id = p_visit_id for update;
  if not found then
    raise exception 'Visit % not found', p_visit_id using errcode = 'P0002';
  end if;
  if v_visit_status <> 'arrived' then
    raise exception 'Cannot remove cart lines while visit is in status %', v_visit_status
      using errcode = '22023';
  end if;

  select c.id into v_cart_id
    from public.lng_carts c
   where c.visit_id = p_visit_id
     for update;
  if not found then
    raise exception 'No cart for visit %', p_visit_id using errcode = 'P0002';
  end if;

  select name into v_line_name
    from public.lng_cart_items
   where id = p_cart_item_id
     and cart_id = v_cart_id
     and removed_at is null
   for update;
  if not found then
    raise exception 'Active cart line % not found on cart %', p_cart_item_id, v_cart_id
      using errcode = 'P0002';
  end if;

  update public.lng_cart_items
     set removed_at     = now(),
         removed_reason = p_reason,
         removed_by     = v_account_id,
         removed_note   = v_trimmed_note
   where id = p_cart_item_id;

  if p_reason = 'unsuitable' then
    insert into public.lng_unsuitability_records
      (patient_id, visit_id, catalogue_id, reason, recorded_by)
    values
      (p_patient_id, p_visit_id, p_catalogue_id, v_trimmed_note, v_account_id);
  end if;

  insert into public.patient_events
    (patient_id, event_type, actor_account_id, notes, payload)
  values
    (p_patient_id,
     'cart_line_removed',
     v_account_id,
     v_trimmed_note,
     jsonb_build_object(
       'visit_id',     p_visit_id,
       'cart_item_id', p_cart_item_id,
       'catalogue_id', p_catalogue_id,
       'line_name',    v_line_name,
       'reason',       p_reason,
       'note',         v_trimmed_note
     ));

  select count(*) into v_active_count
    from public.lng_cart_items
   where cart_id = v_cart_id and removed_at is null;

  if v_active_count = 0 then
    select count(*) into v_unsuit_count
      from public.lng_unsuitability_records
     where visit_id = p_visit_id;

    if v_unsuit_count > 0 then
      update public.lng_visits
         set status           = 'unsuitable',
             closed_at        = now(),
             visit_end_reason = 'unsuitable',
             visit_end_note   = coalesce(v_trimmed_note, 'Cart emptied with prior unsuitable verdict')
       where id = p_visit_id;
      v_terminated := true;

      -- NEW: the booking is done with. Without this the schedule
      -- keeps the row at full strength on 'arrived' forever.
      perform public.lng_set_visit_schedule_status(p_visit_id, 'complete');
    end if;
  end if;

  return query select v_terminated;
end;
$$;

revoke all on function public.lng_remove_cart_line(uuid, uuid, uuid, text, text, uuid) from public;
grant execute on function public.lng_remove_cart_line(uuid, uuid, uuid, text, text, uuid) to authenticated;

comment on function public.lng_remove_cart_line(uuid, uuid, uuid, text, text, uuid) is
  'Soft-delete one cart line with reason + note, write the timeline event, and (when the cart goes empty with at least one unsuitability record on the visit) flip the visit to unsuitable AND its schedule row to complete. Atomic. Replaces the multi-write removeCartLineWithReason() client function.';

-- ── 3. lng_end_visit_early ───────────────────────────────────────
-- Unchanged from 20260519000006 except for the schedule sync on both
-- terminating branches.

create or replace function public.lng_end_visit_early(
  p_visit_id    uuid,
  p_patient_id  uuid,
  p_reason      text,
  p_note        text,
  p_picks       jsonb default '[]'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id     uuid;
  v_cart_id        uuid;
  v_visit_status   text;
  v_trimmed_note   text;
  v_pick           jsonb;
  v_pick_item_id   uuid;
  v_pick_cat_id    uuid;
  v_pick_name      text;
  v_active_count   int;
  v_terminate      boolean;
begin
  v_account_id   := public.auth_account_id();
  v_trimmed_note := nullif(btrim(coalesce(p_note, '')), '');

  if p_reason not in ('unsuitable','patient_declined','patient_walked_out','wrong_booking','other') then
    raise exception 'Invalid end-visit reason: %', p_reason using errcode = '22023';
  end if;
  if v_trimmed_note is null then
    raise exception 'A reason note is required to end the visit early' using errcode = '22023';
  end if;
  if p_reason = 'unsuitable' and (p_picks is null or jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) = 0) then
    raise exception 'Unsuitable end-visit requires at least one picked line' using errcode = '22023';
  end if;

  select status into v_visit_status from public.lng_visits where id = p_visit_id for update;
  if not found then
    raise exception 'Visit % not found', p_visit_id using errcode = 'P0002';
  end if;
  if v_visit_status <> 'arrived' then
    raise exception 'Visit % is in status % — cannot end-early from this state', p_visit_id, v_visit_status
      using errcode = '22023';
  end if;

  select id into v_cart_id from public.lng_carts where visit_id = p_visit_id for update;

  if p_reason = 'unsuitable' then
    for v_pick in select * from jsonb_array_elements(p_picks) loop
      v_pick_item_id := nullif(v_pick->>'cart_item_id','')::uuid;
      v_pick_cat_id  := nullif(v_pick->>'catalogue_id','')::uuid;
      if v_pick_item_id is null then
        raise exception 'Pick missing cart_item_id: %', v_pick using errcode = '22023';
      end if;
      if v_pick_cat_id is null then
        raise exception 'Pick missing catalogue_id (cart_item_id %): unsuitable removals need a catalogue-backed line', v_pick_item_id using errcode = '22023';
      end if;

      select name into v_pick_name
        from public.lng_cart_items
       where id = v_pick_item_id
         and cart_id = v_cart_id
         and removed_at is null
       for update;
      if not found then
        raise exception 'Active cart line % not found on cart %', v_pick_item_id, v_cart_id
          using errcode = 'P0002';
      end if;

      update public.lng_cart_items
         set removed_at     = now(),
             removed_reason = 'unsuitable',
             removed_by     = v_account_id,
             removed_note   = v_trimmed_note
       where id = v_pick_item_id;

      insert into public.lng_unsuitability_records
        (patient_id, visit_id, catalogue_id, reason, recorded_by)
      values
        (p_patient_id, p_visit_id, v_pick_cat_id, v_trimmed_note, v_account_id);

      insert into public.patient_events
        (patient_id, event_type, actor_account_id, notes, payload)
      values
        (p_patient_id, 'cart_line_removed', v_account_id, v_trimmed_note,
         jsonb_build_object(
           'visit_id',     p_visit_id,
           'cart_item_id', v_pick_item_id,
           'catalogue_id', v_pick_cat_id,
           'line_name',    v_pick_name,
           'reason',       'unsuitable',
           'note',         v_trimmed_note
         ));
    end loop;

    select count(*) into v_active_count
      from public.lng_cart_items
     where cart_id = v_cart_id and removed_at is null;

    v_terminate := (v_active_count = 0);

    if v_terminate then
      update public.lng_visits
         set status           = 'unsuitable',
             closed_at        = now(),
             visit_end_reason = 'unsuitable',
             visit_end_note   = v_trimmed_note
       where id = p_visit_id;
    end if;

  else
    if v_cart_id is not null then
      update public.lng_cart_items
         set removed_at     = now(),
             removed_reason = 'visit_ended_early',
             removed_by     = v_account_id,
             removed_note   = v_trimmed_note
       where cart_id = v_cart_id
         and removed_at is null;
    end if;

    update public.lng_visits
       set status           = 'ended_early',
           closed_at        = now(),
           visit_end_reason = p_reason,
           visit_end_note   = v_trimmed_note
     where id = p_visit_id;

    v_terminate := true;
  end if;

  -- NEW: keep the schedule in step with the visit. Gated on
  -- v_terminate for the same reason the audit event below is: a
  -- partial unsuitable pick leaves the visit open in the chair, so
  -- its booking must stay 'arrived' and undimmed.
  if v_terminate then
    perform public.lng_set_visit_schedule_status(p_visit_id, 'complete');
  end if;

  if v_terminate then
    insert into public.patient_events
      (patient_id, event_type, actor_account_id, notes, payload)
    values
      (p_patient_id, 'visit_ended_early', v_account_id, v_trimmed_note,
       jsonb_build_object(
         'visit_id',         p_visit_id,
         'reason',           p_reason,
         'note',             v_trimmed_note,
         'staff_account_id', v_account_id
       ));
  end if;
end;
$$;

revoke all on function public.lng_end_visit_early(uuid, uuid, text, text, jsonb) from public;
grant execute on function public.lng_end_visit_early(uuid, uuid, text, text, jsonb) to authenticated;

comment on function public.lng_end_visit_early(uuid, uuid, text, text, jsonb) is
  'Atomic End-visit-early. p_reason=unsuitable picks individual items; everything else removes all active cart lines (with removed_reason=visit_ended_early). Flips lng_visits.status, flips the schedule row to complete when the visit actually terminates, writes patient_events. Replaces the multi-call client orchestration in submitEndEarly().';

-- ── 4. lng_reverse_visit_end ─────────────────────────────────────
-- Unchanged from 20260519000006 except for putting the schedule row
-- back to 'arrived' alongside the visit.

create or replace function public.lng_reverse_visit_end(
  p_visit_id    uuid,
  p_patient_id  uuid,
  p_note        text default null
)
returns table (restored_count int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id    uuid;
  v_cart_id       uuid;
  v_visit_status  text;
  v_trimmed_note  text;
  v_restored      int := 0;
begin
  v_account_id   := public.auth_account_id();
  v_trimmed_note := nullif(btrim(coalesce(p_note, '')), '');

  select status into v_visit_status from public.lng_visits where id = p_visit_id for update;
  if not found then
    raise exception 'Visit % not found', p_visit_id using errcode = 'P0002';
  end if;
  if v_visit_status not in ('unsuitable', 'ended_early') then
    raise exception 'Visit % is in status % — only unsuitable or ended_early visits can be resumed', p_visit_id, v_visit_status
      using errcode = '22023';
  end if;

  select id into v_cart_id from public.lng_carts where visit_id = p_visit_id for update;

  if v_cart_id is not null then
    update public.lng_cart_items
       set removed_at     = null,
           removed_reason = null,
           removed_by     = null,
           removed_note   = null
     where cart_id = v_cart_id
       and removed_at is not null
       and removed_reason in ('unsuitable', 'visit_ended_early');
    get diagnostics v_restored = row_count;
  end if;

  update public.lng_visits
     set status           = 'arrived',
         closed_at        = null,
         visit_end_reason = null,
         visit_end_note   = null
   where id = p_visit_id;

  -- NEW: the patient is back in the chair, so the booking has to come
  -- back with them. Without this the resumed visit would leave a
  -- dimmed "Complete" row on the schedule that staff cannot recover.
  perform public.lng_set_visit_schedule_status(p_visit_id, 'arrived');

  insert into public.patient_events
    (patient_id, event_type, actor_account_id, notes, payload)
  values
    (p_patient_id, 'patient_unsuitable_reversed', v_account_id, v_trimmed_note,
     jsonb_build_object(
       'visit_id',         p_visit_id,
       'staff_account_id', v_account_id,
       'restored_count',   v_restored,
       'note',             v_trimmed_note
     ));

  return query select v_restored;
end;
$$;

revoke all on function public.lng_reverse_visit_end(uuid, uuid, text) from public;
grant execute on function public.lng_reverse_visit_end(uuid, uuid, text) to authenticated;

comment on function public.lng_reverse_visit_end(uuid, uuid, text) is
  'Reverse an unsuitable or ended-early visit. Restores cart lines where removed_reason IN (unsuitable, visit_ended_early); leaves mistake / changed_mind removals as-is so issued refunds stay reconciled. Flips visit and its schedule row back to arrived. Atomic.';

-- ── 5. Backfill the stranded rows ────────────────────────────────
-- 12 rows as measured on 13 Aug 2026 (11 booked appointments, 1
-- walk-in marker). Scoped the same way the helper resolves: booked
-- appointments via lng_visits.appointment_id, walk-in markers via
-- lng_appointments.walk_in_id. Only rows still on 'arrived' are
-- touched, so this cannot disturb a booking that was later cancelled
-- or rescheduled by hand.
--
-- Idempotent: re-running matches nothing once the rows are flipped.

update public.lng_appointments a
   set status = 'complete'
  from public.lng_visits v
 where a.status = 'arrived'
   and v.appointment_id = a.id
   and v.status in ('unsuitable', 'ended_early');

update public.lng_appointments a
   set status = 'complete'
  from public.lng_visits v
 where a.status = 'arrived'
   and a.walk_in_id is not null
   and v.walk_in_id = a.walk_in_id
   and v.status in ('unsuitable', 'ended_early');

-- ── Rollback ─────────────────────────────────────────────────────
-- Re-apply 20260519000006 to restore the three RPCs, then:
-- drop function if exists public.lng_set_visit_schedule_status(uuid, text);
-- The backfill is not reversible in isolation — 'arrived' cannot be
-- distinguished afterwards from a row that was legitimately arrived.
-- Re-derive from lng_visits.status if it ever needs undoing.
