-- 20260428_01_lng_lwo_sequences.sql
-- Backing counter for generate_lwo_ref(). Single-row table per the patient_sequences
-- pattern. CHECK (id = 1) keeps it singleton. The function in migration 14 atomically
-- increments next_value with day-rollover.
--
-- Format produced: LWO-YYYYMMDD-NNNN (per `06-patient-identity.md §5.1`).
--
-- Rollback: DROP TABLE public.lng_lwo_sequences;

create table public.lng_lwo_sequences (
  id          int  primary key default 1 check (id = 1),
  year        int  not null,
  month       int  not null,
  day         int  not null,
  next_value  int  not null default 1,
  updated_at  timestamptz not null default now()
);

insert into public.lng_lwo_sequences (id, year, month, day, next_value)
values (1, extract(year from now())::int, extract(month from now())::int, extract(day from now())::int, 1);

comment on table public.lng_lwo_sequences is
  'Singleton counter backing generate_lwo_ref(). Format: LWO-YYYYMMDD-NNNN, per-day monotonic. Reset by UPDATE … SET next_value = 1.';
