-- 20260707000001_lng_balance_writeoffs.sql
--
-- Write off an uncollectable outstanding balance on a part-paid sale.
--
-- ── Why this exists ──────────────────────────────────────────────
-- A patient pays a deposit / the first half, then never comes back
-- and never answers the phone to settle the rest (real case:
-- LAP-00568). The visit sits on the in-clinic board forever showing
-- "Part paid · £X due", and there is no clean way to stop chasing
-- the balance while keeping an auditable record of what was forgiven.
--
-- A write-off is NOT a payment and NOT a refund:
--   • It never inserts an lng_payments row, so recorded revenue /
--     takings / cash counts stay honest (those read succeeded
--     payments directly, never this table). The half the patient DID
--     pay is still real money and still counts.
--   • It never issues a refund — no money moves.
--   • It is a reversible marker that says "stop chasing this". If the
--     patient ever comes back, an admin reinstates it and the
--     outstanding balance reappears so staff can take payment.
--
-- ── What a write-off does ────────────────────────────────────────
--   1. Records the forgiven amount (the outstanding at write-off
--      time) in lng_balance_writeoffs, with who / when / why.
--   2. Flips the sale to a distinct 'written_off' paid_status on
--      lng_visit_paid_status (see the view rebuild below) so every
--      "owed / part paid" surface reads it as settled-by-write-off
--      rather than still-owed. amount_paid_pence is untouched (stays
--      real money) — the write-off is a separate written_off_pence
--      column.
--   3. Closes the visit off the in-clinic board: visit → 'complete',
--      cart → 'paid', appointment (if any) → 'complete'. Cart lines
--      are PRESERVED (unlike lng_end_visit_early, which soft-deletes
--      them) so the sale value survives for reporting and for
--      resuscitation. We deliberately close as 'complete', not
--      'ended_early': the resume/reverse flow (lng_reverse_visit_end)
--      only handles unsuitable/ended_early, so 'complete' avoids any
--      collision with it — reinstatement goes through the dedicated
--      RPC below instead.
--
-- ── Permission ───────────────────────────────────────────────────
-- can_write_off on lng_staff_members, plus the super admin, mirrors
-- the can_count_cash / can_view_financials pattern from migration
-- 0019/0020. Acts alone (fully audited, reversible) — no second
-- signer, unlike cash counts.
--
-- ── Apply order (per CLAUDE.md) ──────────────────────────────────
-- Write → shadow (verify) → Meridian. Every operation is additive or
-- CREATE OR REPLACE; no destructive changes. Rollback at the bottom.

-- ── 1. Permission column + helper ────────────────────────────────
alter table public.lng_staff_members
  add column if not exists can_write_off boolean not null default false;

comment on column public.lng_staff_members.can_write_off is
  'Authorises writing off an uncollectable outstanding balance (and reinstating one). Off by default; only the super admin passes automatically. Granted per-manager from Admin → Staff.';

create or replace function public.auth_can_write_off()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.auth_is_super_admin() or exists (
    select 1
      from public.lng_staff_members sm
      join public.accounts a on a.id = sm.account_id
     where a.auth_user_id = auth.uid()
       and sm.status = 'active'
       and sm.can_write_off = true
  );
$$;

revoke all on function public.auth_can_write_off() from public;
grant execute on function public.auth_can_write_off() to authenticated;

comment on function public.auth_can_write_off() is
  'True when the calling auth user may write off / reinstate an outstanding balance: the super admin, or an active staff member with can_write_off = true.';

