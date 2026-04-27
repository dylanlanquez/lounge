-- 20260428_07_lng_appointments_walk_ins_visits.sql
-- Three tables created together because they reference each other.
--
--   lng_appointments  one row per booking, regardless of source
--   lng_walk_ins      one row per walk-in (no prior booking)
--   lng_visits        unifying record. EXACTLY ONE of (appointment_id, walk_in_id) is non-null.
--
-- A booked appointment becomes a visit on arrival; a walk-in becomes a visit immediately.
-- The visit is the spine of the EPOS/cart/payment chain.
--
-- Per `01-architecture-decision.md §3.4` and `06-patient-identity.md §6`.
--
-- Rollback: DROP TABLE lng_visits, lng_walk_ins, lng_appointments;

-- ---------- lng_appointments ----------
create table public.lng_appointments (
  id                    uuid primary key default gen_random_uuid(),
  patient_id            uuid not null references public.patients(id) on delete restrict,
  location_id           uuid not null references public.locations(id) on delete restrict,
  source                text not null check (source in ('calendly', 'native', 'manual')),
  calendly_event_uri    text,
  calendly_invitee_uri  text,
  start_at              timestamptz not null,
  end_at                timestamptz not null,
  staff_account_id      uuid references public.accounts(id) on delete set null,
  event_type_label      text,
  status                text not null default 'booked'
                            check (status in ('booked', 'arrived', 'in_progress',
                                              'complete', 'no_show', 'cancelled', 'rescheduled')),
  cancel_reason         text,
  reschedule_to_id      uuid references public.lng_appointments(id) on delete set null,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint lng_appointments_time_order check (end_at > start_at)
);

create index lng_appointments_location_start_idx
  on public.lng_appointments (location_id, start_at);
create index lng_appointments_patient_idx
  on public.lng_appointments (patient_id);
create index lng_appointments_status_idx
  on public.lng_appointments (status);
create unique index lng_appointments_calendly_invitee_uri_unique
  on public.lng_appointments (calendly_invitee_uri)
  where calendly_invitee_uri is not null;

create trigger lng_appointments_set_updated_at
  before update on public.lng_appointments
  for each row execute function public.touch_updated_at();

comment on table public.lng_appointments is
  'One row per booking, any source. status flips through the visit lifecycle. calendly_invitee_uri is the dedupe key for Calendly-sourced rows.';

-- ---------- lng_walk_ins ----------
create table public.lng_walk_ins (
  id                  uuid primary key default gen_random_uuid(),
  patient_id          uuid not null references public.patients(id) on delete restrict,
  location_id         uuid not null references public.locations(id) on delete restrict,
  arrival_type        text not null default 'walk_in'
                          check (arrival_type in ('walk_in', 'pre_booked')),
  scheduled_for       timestamptz,
  service_type        text,
  appliance_type      text,
  arch                text check (arch is null or arch in ('upper', 'lower', 'both')),
  repair_notes        text,
  waiver_signed_at    timestamptz,
  waiver_file_id      uuid references public.patient_files(id) on delete set null,
  created_by          uuid references public.accounts(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index lng_walk_ins_location_created_idx
  on public.lng_walk_ins (location_id, created_at desc);
create index lng_walk_ins_patient_idx
  on public.lng_walk_ins (patient_id);

create trigger lng_walk_ins_set_updated_at
  before update on public.lng_walk_ins
  for each row execute function public.touch_updated_at();

comment on table public.lng_walk_ins is
  'Drop-ins without a prior booking, plus pre_booked entries from non-Calendly sources. Always becomes a lng_visit.';

-- ---------- lng_visits ----------
create table public.lng_visits (
  id                uuid primary key default gen_random_uuid(),
  patient_id        uuid not null references public.patients(id) on delete restrict,
  location_id       uuid not null references public.locations(id) on delete restrict,
  appointment_id    uuid unique references public.lng_appointments(id) on delete restrict,
  walk_in_id        uuid unique references public.lng_walk_ins(id) on delete restrict,
  status            text not null default 'opened'
                        check (status in ('opened', 'in_progress', 'complete', 'cancelled')),
  arrival_type      text not null check (arrival_type in ('walk_in', 'scheduled')),
  receptionist_id   uuid references public.accounts(id) on delete set null,
  opened_at         timestamptz not null default now(),
  closed_at         timestamptz,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint lng_visits_one_origin
    check ((appointment_id is null) <> (walk_in_id is null))
);

create index lng_visits_location_opened_idx on public.lng_visits (location_id, opened_at desc);
create index lng_visits_patient_idx          on public.lng_visits (patient_id);
create index lng_visits_status_idx           on public.lng_visits (status);

create trigger lng_visits_set_updated_at
  before update on public.lng_visits
  for each row execute function public.touch_updated_at();

comment on table public.lng_visits is
  'Spine of the EPOS chain. Exactly one of (appointment_id, walk_in_id) is set. status drives UI affordances.';
