-- 20260428000028_lng_arrival_intake.sql
--
-- Pre-arrival intake gate.
--
-- When staff mark an in-person appointment as arrived, they first work
-- through an intake sheet that captures any missing patient compliance
-- fields, an emergency contact, and the JB ref the impression went into
-- (when the lab needs one). Submit stamps a human-readable
-- LNGE-APT-YYYYMMDD-NNNN reference on the appointment so the impression
-- can be tied back without reading UUIDs.
--
-- Virtual impression appointments skip intake — they keep flowing
-- through markVirtualMeetingJoined() and never need a JB.
--
-- Adds:
--   patients.emergency_contact_name        text
--   patients.emergency_contact_phone       text
--   lng_appointments.jb_ref                text   (digits only, e.g. '33')
--   lng_appointments.appointment_ref       text   (LNGE-APT-YYYYMMDD-NNNN)
--   lng_appointment_ref_sequences          per-day counter (mirrors
--                                          lng_lwo_sequences from migration 14)
--   public.generate_appointment_ref()      RPC
--   trigger lng_appointments_guard_appointment_ref — once stamped, immutable
--
-- Rollback at the bottom of the file.

-- ── 1. patients ─────────────────────────────────────────────────────────────
-- Emergency contact persists across visits; collected once at first
-- arrival and editable thereafter. Lives on patients (not lng_*) because
-- it's patient-axis data Meridian may also surface in future. Coordinated
-- with Meridian: no existing column collides (verified against the
-- 20260411_11 patients schema).
alter table public.patients
  add column if not exists emergency_contact_name  text,
  add column if not exists emergency_contact_phone text;

comment on column public.patients.emergency_contact_name  is
  'Emergency contact full name. Captured at first Lounge arrival, editable thereafter.';
comment on column public.patients.emergency_contact_phone is
  'Emergency contact phone. Free-text; UI validates loosely.';

-- ── 2. lng_appointments per-appointment intake fields ───────────────────────
alter table public.lng_appointments
  add column if not exists jb_ref          text,
  add column if not exists appointment_ref text;

create unique index if not exists lng_appointments_appointment_ref_unique
  on public.lng_appointments (appointment_ref)
  where appointment_ref is not null;

comment on column public.lng_appointments.jb_ref is
  'Job box ref the lab assigned to the impression at intake (digits only, e.g. ''33''; Checkpoint stores ''JB''||jb_ref). NULL when the appointment doesn''t take an impression. Verified against Checkpoint at submit time so two patients can''t share a JB.';
comment on column public.lng_appointments.appointment_ref is
  'Human-readable appointment reference (LNGE-APT-YYYYMMDD-NNNN). Stamped at intake submit. Immutable once set (see lng_appointments_guard_appointment_ref).';

-- ── 3. per-day counter + RPC ────────────────────────────────────────────────
-- Mirrors lng_lwo_sequences exactly so anyone reading either function
-- recognises the pattern. Singleton row, day rollover handled inside the
-- UPDATE.
create table if not exists public.lng_appointment_ref_sequences (
  id          int primary key default 1,
  year        int not null,
  month       int not null,
  day         int not null,
  next_value  int not null,
  updated_at  timestamptz not null default now(),
  constraint lng_appointment_ref_sequences_singleton check (id = 1)
);

insert into public.lng_appointment_ref_sequences (id, year, month, day, next_value)
values (
  1,
  extract(year  from now())::int,
  extract(month from now())::int,
  extract(day   from now())::int,
  1
)
on conflict (id) do nothing;

create or replace function public.generate_appointment_ref()
returns text
language plpgsql
as $$
declare
  v_year  int := extract(year  from now())::int;
  v_month int := extract(month from now())::int;
  v_day   int := extract(day   from now())::int;
  v_n     int;
begin
  update public.lng_appointment_ref_sequences
     set year       = case when year = v_year and month = v_month and day = v_day then year       else v_year  end,
         month      = case when year = v_year and month = v_month and day = v_day then month      else v_month end,
         day        = case when year = v_year and month = v_month and day = v_day then day        else v_day   end,
         next_value = case when year = v_year and month = v_month and day = v_day then next_value + 1 else 2     end,
         updated_at = now()
   where id = 1
   returning (case when year = v_year and month = v_month and day = v_day then next_value - 1 else 1 end)
     into v_n;

  if v_n is null then
    raise exception 'lng_appointment_ref_sequences row missing — was migration 28 applied?';
  end if;

  return format('LNGE-APT-%s%s%s-%s',
    lpad(v_year::text,  4, '0'),
    lpad(v_month::text, 2, '0'),
    lpad(v_day::text,   2, '0'),
    lpad(v_n::text,     4, '0'));
end;
$$;

comment on function public.generate_appointment_ref() is
  'Returns the next appointment reference (LNGE-APT-YYYYMMDD-NNNN). Atomically increments lng_appointment_ref_sequences.';

-- ── 4. immutability guard for appointment_ref ───────────────────────────────
-- Mirrors patients_guard_lwo_ref: once stamped, the ref is the patient's
-- and the lab's handle on the impression. Reassigning it would orphan
-- paperwork at the lab.
create or replace function public.lng_appointments_guard_appointment_ref()
returns trigger
language plpgsql
as $$
begin
  if old.appointment_ref is not null and new.appointment_ref is distinct from old.appointment_ref then
    raise exception 'lng_appointments.appointment_ref is immutable once set (was %, attempted %)',
      old.appointment_ref, coalesce(new.appointment_ref, '<NULL>');
  end if;
  return new;
end;
$$;

drop trigger if exists lng_appointments_guard_appointment_ref on public.lng_appointments;
create trigger lng_appointments_guard_appointment_ref
  before update of appointment_ref on public.lng_appointments
  for each row execute function public.lng_appointments_guard_appointment_ref();

comment on function public.lng_appointments_guard_appointment_ref() is
  'Refuses any UPDATE that changes a non-null lng_appointments.appointment_ref. Stamp once, never overwrite.';

-- ── Rollback ────────────────────────────────────────────────────────────────
-- DROP TRIGGER lng_appointments_guard_appointment_ref ON public.lng_appointments;
-- DROP FUNCTION public.lng_appointments_guard_appointment_ref();
-- DROP FUNCTION public.generate_appointment_ref();
-- DROP TABLE public.lng_appointment_ref_sequences;
-- ALTER TABLE public.lng_appointments
--   DROP COLUMN IF EXISTS appointment_ref,
--   DROP COLUMN IF EXISTS jb_ref;
-- ALTER TABLE public.patients
--   DROP COLUMN IF EXISTS emergency_contact_phone,
--   DROP COLUMN IF EXISTS emergency_contact_name;
