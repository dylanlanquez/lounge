-- 20260908000001_lng_customer_service_order_read.sql
--
-- Lets Customer Service agents read Lounge orders from Checkpoint.
--
-- Why: a walk-in pays in Lounge, then contacts CS about a problem. CS
-- works in Checkpoint, which runs on its own Supabase project, so the
-- order was invisible to them. Checkpoint already holds a client
-- pointed at this project (src/lib/loungeSupabase.js, in production for
-- the appointment booker) and CS agents already have Lounge logins, so
-- the fix is a real authenticated session plus policies for the role,
-- not a service-role bridge or a wider anon grant.
--
-- See docs/slices/lounge-orders-in-checkpoint.md.
--
-- What this does NOT do:
--   • No anon grant. The anon key ships in the public booking embed on
--     venneir.com and denture-services.co.uk, so an anon SELECT on
--     these tables would publish every customer's payment record, card
--     last-4 and refund history to anyone who views source.
--   • No write access. SELECT only, on every table below. Refunds,
--     voids and cart edits stay in Lounge where the Stripe keys and the
--     approval ceiling triggers live.
--   • No change to the existing admin or receptionist policies.
--
-- Cross-location by design: CS serves every clinic, so these policies
-- carry no auth_location_id() filter. That is exactly why the
-- receptionist policies (20260428000017) could not be reused.
--
-- Rollback at the bottom of this file.

begin;

-- ─────────────────────────────────────────────────────────────────────
-- 1. Role predicate
-- ─────────────────────────────────────────────────────────────────────
--
-- Mirrors auth_is_receptionist() (20260428000004) but resolves through
-- lng_staff_members, which is the Lounge-side staff registry: existence
-- of an active row means "this account works at Lounge". A
-- Meridian-only account (CAD, lab team, dental practices) has no row
-- and therefore no access.
--
-- status = 'active' is evaluated per query, so deactivating a CS agent
-- in Lounge takes effect on their next read rather than waiting for
-- their session token to expire.

create or replace function public.auth_is_customer_service()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from public.lng_staff_members sm
      join public.accounts a on a.id = sm.account_id
     where a.auth_user_id = auth.uid()
       and sm.is_customer_service = true
       and sm.status = 'active'
  );
$$;

comment on function public.auth_is_customer_service() is
  'True if the current user has an active lng_staff_members row with is_customer_service. Used in RLS for cross-location CS order reads.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. MFA predicate
-- ─────────────────────────────────────────────────────────────────────
--
-- Lounge enforces 2FA in the client only: src/App.tsx:174 blocks the UI
-- when lng_staff_members.require_2fa is true and the session is not
-- aal2. RLS never looked at AAL. Left alone, a password-only sign-in
-- from Checkpoint would hold a session that Lounge's own interface
-- refuses, while these policies served it card and refund data.
--
-- This helper reproduces Lounge's gate at the data layer, where it
-- cannot be bypassed by calling PostgREST directly.
--
-- Deliberately NOT an unconditional aal2 requirement: require_2fa
-- defaults to false, so demanding aal2 from everyone would lock out
-- every CS account that has not enrolled. The bar here is therefore
-- the same one Lounge applies to that same account, no weaker and no
-- stronger.
--
-- Operational note: turning require_2fa on for CS accounts is worth
-- doing, since these policies expose payment data across every
-- location. That is an access decision for the clinic, not something
-- this migration imposes.

create or replace function public.auth_lng_mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from public.lng_staff_members sm
      join public.accounts a on a.id = sm.account_id
     where a.auth_user_id = auth.uid()
       and sm.status = 'active'
       and (
         sm.require_2fa = false
         or (auth.jwt() ->> 'aal') = 'aal2'
       )
  );
$$;

comment on function public.auth_lng_mfa_satisfied() is
  'True when the current Lounge staff session meets that account''s own 2FA requirement: either require_2fa is false, or the session is aal2. Mirrors the client-side gate in App.tsx at the data layer.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. CS read policies
-- ─────────────────────────────────────────────────────────────────────
--
-- One SELECT policy per table in the order chain. No row filter beyond
-- the role and MFA predicates: CS is cross-location and reads whole
-- orders, so a per-row scope would only add cost without adding
-- protection.
--
-- Policies are additive in Postgres, so these sit alongside the
-- existing admin and receptionist policies without altering them. An
-- admin who is also flagged CS keeps admin access through the admin
-- policy.

