-- 20260518000008_lng_same_day_chair_held.sql
--
-- Same-day services (same_day_appliance, click_in_veneers) must hold
-- the consultation room for their entire window, because the patient
-- physically stays in the chair while the appliance is being made.
-- Until this migration the Manufacture phase was configured with an
-- empty pool_ids array, which signals to the conflict checker "chair
-- is free during this phase". The checker then correctly (per the
-- config) allowed two same-day bookings to coexist as long as their
-- short Impression phases didn't overlap in clock-time — leaving
-- staff with a calendar showing a chair occupied twice over.
--
-- The pattern existed because the phase model was originally
-- designed around denture_repair, where the patient drops their
-- denture off, leaves, and comes back hours later. For denture_repair
-- the empty pool list during Repair is correct: the chair is genuinely
-- free for another patient. For same-day-in-chair services it is not.
--
-- Fix: attach `consult-room` to the Manufacture phase of those two
-- services. With that, a same-day booking holds the chair from its
-- Impression phase through the end of the appointment block, and the
-- conflict checker / overlap guard catches every overlapping booking
-- the way operators expect.
--
-- Re-materialise active same-day appointments so existing phase rows
-- pick up the new pool list. lng_materialise_appointment_phases is
-- the canonical helper; calling it deletes the old phase rows and
-- re-inserts the new ones with the same start/end windows. The
-- materialiser is idempotent so running it twice is a no-op.

-- ── 1. Patch the phase pool config ────────────────────────────────
-- For each (service_type, phase label='Manufacture') pair, insert
-- the (phase_id, 'consult-room') row in lng_booking_type_phase_pools.
-- The PRIMARY KEY on (phase_id, pool_id) means re-running this
-- migration is a no-op once the row exists.

insert into public.lng_booking_type_phase_pools (phase_id, pool_id)
select p.id, 'consult-room'
  from public.lng_booking_type_phases p
  join public.lng_booking_type_config c on c.id = p.config_id
 where c.repair_variant is null
   and c.product_key   is null
   and c.arch          is null
   and c.service_type in ('same_day_appliance', 'click_in_veneers')
   and p.label = 'Manufacture'
on conflict (phase_id, pool_id) do nothing;

-- ── 2. Re-materialise live same-day appointments ─────────────────
-- Iterates active rows only (booked / arrived / joined). The helper
-- deletes existing phase rows and re-inserts them; the appointment's
-- start_at / end_at don't move so the windows stay stable, only the
-- pool_ids on the Manufacture phase row change. Phase materialisation
-- runs as security definer so RLS doesn't matter.

do $$
declare
  r record;
begin
  for r in
    select a.id
      from public.lng_appointments a
     where a.service_type in ('same_day_appliance', 'click_in_veneers')
       and a.status in ('booked', 'arrived', 'joined')
     order by a.start_at, a.created_at
  loop
    perform public.lng_materialise_appointment_phases(r.id);
  end loop;
end$$;

-- ── Rollback ──────────────────────────────────────────────────────
-- delete from public.lng_booking_type_phase_pools
--  where pool_id = 'consult-room'
--    and phase_id in (
--      select p.id
--        from public.lng_booking_type_phases p
--        join public.lng_booking_type_config c on c.id = p.config_id
--       where c.repair_variant is null and c.product_key is null
--         and c.arch is null
--         and c.service_type in ('same_day_appliance', 'click_in_veneers')
--         and p.label = 'Manufacture'
--    );
-- followed by re-materialising active rows to drop the pool from
-- their phase rows.
