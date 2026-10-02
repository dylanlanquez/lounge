-- 20261002_01_lng_appointment_shopify_order_links.sql
--
-- Reference links between an appointment and one or more Shopify orders.
--
-- Background. lng_appointments already carries a SINGLE shopify_order_*
-- block (id, name, total_pence, currency, linked_at, linked_by). Those
-- columns mean one specific thing: "the customer paid this online and
-- the amount CREDITS against the in-clinic bill at checkout". That is
-- why the booking sheet only offers them on same_day_appliance /
-- click_in_veneers (see NewBookingSheet.isShopifyService) — attaching a
-- credit to a service with no bill was a real bug.
--
-- This table is deliberately NOT that. A row here is a reference link:
-- "this call is about these orders". It never credits a cart, never
-- reaches Pay.tsx, reports, the manage page or emails. Voice calls are
-- the first (and today only) consumer: the receptionist picks which of
-- the patient's orders the call concerns so whoever takes the call has
-- the context in front of them.
--
-- Multiple orders per appointment, zero orders is the normal case.
-- Snapshot name/total/currency at link time so a later Shopify change
-- (or a staff member without shopify_orders RLS) still renders the row.
--
-- Audit: link/unlink write patient_events rows
-- (appointment_shopify_order_linked / _unlinked), which the appointment
-- timeline renders. The row itself also carries linked_at + linked_by.
-- Unlink is a hard delete; the patient_events trail is the history.
--
-- Rollback: DROP TABLE public.lng_appointment_shopify_order_links.

create table if not exists public.lng_appointment_shopify_order_links (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null
    references public.lng_appointments(id) on delete cascade,
  -- shopify_orders.id as text. No FK: shopify_orders is Meridian's
  -- replicated table, admin-RLS'd, and absent on the shadow project.
  shopify_order_id text not null,
  -- Snapshots, frozen at link time.
  shopify_order_name text not null,
  total_price_pence integer check (total_price_pence is null or total_price_pence >= 0),
  currency text,
  linked_at timestamptz not null default now(),
  linked_by_account_id uuid references public.accounts(id),
  unique (appointment_id, shopify_order_id)
);

create index if not exists lng_appointment_shopify_order_links_appointment_idx
  on public.lng_appointment_shopify_order_links(appointment_id);

comment on table public.lng_appointment_shopify_order_links is
  'Reference links from an appointment to the Shopify orders it concerns. Many per appointment, optional. NOT a payment credit: lng_appointments.shopify_order_* remains the single credited order for same-day services. Name/total/currency snapshotted at link time. Link and unlink are audited via patient_events.';

-- RLS: same posture as lng_appointment_items — authenticated staff get
-- full access, service-role bypasses. The customer widget never reads
-- or writes this table.
alter table public.lng_appointment_shopify_order_links enable row level security;

create policy lng_appointment_shopify_order_links_staff
  on public.lng_appointment_shopify_order_links
  for all
  to authenticated
  using (true)
  with check (true);
