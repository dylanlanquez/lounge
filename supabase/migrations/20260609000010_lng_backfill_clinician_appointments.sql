-- 20260609000010_lng_backfill_clinician_appointments.sql
--
-- CRITICAL data fix. 20260609000006 re-keyed virtual availability + the
-- no-double-book guard from meet_host_id onto clinician_staff_member_id,
-- but appointments booked BEFORE that migration have meet_host_id set and
-- clinician_staff_member_id NULL. The new guard skips NULL-clinician rows
-- and the availability free-check ignores them, so an existing virtual
-- booking is invisible to the new system — a new booking could be placed
-- on top of it. This backfills the clinician on those rows so existing
-- bookings are protected again.
--
-- Two steps:
--   1. Link any unlinked OAuth Meet host to a staff member by an exact,
--      unambiguous display-name match (the seed in 000006 only matched by
--      email, which missed hosts whose Google email differs from their
--      staff login).
--   2. Backfill clinician_staff_member_id on virtual appointments from
--      their linked host. The guard is briefly disabled for the UPDATE:
--      legacy data may already contain overlapping bookings we must NOT
--      reject (we're stamping history, not creating a booking); future
--      bookings are still fully guarded once the trigger is back on.
--
-- Appointments with no meet_host_id (Calendly / service-account legacy)
-- keep clinician NULL — they were never host-guarded either, so there is
-- no regression for them.
--
-- Idempotent. Apply: shadow first, then Meridian.

-- ── 1. Link unlinked OAuth hosts by unique display-name match ──────
do $$
declare
  r     record;
  v_ids uuid[];
begin
  for r in
    select id, display_name
      from public.lng_meet_hosts
     where kind = 'oauth' and staff_member_id is null and display_name is not null
  loop
    select array_agg(sm.id)
      into v_ids
      from public.lng_staff_members sm
      join public.accounts a on a.id = sm.account_id
     where sm.status = 'active'
       and lower(btrim(coalesce(a.name, btrim(coalesce(a.first_name,'') || ' ' || coalesce(a.last_name,'')))))
           = lower(btrim(r.display_name));
    -- Only link on an unambiguous, single match.
    if v_ids is not null and array_length(v_ids, 1) = 1 then
      update public.lng_meet_hosts
         set staff_member_id = v_ids[1]
       where id = r.id and staff_member_id is null;
    end if;
  end loop;
end $$;

-- ── 2. Backfill clinician on existing virtual appointments ─────────
alter table public.lng_appointments disable trigger zz_virtual_clinician_overlap_guard;

update public.lng_appointments a
   set clinician_staff_member_id = mh.staff_member_id
  from public.lng_meet_hosts mh
 where a.meet_host_id = mh.id
   and a.service_type = 'virtual_impression_appointment'
   and a.clinician_staff_member_id is null
   and mh.staff_member_id is not null;

alter table public.lng_appointments enable trigger zz_virtual_clinician_overlap_guard;

NOTIFY pgrst, 'reload schema';
