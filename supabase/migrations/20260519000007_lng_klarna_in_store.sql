-- 20260519000007_lng_klarna_in_store.sql
--
-- Native Klarna In-Store integration via Klarna's own API
-- (POST /payments/v1/sessions with acquiring_channel='in_store').
-- Replaces the prior virtual-Visa-via-Stripe-Terminal flow for
-- Klarna while leaving Clearpay on that path.
--
-- ── Why this exists ──────────────────────────────────────────────
-- The previous "Klarna" path required the patient to:
--   1. Have the Klarna app installed
--   2. Have a Klarna virtual Visa minted in the app
--   3. Have Apple Pay / Google Pay set up
--   4. Tap the S700 terminal with that virtual card
-- A failure at any step (no app, no virtual card, no wallet,
-- terminal decline) dropped the patient back to needing card or
-- cash. The new Klarna API path opens the customer's Klarna app
-- directly via QR scan / payment link with no terminal involvement
-- — Klarna handles install, sign-in, plan selection, and approval
-- inside their own flow. We hold a QR on the till screen until
-- the order completes.
--
-- Apparatus:
--   • Klarna POST /payments/v1/sessions      → creates the session
--   • POST {distribution.result_url}         → returns the QR + payment_link
--   • Webhook on distribution.callback_urls  → fires when order completes / fails
--   • Klarna POST /ordermanagement/v1/orders/{id}/refunds → refund
--
-- ── Apparatus on our side ────────────────────────────────────────
-- New table `lng_klarna_sessions` holds the Klarna-specific
-- metadata 1:1 with the parent `lng_payments` row — same pattern
-- as `lng_terminal_payments`:
--
--   lng_payments        (method='klarna', payment_journey='klarna')
--      └── lng_klarna_sessions  (1:1 child, Klarna-specific fields)
--
-- The session table carries: Klarna's session_id, result_url, the
-- QR + payment_link we hand the customer, the session-bound
-- webhook token, raw request/response/webhook bodies for audit,
-- and the session lifecycle status. Refunds reuse the existing
-- `lng_payment_refunds` table with method='klarna' (new value).
--
-- ── Status lifecycle ─────────────────────────────────────────────
-- pending           — create-session in flight; row exists, no
--                     Klarna ID yet (rare; fail-fast on the edge
--                     function's error paths)
-- awaiting_customer — Klarna session created, QR shown to customer,
--                     waiting for them to scan + complete in their
--                     Klarna app
-- captured          — Klarna webhook reported COMPLETED, money
--                     committed, order_id present
-- cancelled         — staff aborted via Cancel button before the
--                     customer completed (Klarna session voided)
-- expired           — Klarna's TTL passed without completion
-- failed            — Klarna rejected the request or the webhook
--                     reported a terminal failure
--
-- ── Idempotency ──────────────────────────────────────────────────
-- idempotency_key on the create-session call (we own this); also
-- used as the dedupe key when the client retries the same gesture.
-- Webhook handler is naturally idempotent — re-applying the same
-- status to a session is a no-op.
--
-- ── Apply order (per CLAUDE.md) ──────────────────────────────────
-- Write → shadow (verify) → Meridian. Schema-only change. The
-- enum widening is additive (extends method check to allow
-- 'klarna'); existing rows are unaffected.

-- ── 1. lng_payments.method now allows 'klarna' ───────────────────
-- Same surgery as the legacy_shopify additions: drop the old check,
-- recreate with the new value present. Existing values stay valid.

alter table public.lng_payments
  drop constraint if exists lng_payments_method_check;
alter table public.lng_payments
  add constraint lng_payments_method_check
  check (method in ('card_terminal', 'cash', 'gift_card', 'account_credit', 'klarna'));

comment on column public.lng_payments.method is
  'Payment medium: card_terminal (S700 tap), cash, gift_card (placeholder), account_credit (placeholder), klarna (native Klarna In-Store API session — see lng_klarna_sessions for the child row).';

-- ── 2. lng_payment_refunds.method now allows 'klarna' ────────────
-- Refunds against Klarna orders go through Klarna's Order
-- Management API rather than Stripe Refunds, so the refund row's
-- method must match the parent payment's method.

alter table public.lng_payment_refunds
  drop constraint if exists lng_payment_refunds_method_check;
alter table public.lng_payment_refunds
  add constraint lng_payment_refunds_method_check
  check (method in ('cash', 'card_terminal', 'gift_card', 'account_credit', 'klarna'));

comment on column public.lng_payment_refunds.method is
  'Refund medium. Must match the parent payment.method (cash → cash, card_terminal → card_terminal, klarna → klarna). The downstream API call (Stripe vs Klarna) is chosen by this field.';

-- ── 3. lng_klarna_sessions ───────────────────────────────────────

create table public.lng_klarna_sessions (
  id                   uuid primary key default gen_random_uuid(),

  -- 1:1 child of the parent payment row. ON DELETE RESTRICT so
  -- a Klarna session can't be orphaned by accident — payment must
  -- come first, refunds come later, and the session sits in between.
  payment_id           uuid not null unique
                          references public.lng_payments(id) on delete restrict,

  -- Denormalised handles so the realtime subscription on the
  -- till's QR modal can filter by visit_id without joining back
  -- through payments → carts every render.
  cart_id              uuid not null references public.lng_carts(id) on delete restrict,
  visit_id             uuid not null references public.lng_visits(id) on delete restrict,

  -- Which Klarna in-store flow we used. one_qr covers dynamic QR
  -- + payment_link (Klarna returns both from the same session).
  -- Future: 'static_qr' for the printed-QR-and-short-code flow.
  flow                 text not null check (flow in ('one_qr')),

  -- Klarna-side identifiers, populated as the flow progresses.
  -- session_id arrives in the create response; order_id arrives
  -- on the COMPLETED webhook. klarna_reference is Klarna's
  -- merchant-facing display ID, also from the webhook.
  klarna_session_id    text unique,
  klarna_order_id      text unique,
  klarna_reference     text,

  amount_pence         int  not null check (amount_pence > 0),
  currency             text not null default 'gbp',

  status               text not null default 'pending'
                          check (status in (
                            'pending',
                            'awaiting_customer',
                            'captured',
                            'cancelled',
                            'expired',
                            'failed'
                          )),

  -- Session-bound random token included in the callback URL we
  -- give Klarna. Klarna doesn't sign webhooks so this is our
  -- spoof-protection: a webhook POST is only honoured when its
  -- query-string token matches the row's stored value. Generated
  -- on insert by the edge function (UUIDv4-shaped). Marked unique
  -- to forbid token reuse across sessions.
  webhook_token        text not null unique,

  -- Klarna's distribution endpoint, polled by the edge function
  -- once to retrieve the QR + payment_link, and again by the
  -- webhook handler as cross-verification on COMPLETED events.
  result_url           text,

  -- What we display on the till. Klarna returns these from the
  -- result_url call.
  qr_code_url          text,
  payment_link_url     text,

  -- Mirrored on the Klarna order line; lets reporting query
  -- "show me every Klarna session for cart X" without going
  -- through Klarna's API.
  merchant_reference1  text not null,

  -- Pinned at insert so retries of the same user gesture dedupe
  -- against the same session row rather than minting a new one.
  idempotency_key      text not null unique,

  -- Raw bodies for audit. Stored even on success because Klarna's
  -- response sometimes carries fields we haven't surfaced as
  -- columns yet and reconciliation needs the verbatim trail.
  raw_create_request   jsonb,
  raw_create_response  jsonb,
  raw_result_response  jsonb,
  raw_last_webhook     jsonb,

  created_at           timestamptz not null default now(),
  expires_at           timestamptz,
  captured_at          timestamptz,
  cancelled_at         timestamptz,
  failed_at            timestamptz,
  updated_at           timestamptz not null default now(),

  taken_by             uuid references public.accounts(id) on delete set null,
  cancelled_by         uuid references public.accounts(id) on delete set null,

  -- The captured + status pair has to move together: if status is
  -- 'captured' we expect a captured_at timestamp and a klarna_order_id,
  -- otherwise both must be null. Catches a half-written webhook
  -- handler from leaving a row in an impossible state.
  constraint lng_klarna_sessions_captured_consistency
    check (
      (status <> 'captured' and captured_at is null and klarna_order_id is null)
      or
      (status = 'captured' and captured_at is not null and klarna_order_id is not null)
    ),
  constraint lng_klarna_sessions_cancelled_consistency
    check (
      (status <> 'cancelled' and cancelled_at is null)
      or
      (status = 'cancelled' and cancelled_at is not null)
    )
);

create index lng_klarna_sessions_visit_idx
  on public.lng_klarna_sessions (visit_id, created_at desc);

create index lng_klarna_sessions_cart_idx
  on public.lng_klarna_sessions (cart_id);

-- Partial index for the till's "any pending session for this
-- visit?" check — keeps the index tiny since the vast majority of
-- rows reach a terminal state quickly.
create index lng_klarna_sessions_open_idx
  on public.lng_klarna_sessions (visit_id, status)
  where status in ('pending', 'awaiting_customer');

create trigger lng_klarna_sessions_touch_updated_at
  before update on public.lng_klarna_sessions
  for each row execute function public.touch_updated_at();

-- ── 4. RLS ───────────────────────────────────────────────────────
-- Same pattern as lng_terminal_payments + lng_payments: admins +
-- Lounge staff can read and write. The webhook handler runs
-- service-role and bypasses RLS, so the policy is purely for
-- in-app reads (the till's QR modal subscribes to a row).

alter table public.lng_klarna_sessions enable row level security;

create policy lng_klarna_sessions_admin_all on public.lng_klarna_sessions
  for all
  using (public.is_admin())
  with check (public.is_admin());

create policy lng_klarna_sessions_staff_all on public.lng_klarna_sessions
  for all
  using (public.auth_is_lng_staff() or public.auth_is_super_admin())
  with check (public.auth_is_lng_staff() or public.auth_is_super_admin());

-- ── 5. Realtime broadcast ────────────────────────────────────────
-- The QR modal subscribes to row updates to flip from "waiting" →
-- "success" the instant the webhook handler captures the order.
-- supabase_realtime is the standard publication.

alter publication supabase_realtime add table public.lng_klarna_sessions;

comment on table public.lng_klarna_sessions is
  '1:1 child of lng_payments for native Klarna In-Store API sessions. Holds Klarna session/order IDs, the QR + payment_link distribution data, and lifecycle status. Webhook updates flow through klarna-webhook edge function; the till QR modal listens on this table via realtime.';

-- ── Rollback ─────────────────────────────────────────────────────
-- alter publication supabase_realtime drop table public.lng_klarna_sessions;
-- drop table if exists public.lng_klarna_sessions;
-- alter table public.lng_payment_refunds
--   drop constraint if exists lng_payment_refunds_method_check;
-- alter table public.lng_payment_refunds
--   add constraint lng_payment_refunds_method_check
--   check (method in ('cash','card_terminal','gift_card','account_credit'));
-- alter table public.lng_payments
--   drop constraint if exists lng_payments_method_check;
-- alter table public.lng_payments
--   add constraint lng_payments_method_check
--   check (method in ('card_terminal','cash','gift_card','account_credit'));
