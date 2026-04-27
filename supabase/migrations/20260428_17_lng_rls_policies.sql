-- 20260428_17_lng_rls_policies.sql
-- Row-level security for every lng_* table.
--
-- Visibility model:
--   admin       full access (is_admin())
--   receptionist  scoped to their location_id (auth_is_receptionist() AND location_id = auth_location_id())
--   anyone else  no access
--
-- Tables without a direct location_id (carts, cart_items, payments, terminal_payments,
-- receipts) inherit visibility through their parent visit.
--
-- DELETE policies are intentionally absent — Lounge is append-only on patient-axis data.
-- Status flips via UPDATE, never DELETE.
--
-- Rollback: ALTER TABLE … DISABLE ROW LEVEL SECURITY; DROP POLICY … ;

-- Helper macro patterns inlined per table for clarity.

-- ---------- lng_settings ----------
alter table public.lng_settings enable row level security;

create policy lng_settings_admin_all
  on public.lng_settings for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy lng_settings_receptionist_select
  on public.lng_settings for select
  to authenticated
  using (
    public.auth_is_receptionist()
    and (location_id is null or location_id = public.auth_location_id())
  );

-- ---------- lng_terminal_readers ----------
alter table public.lng_terminal_readers enable row level security;

create policy lng_terminal_readers_admin_all
  on public.lng_terminal_readers for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy lng_terminal_readers_receptionist_select
  on public.lng_terminal_readers for select
  to authenticated
  using (public.auth_is_receptionist() and location_id = public.auth_location_id());

-- ---------- lng_terminal_sessions (read-only for receptionist) ----------
alter table public.lng_terminal_sessions enable row level security;

create policy lng_terminal_sessions_admin_all
  on public.lng_terminal_sessions for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy lng_terminal_sessions_receptionist_select
  on public.lng_terminal_sessions for select
  to authenticated
  using (
    public.auth_is_receptionist()
    and reader_id in (
      select id from public.lng_terminal_readers where location_id = public.auth_location_id()
    )
  );

-- ---------- lng_appointments ----------
alter table public.lng_appointments enable row level security;

create policy lng_appointments_admin_all
  on public.lng_appointments for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy lng_appointments_receptionist_select
  on public.lng_appointments for select
  to authenticated
  using (public.auth_is_receptionist() and location_id = public.auth_location_id());

create policy lng_appointments_receptionist_insert
  on public.lng_appointments for insert
  to authenticated
  with check (public.auth_is_receptionist() and location_id = public.auth_location_id());

create policy lng_appointments_receptionist_update
  on public.lng_appointments for update
  to authenticated
  using (public.auth_is_receptionist() and location_id = public.auth_location_id())
  with check (public.auth_is_receptionist() and location_id = public.auth_location_id());

-- ---------- lng_walk_ins ----------
alter table public.lng_walk_ins enable row level security;

create policy lng_walk_ins_admin_all
  on public.lng_walk_ins for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy lng_walk_ins_receptionist_select
  on public.lng_walk_ins for select
  to authenticated
  using (public.auth_is_receptionist() and location_id = public.auth_location_id());

create policy lng_walk_ins_receptionist_insert
  on public.lng_walk_ins for insert
  to authenticated
  with check (public.auth_is_receptionist() and location_id = public.auth_location_id());

create policy lng_walk_ins_receptionist_update
  on public.lng_walk_ins for update
  to authenticated
  using (public.auth_is_receptionist() and location_id = public.auth_location_id())
  with check (public.auth_is_receptionist() and location_id = public.auth_location_id());

-- ---------- lng_visits ----------
alter table public.lng_visits enable row level security;

create policy lng_visits_admin_all
  on public.lng_visits for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy lng_visits_receptionist_select
  on public.lng_visits for select
  to authenticated
  using (public.auth_is_receptionist() and location_id = public.auth_location_id());

create policy lng_visits_receptionist_insert
  on public.lng_visits for insert
  to authenticated
  with check (public.auth_is_receptionist() and location_id = public.auth_location_id());

create policy lng_visits_receptionist_update
  on public.lng_visits for update
  to authenticated
  using (public.auth_is_receptionist() and location_id = public.auth_location_id())
  with check (public.auth_is_receptionist() and location_id = public.auth_location_id());

-- ---------- lng_calendly_bookings (writes via service-role only) ----------
alter table public.lng_calendly_bookings enable row level security;

create policy lng_calendly_bookings_admin_select
  on public.lng_calendly_bookings for select
  to authenticated
  using (public.is_admin());

-- No insert/update policy for end-users; only service-role (used by the
-- calendly-webhook edge function) can write.

-- ---------- lng_carts ----------
alter table public.lng_carts enable row level security;

