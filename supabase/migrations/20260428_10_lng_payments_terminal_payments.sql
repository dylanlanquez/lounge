-- 20260428_10_lng_payments_terminal_payments.sql
-- Payment attempts and Stripe-Terminal-specific detail.
--
-- lng_payments is the canonical row "did the money arrive?".
-- lng_terminal_payments is the Stripe-specific 1:1 child for card_terminal payments.
--
-- payment_journey distinguishes BNPL taps from regular contactless. Same code path
-- in terminal-start-payment; the journey value is just a tag for reporting.
-- Legacy values (klarna_legacy_shopify, clearpay_legacy_shopify) are reserved
-- for the Phase 4 backfill from Checkpoint's payments_klarna / payments_clearpay.
--
-- Per brief §5.4 and `01-architecture-decision.md §3.4`.
--
-- Rollback: DROP TABLE lng_terminal_payments, lng_payments;

create table public.lng_payments (
  id                uuid primary key default gen_random_uuid(),
  cart_id           uuid not null references public.lng_carts(id) on delete restrict,
  method            text not null
                       check (method in ('card_terminal', 'cash', 'gift_card', 'account_credit')),
  payment_journey   text not null default 'standard'
                       check (payment_journey in ('standard', 'klarna', 'clearpay',
                                                  'klarna_legacy_shopify',
                                                  'clearpay_legacy_shopify')),
  amount_pence      int  not null check (amount_pence > 0),
  status            text not null default 'pending'
                       check (status in ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  failure_reason    text,
  taken_by          uuid references public.accounts(id) on delete set null,
  notes             text,
  created_at        timestamptz not null default now(),
  succeeded_at      timestamptz,
  cancelled_at      timestamptz,
  updated_at        timestamptz not null default now()
);

create index lng_payments_cart_idx     on public.lng_payments (cart_id);
create index lng_payments_status_idx   on public.lng_payments (status);
create index lng_payments_journey_idx  on public.lng_payments (payment_journey);
create index lng_payments_created_idx  on public.lng_payments (created_at desc);

create trigger lng_payments_set_updated_at
  before update on public.lng_payments
  for each row execute function public.touch_updated_at();

create table public.lng_terminal_payments (
  id                          uuid primary key default gen_random_uuid(),
  payment_id                  uuid not null unique
                                  references public.lng_payments(id) on delete cascade,
  stripe_payment_intent_id    text not null unique,
  stripe_reader_id            text not null,
  stripe_location_id          text not null,
  idempotency_key             text not null unique,
  reader_action_status        text,
  raw_event                   jsonb,
  created_at                  timestamptz not null default now(),
  succeeded_at                timestamptz,
  updated_at                  timestamptz not null default now()
);

create index lng_terminal_payments_reader_idx on public.lng_terminal_payments (stripe_reader_id);

create trigger lng_terminal_payments_set_updated_at
  before update on public.lng_terminal_payments
  for each row execute function public.touch_updated_at();

comment on table public.lng_payments is
  'Canonical "did the money arrive?". One row per attempt. status flips via webhook (card) or immediately (cash).';
comment on table public.lng_terminal_payments is
  '1:1 child of lng_payments where method = card_terminal. Webhook lookup is by stripe_payment_intent_id (canonical), not metadata.';