-- Visit spine
create policy lng_visits_cs_select
  on public.lng_visits for select
  to authenticated
  using (public.auth_is_customer_service() and public.auth_lng_mfa_satisfied());

create policy lng_walk_ins_cs_select
  on public.lng_walk_ins for select
  to authenticated
  using (public.auth_is_customer_service() and public.auth_lng_mfa_satisfied());

create policy lng_appointments_cs_select
  on public.lng_appointments for select
  to authenticated
  using (public.auth_is_customer_service() and public.auth_lng_mfa_satisfied());

-- Cart
create policy lng_carts_cs_select
  on public.lng_carts for select
  to authenticated
  using (public.auth_is_customer_service() and public.auth_lng_mfa_satisfied());

create policy lng_cart_items_cs_select
  on public.lng_cart_items for select
  to authenticated
  using (public.auth_is_customer_service() and public.auth_lng_mfa_satisfied());

create policy lng_cart_item_upgrades_cs_select
  on public.lng_cart_item_upgrades for select
  to authenticated
  using (public.auth_is_customer_service() and public.auth_lng_mfa_satisfied());

create policy lng_cart_discounts_cs_select
  on public.lng_cart_discounts for select
  to authenticated
  using (public.auth_is_customer_service() and public.auth_lng_mfa_satisfied());

-- Money
create policy lng_payments_cs_select
  on public.lng_payments for select
  to authenticated
  using (public.auth_is_customer_service() and public.auth_lng_mfa_satisfied());

create policy lng_payment_refunds_cs_select
  on public.lng_payment_refunds for select
  to authenticated
  using (public.auth_is_customer_service() and public.auth_lng_mfa_satisfied());

-- ─────────────────────────────────────────────────────────────────────
-- 4. Access audit
-- ─────────────────────────────────────────────────────────────────────
--
-- Every order view from Checkpoint writes a patient_events row so a
-- DSAR can answer who looked at the record and when. patient_events is
-- the right home because this is a patient-axis event, per CLAUDE.md;
-- lng_event_log is for Lounge-internal events.
--
-- patient_events SELECT is already open to any active Lounge account
-- (20260518000013). INSERT was locked to the service-role bypass, and
-- this slice removed the edge function that would have carried it, so
-- the client needs a narrow INSERT policy of its own.
--
-- Scoped to the one event_type. A client holding a CS session can
-- forge rows OF THAT TYPE, which is an accepted limitation for an
-- access log written by the reader: it can add noise, but it cannot
-- suppress a genuine read (that row is written on the same path) and
-- it cannot touch any other event type or any other table. The
-- alternative, an edge function purely to write one audit row,
-- reintroduces the service-role hop this design deliberately removed.

create policy patient_events_cs_order_view_insert
  on public.patient_events for insert
  to authenticated
  with check (
    public.auth_is_customer_service()
    and public.auth_lng_mfa_satisfied()
    and event_type = 'order_viewed_checkpoint'
  );

commit;

-- ─────────────────────────────────────────────────────────────────────
-- Rollback
-- ─────────────────────────────────────────────────────────────────────
--
-- begin;
-- drop policy if exists patient_events_cs_order_view_insert on public.patient_events;
-- drop policy if exists lng_payment_refunds_cs_select      on public.lng_payment_refunds;
-- drop policy if exists lng_payments_cs_select             on public.lng_payments;
-- drop policy if exists lng_cart_discounts_cs_select       on public.lng_cart_discounts;
-- drop policy if exists lng_cart_item_upgrades_cs_select   on public.lng_cart_item_upgrades;
-- drop policy if exists lng_cart_items_cs_select           on public.lng_cart_items;
-- drop policy if exists lng_carts_cs_select                on public.lng_carts;
-- drop policy if exists lng_appointments_cs_select         on public.lng_appointments;
-- drop policy if exists lng_walk_ins_cs_select             on public.lng_walk_ins;
-- drop policy if exists lng_visits_cs_select               on public.lng_visits;
-- drop function if exists public.auth_lng_mfa_satisfied();
-- drop function if exists public.auth_is_customer_service();
-- commit;