-- ── 2. lng_balance_writeoffs ──────────────────────────────────────
-- One row per write-off event. Reversible via reinstated_at: an
-- active write-off has reinstated_at IS NULL, a reversed one has it
-- populated with reinstated_by + reinstated_reason. Only one active
-- write-off per cart (partial unique index) — a reinstated one can
-- be superseded by a fresh write-off later.
create table if not exists public.lng_balance_writeoffs (
  id                 uuid primary key default gen_random_uuid(),
  cart_id            uuid not null references public.lng_carts(id) on delete restrict,
  visit_id           uuid not null references public.lng_visits(id) on delete restrict,
  patient_id         uuid not null references public.patients(id) on delete restrict,
  amount_pence       integer not null check (amount_pence > 0),
  reason_category    text not null
                       check (reason_category in ('uncontactable', 'goodwill', 'duplicate', 'other')),
  reason_note        text not null check (length(btrim(reason_note)) > 0),
  written_off_by     uuid references public.accounts(id) on delete set null,
  written_off_at     timestamptz not null default now(),
  reinstated_at      timestamptz null,
  reinstated_by      uuid null references public.accounts(id) on delete set null,
  reinstated_reason  text null,
  created_at         timestamptz not null default now()
);

-- At most one live write-off per cart.
create unique index if not exists lng_balance_writeoffs_one_active_per_cart
  on public.lng_balance_writeoffs (cart_id)
  where reinstated_at is null;

create index if not exists lng_balance_writeoffs_active_idx
  on public.lng_balance_writeoffs (written_off_at desc)
  where reinstated_at is null;

-- reinstated_at / reinstated_by / reinstated_reason move together:
-- a row is either live (all three null) or reinstated (all three set
-- with a non-empty reason). Direct SQL writes that set one without
-- the others are rejected.
alter table public.lng_balance_writeoffs
  add constraint lng_balance_writeoffs_reinstated_pair
  check (
    (reinstated_at is null and reinstated_by is null and reinstated_reason is null)
    or
    (reinstated_at is not null and length(btrim(coalesce(reinstated_reason, ''))) > 0)
  );

alter table public.lng_balance_writeoffs enable row level security;

-- Read: anyone who can write off (so they can see / reinstate their
-- own list) or who can see money (financials / super admin) — these
-- rows describe forgiven revenue.
create policy lng_balance_writeoffs_read on public.lng_balance_writeoffs
  for select to authenticated
  using (public.auth_can_write_off() or public.auth_can_view_financials());

-- Write: only via the SECURITY DEFINER RPCs below, which re-check
-- auth_can_write_off() themselves. Direct table writes are gated to
-- the same permission as a belt-and-braces layer.
create policy lng_balance_writeoffs_write on public.lng_balance_writeoffs
  for all to authenticated
  using (public.auth_can_write_off())
  with check (public.auth_can_write_off());

comment on table public.lng_balance_writeoffs is
  'Audited, reversible write-offs of uncollectable outstanding balances. amount_pence = the outstanding forgiven at write-off time. Never a payment or refund — recorded revenue is unaffected. Live rows (reinstated_at IS NULL) flip the sale to written_off on lng_visit_paid_status; reinstating reopens the balance.';

