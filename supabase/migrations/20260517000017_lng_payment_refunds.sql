-- lng_payment_refunds — per-payment refund ledger.
--
-- Today voidPayment flips a whole lng_payments row to status='cancelled'
-- in one shot. That works when staff is reversing the entire capture
-- (e.g. customer wants a do-over on the same visit) but it can't model:
--
--   • Partial refund — the customer paid £200, an item worth £30 was
--     removed from the cart, and we owe them £30 back. The payment
--     remains succeeded for £170 net; the £30 lives here.
--   • Multi-refund — staff refunds £30 today, the visit gets cancelled
--     next week and the remaining £170 needs to come back too. Each
--     event is its own row, summed against the parent payment to
--     compute "still refundable".
--
-- Status semantics:
--   pending    — Stripe API call is in flight (terminal-refund edge fn
--                inserts the row before calling Stripe so a crash mid-
--                flight is still visible in audit).
--   succeeded  — Stripe returned succeeded OR cash was handed back
--                (cash refunds are 'succeeded' at insert time — there's
--                no async settlement).
--   failed     — Stripe returned a non-succeeded status or the API
--                call errored. The patient still owes us nothing extra
--                because we already took the money; staff retries.
--
-- payment_id is the only required FK — visit_id / appointment_id are
-- captured for query convenience but the source of truth lives on the
-- payment. cart_id is derived through payment_id when we need it.

create table public.lng_payment_refunds (
  id                       uuid primary key default gen_random_uuid(),
  payment_id               uuid not null references public.lng_payments(id) on delete restrict,
  amount_pence             int  not null check (amount_pence > 0),
  currency                 text not null default 'gbp',
  method                   text not null
                              check (method in ('cash', 'card_terminal', 'gift_card', 'account_credit')),
  -- Stripe Refund id (re_...). Only populated when method=card_terminal
  -- and the refund went through Stripe's /refunds endpoint. Null for
  -- cash refunds — there's no third party to settle with.
  stripe_refund_id         text unique,
  status                   text not null default 'pending'
                              check (status in ('pending', 'succeeded', 'failed')),
  failure_reason           text,
  -- Structured reason — drives the timeline filter + reports. The free
  -- text reason_note alongside captures the specifics ('cracked
  -- whitening tray, refunded the upgrade item').
  reason_category          text not null
                              check (reason_category in (
                                'item_removed',
                                'visit_cancelled',
                                'visit_ended_early',
                                'service_not_delivered',
                                'patient_request',
                                'cart_correction',
                                'other'
                              )),
  reason_note              text not null,
  performed_by_account_id  uuid not null references public.accounts(id),
  approver_account_id      uuid not null references public.accounts(id),
  visit_id                 uuid references public.lng_visits(id) on delete set null,
  appointment_id           uuid references public.lng_appointments(id) on delete set null,
  refunded_at              timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- Two-staff guard: performer and approver must differ. Reuses the
  -- same convention as the existing void flow.
  constraint lng_payment_refunds_two_staff_check
    check (performed_by_account_id <> approver_account_id),
  -- Refund text isn't optional — the timeline needs a specific reason
  -- on every row.
  constraint lng_payment_refunds_reason_note_nonempty_check
    check (length(trim(reason_note)) > 0)
);

create index lng_payment_refunds_payment_idx     on public.lng_payment_refunds (payment_id);
create index lng_payment_refunds_visit_idx       on public.lng_payment_refunds (visit_id);
create index lng_payment_refunds_appointment_idx on public.lng_payment_refunds (appointment_id);
create index lng_payment_refunds_refunded_at_idx on public.lng_payment_refunds (refunded_at desc);
create index lng_payment_refunds_status_idx      on public.lng_payment_refunds (status);

create trigger lng_payment_refunds_set_updated_at
  before update on public.lng_payment_refunds
  for each row execute function public.touch_updated_at();

comment on table public.lng_payment_refunds is
  'Per-payment partial-refund ledger. Each row records one refund event against an lng_payments capture. Sum(amount_pence WHERE status=succeeded) per payment_id = total refunded; payment.amount_pence - that sum = net cash on the books from that payment. visit_id / appointment_id are denormalised query handles; the truth lives on payment_id.';

-- RLS — mirrors lng_payments. Admins do anything; receptionists at
-- the visit's location can SELECT. Inserts + updates run through
-- edge functions on the service role (terminal-refund), so no
-- receptionist-INSERT policy by design — same shape lng_payments
-- already uses.
alter table public.lng_payment_refunds enable row level security;

create policy lng_payment_refunds_admin_all
  on public.lng_payment_refunds for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy lng_payment_refunds_receptionist_select
  on public.lng_payment_refunds for select
  to authenticated
  using (
    public.auth_is_receptionist()
    and payment_id in (
      select p.id from public.lng_payments p
        join public.lng_carts c on c.id = p.cart_id
        join public.lng_visits v on v.id = c.visit_id
       where v.location_id = public.auth_location_id()
    )
  );
