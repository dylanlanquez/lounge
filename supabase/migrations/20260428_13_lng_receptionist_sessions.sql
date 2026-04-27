-- 20260428_13_lng_receptionist_sessions.sql
-- Per-tablet receptionist session. Tracks which staff is signed in at which device,
-- the idle lock state, and supports server-side device revocation.
--
-- Per brief §7 (data protection) and `02-data-protection.md §3.4`.
--
-- Rollback: DROP TABLE public.lng_receptionist_sessions;

create table public.lng_receptionist_sessions (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.accounts(id) on delete cascade,
  location_id     uuid not null references public.locations(id) on delete cascade,
  device_id       text not null,
  device_label    text,
  signed_in_at    timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  locked_at       timestamptz,
  failed_pin_at   timestamptz,
  failed_pin_count int not null default 0,
  revoked_at      timestamptz,
  revoked_by      uuid references public.accounts(id) on delete set null,
  ended_at        timestamptz,
  user_agent      text,
  ip_inet         inet,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index lng_receptionist_sessions_account_active_idx
  on public.lng_receptionist_sessions (account_id)
  where ended_at is null and revoked_at is null;
create index lng_receptionist_sessions_device_idx
  on public.lng_receptionist_sessions (device_id);

create trigger lng_receptionist_sessions_set_updated_at
  before update on public.lng_receptionist_sessions
  for each row execute function public.touch_updated_at();

comment on table public.lng_receptionist_sessions is
  'Per-tablet sessions. Admin can revoke (revoked_at) for lost devices. ended_at is normal sign-out. Failed PIN counter rate-limits unlock attempts.';