-- ── 3. Rebuild lng_visit_paid_status to know about write-offs ─────
-- Adds a written_off_pence column (sum of LIVE write-offs on the
-- cart) and a distinct 'written_off' paid_status. amount_paid_pence
-- is unchanged — it stays real collected money, so "Collected £X"
-- displays and revenue reporting are untouched. The 'written_off'
-- branch sits AFTER 'paid' (a fully-paid sale can never read as
-- written off) and BEFORE 'partially_paid' / 'owed' (a live write-off
-- settles the remaining gap). A reinstated write-off drops out of the
-- sum, so the sale reverts to partially_paid / owed automatically.
create or replace view public.lng_visit_paid_status as
select
  v.id  as visit_id,
  c.id  as cart_id,
  c.total_pence as amount_due_pence,
  (
    coalesce((
      select sum(p.amount_pence)
      from public.lng_payments p
      where p.cart_id = c.id and p.status = 'succeeded'
    ), 0)
    - coalesce((
      select sum(r.amount_pence)
      from public.lng_payment_refunds r
      join public.lng_payments p on p.id = r.payment_id
      where p.cart_id = c.id
        and r.status = 'succeeded'
        and p.status = 'succeeded'
    ), 0)
    + greatest(
        0,
        case
          when a.deposit_status = 'paid' then coalesce(a.deposit_pence, 0)
          else 0
        end
        - coalesce((
          select sum(r.amount_pence)
          from public.lng_payment_refunds r
          where r.deposit_appointment_id = a.id and r.status = 'succeeded'
        ), 0)
      )
    + coalesce(a.shopify_order_total_pence, 0)
  )::int as amount_paid_pence,
  case
    when c.total_pence is null or c.total_pence = 0 then 'free_visit'
    when (
      coalesce((
        select sum(p.amount_pence)
        from public.lng_payments p
        where p.cart_id = c.id and p.status = 'succeeded'
      ), 0)
      - coalesce((
        select sum(r.amount_pence)
        from public.lng_payment_refunds r
        join public.lng_payments p on p.id = r.payment_id
        where p.cart_id = c.id
          and r.status = 'succeeded'
          and p.status = 'succeeded'
      ), 0)
      + greatest(
          0,
          case
            when a.deposit_status = 'paid' then coalesce(a.deposit_pence, 0)
            else 0
          end
          - coalesce((
            select sum(r.amount_pence)
            from public.lng_payment_refunds r
            where r.deposit_appointment_id = a.id and r.status = 'succeeded'
          ), 0)
        )
      + coalesce(a.shopify_order_total_pence, 0)
    ) >= c.total_pence
      then 'paid'
    when coalesce((
        select sum(w.amount_pence)
        from public.lng_balance_writeoffs w
        where w.cart_id = c.id and w.reinstated_at is null
      ), 0) > 0
      then 'written_off'
    when (
      coalesce((
        select sum(p.amount_pence)
        from public.lng_payments p
        where p.cart_id = c.id and p.status = 'succeeded'
      ), 0)
      - coalesce((
        select sum(r.amount_pence)
        from public.lng_payment_refunds r
        join public.lng_payments p on p.id = r.payment_id
        where p.cart_id = c.id
          and r.status = 'succeeded'
          and p.status = 'succeeded'
      ), 0)
      + greatest(
          0,
          case
            when a.deposit_status = 'paid' then coalesce(a.deposit_pence, 0)
            else 0
          end
          - coalesce((
            select sum(r.amount_pence)
            from public.lng_payment_refunds r
            where r.deposit_appointment_id = a.id and r.status = 'succeeded'
          ), 0)
        )
      + coalesce(a.shopify_order_total_pence, 0)
    ) > 0
      then 'partially_paid'
    else 'owed'
  end as paid_status,
  coalesce((
    select sum(w.amount_pence)
    from public.lng_balance_writeoffs w
    where w.cart_id = c.id and w.reinstated_at is null
  ), 0)::int as written_off_pence
from public.lng_visits v
left join public.lng_carts        c on c.visit_id = v.id
left join public.lng_appointments a on a.id = v.appointment_id;

comment on view public.lng_visit_paid_status is
  'Derived paid status per visit. amount_paid_pence = succeeded lng_payments (less their refunds, both sides constrained to status=succeeded so fully-refunded payments drop cleanly) + paid deposit (less its refunds, clamped at 0) + linked Shopify-order credit. written_off_pence = sum of live lng_balance_writeoffs on the cart. paid_status is written_off when a live write-off settles the remaining balance (sits between paid and partially_paid). Recomputed on read.';

