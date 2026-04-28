-- 20260428000029_lng_walk_ins_arrival_intake.sql
--
-- Brings walk-ins through the same arrival intake gate as scheduled
-- appointments. Migration 28 added jb_ref + appointment_ref to
-- lng_appointments for booked-then-arrived patients; this one mirrors
-- those columns on lng_walk_ins so a drop-in patient also gets a
-- LNGE-APT- ref and (where applicable) a JB stamp before the visit
-- opens.
--
-- Both tables share generate_appointment_ref(): the counter is global,
-- so refs across booked + walk-in arrivals on the same day stay
-- monotonic and globally unique. Each table keeps its own unique
-- index as a belt-and-braces dedupe.
--
-- Adds:
--   lng_walk_ins.jb_ref            text   (digits only, e.g. '33')
--   lng_walk_ins.appointment_ref   text   (LNGE-APT-YYYYMMDD-NNNN)
--   trigger lng_walk_ins_guard_appointment_ref — once stamped, immutable
--
-- Rollback at the bottom.

alter table public.lng_walk_ins
  add column if not exists jb_ref          text,
  add column if not exists appointment_ref text;

create unique index if not exists lng_walk_ins_appointment_ref_unique
  on public.lng_walk_ins (appointment_ref)
  where appointment_ref is not null;

comment on column public.lng_walk_ins.jb_ref is
  'Job box ref the lab assigned to the walk-in''s impression at intake (digits only, e.g. ''33''). NULL when the walk-in doesn''t take an impression.';
comment on column public.lng_walk_ins.appointment_ref is
  'Human-readable appointment reference (LNGE-APT-YYYYMMDD-NNNN). Stamped at walk-in creation. Immutable once set (see lng_walk_ins_guard_appointment_ref). Shares generate_appointment_ref() with lng_appointments so refs across both surfaces stay monotonic.';

create or replace function public.lng_walk_ins_guard_appointment_ref()
returns trigger
language plpgsql
as $$
begin
  if old.appointment_ref is not null and new.appointment_ref is distinct from old.appointment_ref then
    raise exception 'lng_walk_ins.appointment_ref is immutable once set (was %, attempted %)',
      old.appointment_ref, coalesce(new.appointment_ref, '<NULL>');
  end if;
  return new;
end;
$$;

drop trigger if exists lng_walk_ins_guard_appointment_ref on public.lng_walk_ins;
create trigger lng_walk_ins_guard_appointment_ref
  before update of appointment_ref on public.lng_walk_ins
  for each row execute function public.lng_walk_ins_guard_appointment_ref();

comment on function public.lng_walk_ins_guard_appointment_ref() is
  'Refuses any UPDATE that changes a non-null lng_walk_ins.appointment_ref. Stamp once, never overwrite.';

-- Rollback:
-- DROP TRIGGER lng_walk_ins_guard_appointment_ref ON public.lng_walk_ins;
-- DROP FUNCTION public.lng_walk_ins_guard_appointment_ref();
-- ALTER TABLE public.lng_walk_ins
--   DROP COLUMN IF EXISTS appointment_ref,
--   DROP COLUMN IF EXISTS jb_ref;
