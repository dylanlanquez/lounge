-- 20260428_06_lng_terminal_sessions.sql
-- Connection-state log for terminal pairing. Append-only.
-- Used by /admin/terminal-pairing to show "last connected" history.
--
-- Rollback: DROP TABLE public.lng_terminal_sessions;

create table public.lng_terminal_sessions (
  id           uuid primary key default gen_random_uuid(),
  reader_id    uuid not null references public.lng_terminal_readers(id) on delete cascade,
  event_type   text not null
                  check (event_type in ('connected', 'disconnected', 'paired', 'unpaired',
                                        'firmware_update_started', 'firmware_update_complete')),
  payload      jsonb,
  occurred_at  timestamptz not null default now()
);

create index lng_terminal_sessions_reader_occurred_idx
  on public.lng_terminal_sessions (reader_id, occurred_at desc);

comment on table public.lng_terminal_sessions is
  'Append-only event log for terminal connection / pairing state. Used for /admin/terminal-pairing diagnostics.';
