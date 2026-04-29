-- 20260429000008_lng_seed_more_visits_mp00043.sql
--
-- Top-up. Migration 07's visit seed was guarded at "skip if patient
-- already has 5+ visits" — MP-00043 had 7, so it skipped. We still want
-- the patient inflated past 20 visits so the new 10-per-page
-- pagination on the patient profile can be exercised end-to-end.
--
-- This migration uses a higher guard (skip if 25+) and inserts another
-- 20. Re-running on an already-padded patient is a no-op.

do $$
declare
  pid uuid;
  loc uuid;
  existing int;
  i int;
  walk_in_id uuid;
  service_types text[] := array['denture_repair', 'same_day_appliance', 'click_in_veneers', 'impression_appointment', 'other'];
  statuses text[] := array['complete', 'complete', 'complete', 'complete', 'cancelled'];
begin
  select id, location_id into pid, loc from public.patients where internal_ref = 'MP-00043' limit 1;
  if pid is null or loc is null then
    raise notice 'No MP-00043 / location; skipping top-up.';
    return;
  end if;

  select count(*) into existing from public.lng_visits where patient_id = pid;
  if existing >= 25 then
    raise notice 'Patient MP-00043 already has % visits; skipping top-up.', existing;
    return;
  end if;

  for i in 1..20 loop
    insert into public.lng_walk_ins (patient_id, location_id, service_type, created_at)
      values (pid, loc, service_types[((i - 1) % array_length(service_types, 1)) + 1], now() - (i * interval '5 days') - interval '180 days')
      returning id into walk_in_id;

    insert into public.lng_visits (patient_id, location_id, walk_in_id, status, arrival_type, opened_at, closed_at)
      values (
        pid,
        loc,
        walk_in_id,
        statuses[((i - 1) % array_length(statuses, 1)) + 1],
        'walk_in',
        now() - (i * interval '5 days') - interval '180 days',
        case when statuses[((i - 1) % array_length(statuses, 1)) + 1] = 'complete'
             then now() - (i * interval '5 days') - interval '180 days' + interval '90 minutes'
             else null end
      );
  end loop;

  raise notice 'Topped up MP-00043 with 20 additional visits.';
end $$;
