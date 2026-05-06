-- Fix auto-ref trigger to cover manual-source virtual appointments.
--
-- The original trigger skipped every source='manual' row because those
-- are walk-in calendar markers whose appointment_ref lives on lng_walk_ins.
-- But virtual appointments created outside Calendly also arrive with
-- source='manual' and a real join_url — they must get a LAP ref.
--
-- Discriminator: walk-in markers never carry a join_url; virtual rows
-- always do. So the skip now requires BOTH manual source AND no join_url.

create or replace function public.lng_appointments_auto_ref()
returns trigger
language plpgsql
as $$
begin
  if new.appointment_ref is null
     and not (new.source = 'manual' and new.join_url is null)
  then
    new.appointment_ref := public.generate_appointment_ref();
  end if;
  return new;
end;
$$;

-- Backfill the two existing manual virtual appointments that missed their ref.
do $$
declare
  r record;
begin
  for r in
    select id
    from public.lng_appointments
    where appointment_ref is null
      and join_url is not null
    order by start_at, created_at
  loop
    update public.lng_appointments
       set appointment_ref = public.generate_appointment_ref()
     where id = r.id;
  end loop;
end;
$$;