create policy lng_carts_admin_all
  on public.lng_carts for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy lng_carts_receptionist_select
  on public.lng_carts for select
  to authenticated
  using (
    public.auth_is_receptionist()
    and visit_id in (select id from public.lng_visits where location_id = public.auth_location_id())
  );

create policy lng_carts_receptionist_insert
  on public.lng_carts for insert
  to authenticated
  with check (
    public.auth_is_receptionist()
    and visit_id in (select id from public.lng_visits where location_id = public.auth_location_id())
  );

create policy lng_carts_receptionist_update
  on public.lng_carts for update
  to authenticated
  using (
    public.auth_is_receptionist()
    and visit_id in (select id from public.lng_visits where location_id = public.auth_location_id())
  )
  with check (
    public.auth_is_receptionist()
    and visit_id in (select id from public.lng_visits where location_id = public.auth_location_id())
  );

-- ---------- lng_cart_items ----------
alter table public.lng_cart_items enable row level security;

create policy lng_cart_items_admin_all
  on public.lng_cart_items for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy lng_cart_items_receptionist_all
  on public.lng_cart_items for all
  to authenticated
  using (
    public.auth_is_receptionist()
    and cart_id in (
      select c.id from public.lng_carts c
        join public.lng_visits v on v.id = c.visit_id
       where v.location_id = public.auth_location_id()
    )
  )
  with check (
    public.auth_is_receptionist()
    and cart_id in (
      select c.id from public.lng_carts c
        join public.lng_visits v on v.id = c.visit_id
       where v.location_id = public.auth_location_id()
    )
  );

-- ---------- lng_payments ----------
alter table public.lng_payments enable row level security;

create policy lng_payments_admin_all
  on public.lng_payments for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy lng_payments_receptionist_select
  on public.lng_payments for select
  to authenticated
  using (
    public.auth_is_receptionist()
    and cart_id in (
      select c.id from public.lng_carts c
        join public.lng_visits v on v.id = c.visit_id
       where v.location_id = public.auth_location_id()
    )
  );

-- Inserts and updates to lng_payments happen only via edge functions
-- (terminal-start-payment, cash payment recorder) using service-role.

-- ---------- lng_terminal_payments (service-role writes only) ----------
alter table public.lng_terminal_payments enable row level security;

create policy lng_terminal_payments_admin_select
  on public.lng_terminal_payments for select
  to authenticated
  using (public.is_admin());

create policy lng_terminal_payments_receptionist_select
  on public.lng_terminal_payments for select
  to authenticated
  using (
    public.auth_is_receptionist()
    and payment_id in (
      select p.id from public.lng_payments p
        join public.lng_carts c   on c.id = p.cart_id
        join public.lng_visits v  on v.id = c.visit_id
       where v.location_id = public.auth_location_id()
    )
  );

-- ---------- lng_receipts (service-role writes only) ----------
alter table public.lng_receipts enable row level security;

create policy lng_receipts_admin_select
  on public.lng_receipts for select
  to authenticated
  using (public.is_admin());

create policy lng_receipts_receptionist_select
  on public.lng_receipts for select
  to authenticated
  using (
    public.auth_is_receptionist()
    and payment_id in (
      select p.id from public.lng_payments p
        join public.lng_carts c   on c.id = p.cart_id
        join public.lng_visits v  on v.id = c.visit_id
       where v.location_id = public.auth_location_id()
    )
  );

-- ---------- lng_event_log (service-role writes; admin reads) ----------
alter table public.lng_event_log enable row level security;

create policy lng_event_log_admin_select
  on public.lng_event_log for select
  to authenticated
  using (public.is_admin());

create policy lng_event_log_receptionist_self_insert
  on public.lng_event_log for insert
  to authenticated
  with check (public.auth_is_receptionist() and account_id = public.auth_account_id());

-- ---------- lng_system_failures (writes from anywhere; admin-only reads) ----------
alter table public.lng_system_failures enable row level security;

create policy lng_system_failures_admin_select
  on public.lng_system_failures for select
  to authenticated
  using (public.is_admin());

create policy lng_system_failures_admin_update
  on public.lng_system_failures for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Allow ANY authenticated user to insert a failure (so client-side logFailure works
-- without service-role). The row's user_id and location_id columns can be nulled if
-- the caller is not in scope.
create policy lng_system_failures_authenticated_insert
  on public.lng_system_failures for insert
  to authenticated
  with check (true);

-- ---------- lng_receptionist_sessions ----------
alter table public.lng_receptionist_sessions enable row level security;

create policy lng_receptionist_sessions_admin_all
  on public.lng_receptionist_sessions for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy lng_receptionist_sessions_self_select
  on public.lng_receptionist_sessions for select
  to authenticated
  using (account_id = public.auth_account_id());

create policy lng_receptionist_sessions_self_update
  on public.lng_receptionist_sessions for update
  to authenticated
  using (account_id = public.auth_account_id())
  with check (account_id = public.auth_account_id());