-- ── 4. RPC: lng_write_off_balance ────────────────────────────────
-- Atomic: record the write-off, flip the sale to settled-by-write-off,
-- close the visit off the board. Gated on auth_can_write_off() (the
-- RPC is SECURITY DEFINER so it bypasses RLS — it must re-check the
-- permission itself). Raises loudly on every impossible state rather
-- than silently no-op.
create or replace function public.lng_write_off_balance(
  p_cart_id          uuid,
  p_reason_category  text,
  p_note             text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id     uuid;
  v_trimmed_note   text;
  v_visit_id       uuid;
  v_patient_id     uuid;
  v_appointment_id uuid;
  v_visit_status   text;
  v_cart_status    text;
  v_total          int;
  v_paid           int;
  v_outstanding    int;
  v_writeoff_id    uuid;
begin
  if not public.auth_can_write_off() then
    raise exception 'Not authorised to write off a balance' using errcode = '42501';
  end if;

  v_account_id   := public.auth_account_id();
  v_trimmed_note := nullif(btrim(coalesce(p_note, '')), '');

  if p_reason_category not in ('uncontactable', 'goodwill', 'duplicate', 'other') then
    raise exception 'Invalid write-off reason: %', p_reason_category using errcode = '22023';
  end if;
  if v_trimmed_note is null then
    raise exception 'A reason note is required to write off a balance' using errcode = '22023';
  end if;

  -- Lock the cart + visit for the transaction.
  select c.status, c.total_pence, c.visit_id
    into v_cart_status, v_total, v_visit_id
    from public.lng_carts c
   where c.id = p_cart_id
   for update;
  if not found then
    raise exception 'Cart % not found', p_cart_id using errcode = 'P0002';
  end if;
  if v_cart_status <> 'open' then
    raise exception 'Cart % is % — only open carts can be written off', p_cart_id, v_cart_status
      using errcode = '22023';
  end if;

  select v.status, v.patient_id, v.appointment_id
    into v_visit_status, v_patient_id, v_appointment_id
    from public.lng_visits v
   where v.id = v_visit_id
   for update;
  if v_visit_status <> 'arrived' then
    raise exception 'Visit % is in status % — can only write off an active (arrived) visit', v_visit_id, v_visit_status
      using errcode = '22023';
  end if;

  -- Outstanding = cart total less real money already on file. Read
  -- the canonical view so deposit + Shopify + succeeded payments are
  -- all netted the same way every other surface nets them.
  select coalesce(vps.amount_paid_pence, 0)
    into v_paid
    from public.lng_visit_paid_status vps
   where vps.visit_id = v_visit_id;

  v_outstanding := coalesce(v_total, 0) - coalesce(v_paid, 0);
  if v_outstanding <= 0 then
    raise exception 'Nothing outstanding to write off on cart % (total %, paid %)', p_cart_id, v_total, v_paid
      using errcode = '22023';
  end if;

  -- Record the write-off. The partial unique index rejects a second
  -- live write-off on the same cart.
  insert into public.lng_balance_writeoffs
    (cart_id, visit_id, patient_id, amount_pence, reason_category, reason_note, written_off_by)
  values
    (p_cart_id, v_visit_id, v_patient_id, v_outstanding, p_reason_category, v_trimmed_note, v_account_id)
  returning id into v_writeoff_id;

  -- Settle + close. Cart lines are preserved (no soft-delete) so the
  -- sale value survives. fulfilment_method stays NULL — this is a
  -- write-off close, not a normal in-person / shipping fulfilment,
  -- and NULL keeps it off the shipping-dispatch branch of the board.
  update public.lng_carts
     set status = 'paid', closed_at = now()
   where id = p_cart_id;

  update public.lng_visits
     set status = 'complete', closed_at = now()
   where id = v_visit_id;

  -- Mirror completeVisit: an appointment-origin visit flips the
  -- appointment to complete too. Walk-ins carry no status of their
  -- own (lifecycle lives on the visit).
  if v_appointment_id is not null then
    update public.lng_appointments
       set status = 'complete'
     where id = v_appointment_id;
  end if;

  insert into public.patient_events
    (patient_id, event_type, actor_account_id, notes, payload)
  values
    (v_patient_id, 'balance_written_off', v_account_id, v_trimmed_note,
     jsonb_build_object(
       'visit_id',         v_visit_id,
       'cart_id',          p_cart_id,
       'writeoff_id',      v_writeoff_id,
       'amount_pence',     v_outstanding,
       'reason_category',  p_reason_category,
       'note',             v_trimmed_note,
       'staff_account_id', v_account_id
     ));

  return v_writeoff_id;
end;
$$;

revoke all on function public.lng_write_off_balance(uuid, text, text) from public;
grant execute on function public.lng_write_off_balance(uuid, text, text) to authenticated;

comment on function public.lng_write_off_balance(uuid, text, text) is
  'Write off the outstanding balance on an open, arrived visit''s cart. Records the forgiven amount in lng_balance_writeoffs, flips cart→paid and visit→complete (appointment→complete), preserving cart lines. Never touches payments/refunds. Gated on auth_can_write_off(). Returns the write-off id.';

-- ── 5. RPC: lng_reinstate_written_off_balance ────────────────────
-- Reverse of the above: mark the live write-off reinstated and reopen
-- the sale so staff can take the balance if the patient comes back.
create or replace function public.lng_reinstate_written_off_balance(
  p_cart_id  uuid,
  p_note     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id     uuid;
  v_trimmed_note   text;
  v_writeoff_id    uuid;
  v_visit_id       uuid;
  v_patient_id     uuid;
  v_appointment_id uuid;
  v_amount         int;
begin
  if not public.auth_can_write_off() then
    raise exception 'Not authorised to reinstate a written-off balance' using errcode = '42501';
  end if;

  v_account_id   := public.auth_account_id();
  v_trimmed_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_trimmed_note is null then
    raise exception 'A reason is required to reinstate a written-off balance' using errcode = '22023';
  end if;

  -- Find the live write-off on this cart and lock it.
  select w.id, w.visit_id, w.patient_id, w.amount_pence
    into v_writeoff_id, v_visit_id, v_patient_id, v_amount
    from public.lng_balance_writeoffs w
   where w.cart_id = p_cart_id
     and w.reinstated_at is null
   for update;
  if not found then
    raise exception 'No live write-off on cart %', p_cart_id using errcode = 'P0002';
  end if;

  select v.appointment_id into v_appointment_id
    from public.lng_visits v where v.id = v_visit_id for update;

  update public.lng_balance_writeoffs
     set reinstated_at     = now(),
         reinstated_by     = v_account_id,
         reinstated_reason = v_trimmed_note
   where id = v_writeoff_id;

  -- Reopen the sale. Back on the board (visit arrived), cart editable
  -- / collectable again (open). Cart lines were never removed.
  update public.lng_carts
     set status = 'open', closed_at = null
   where id = p_cart_id;

  update public.lng_visits
     set status = 'arrived', closed_at = null
   where id = v_visit_id;

  if v_appointment_id is not null then
    update public.lng_appointments
       set status = 'arrived'
     where id = v_appointment_id;
  end if;

  insert into public.patient_events
    (patient_id, event_type, actor_account_id, notes, payload)
  values
    (v_patient_id, 'balance_writeoff_reinstated', v_account_id, v_trimmed_note,
     jsonb_build_object(
       'visit_id',         v_visit_id,
       'cart_id',          p_cart_id,
       'writeoff_id',      v_writeoff_id,
       'amount_pence',     v_amount,
       'note',             v_trimmed_note,
       'staff_account_id', v_account_id
     ));
end;
$$;

revoke all on function public.lng_reinstate_written_off_balance(uuid, text) from public;
grant execute on function public.lng_reinstate_written_off_balance(uuid, text) to authenticated;

comment on function public.lng_reinstate_written_off_balance(uuid, text) is
  'Reverse a write-off: mark the live lng_balance_writeoffs row reinstated, reopen cart→open and visit→arrived (appointment→arrived) so the balance can be collected. Gated on auth_can_write_off().';

NOTIFY pgrst, 'reload schema';

-- ── Rollback ─────────────────────────────────────────────────────
-- drop function if exists public.lng_reinstate_written_off_balance(uuid, text);
-- drop function if exists public.lng_write_off_balance(uuid, text, text);
-- -- Restore the prior view (see 20260519000010_lng_visit_paid_status_refund_status_match.sql
-- -- for the exact body without written_off_pence / the written_off branch).
-- drop table if exists public.lng_balance_writeoffs;
-- drop function if exists public.auth_can_write_off();
-- alter table public.lng_staff_members drop column if exists can_write_off;
