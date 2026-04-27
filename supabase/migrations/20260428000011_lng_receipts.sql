-- 20260428_11_lng_receipts.sql
-- Receipt issuance log. Append-only.
-- recipient is the destination (email or phone) or NULL for channel='print'/'none'.
-- content jsonb is the rendered receipt body, retained for audit / replay.
--
-- Per brief §5.9 and `02-data-protection.md §7.4`.
--
-- Rollback: DROP TABLE public.lng_receipts;

create table public.lng_receipts (
  id              uuid primary key default gen_random_uuid(),
  payment_id      uuid not null references public.lng_payments(id) on delete restrict,
  channel         text not null check (channel in ('print', 'email', 'sms', 'none')),
  recipient       text,
  sent_at         timestamptz,
  content         jsonb,
  failure_reason  text,
  created_at      timestamptz not null default now()
);

create index lng_receipts_payment_idx on public.lng_receipts (payment_id);
create index lng_receipts_channel_sent_idx on public.lng_receipts (channel, sent_at desc);

comment on table public.lng_receipts is
  'Append-only log of receipts issued. Each send writes a row + a patient_events row (event_type=receipt_sent).';
