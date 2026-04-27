-- 20260428_05_lng_terminal_readers.sql
-- Registry of S700 hardware. friendly_name is the receptionist-facing label
-- ("Motherwell counter"); stripe_reader_id is the canonical Stripe ID (tmr_*).
--
-- Per brief §5.4 and `01-architecture-decision.md §3.4`.
--
-- Rollback: DROP TABLE public.lng_terminal_readers;

create table public.lng_terminal_readers (
  id                  uuid primary key default gen_random_uuid(),
  friendly_name       text not null,
  stripe_reader_id    text not null unique,
  stripe_location_id  text not null,
  location_id         uuid not null references public.locations(id) on delete restrict,
  status              text not null default 'unknown'
                          check (status in ('online', 'offline', 'unknown')),
  last_seen_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index lng_terminal_readers_location_idx on public.lng_terminal_readers (location_id);
create index lng_terminal_readers_status_idx   on public.lng_terminal_readers (status);

create trigger lng_terminal_readers_set_updated_at
  before update on public.lng_terminal_readers
  for each row execute function public.touch_updated_at();

comment on table public.lng_terminal_readers is
  'Stripe Terminal reader registry. friendly_name shown to receptionist; stripe_reader_id (tmr_*) is the canonical link.';
