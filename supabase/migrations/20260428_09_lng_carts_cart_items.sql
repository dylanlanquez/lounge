-- 20260428_09_lng_carts_cart_items.sql
-- EPOS cart and line-item tables. One cart per visit (UNIQUE on visit_id).
-- total_pence is GENERATED — never set by callers; never drift.
-- line_total_pence is GENERATED — same rule.
--
-- Per brief §5.4 ("three roles, no overlap").
--
-- Rollback: DROP TABLE lng_cart_items, lng_carts;

create table public.lng_carts (
  id               uuid primary key default gen_random_uuid(),
  visit_id         uuid not null unique references public.lng_visits(id) on delete restrict,
  status           text not null default 'open'
                       check (status in ('open', 'paid', 'voided')),
  subtotal_pence   int  not null default 0  check (subtotal_pence >= 0),
  discount_pence   int  not null default 0  check (discount_pence >= 0),
  tax_pence        int  not null default 0  check (tax_pence >= 0),
  total_pence      int  generated always as (subtotal_pence - discount_pence + tax_pence) stored,
  opened_at        timestamptz not null default now(),
  closed_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index lng_carts_status_idx on public.lng_carts (status);

create trigger lng_carts_set_updated_at
  before update on public.lng_carts
  for each row execute function public.touch_updated_at();

create table public.lng_cart_items (
  id                  uuid primary key default gen_random_uuid(),
  cart_id             uuid not null references public.lng_carts(id) on delete cascade,
  sku                 text,
  name                text not null,
  description         text,
  quantity            int  not null check (quantity > 0),
  unit_price_pence    int  not null check (unit_price_pence >= 0),
  discount_pence      int  not null default 0 check (discount_pence >= 0),
  line_total_pence    int  generated always as (unit_price_pence * quantity - discount_pence) stored,
  sort_order          int  not null default 0,
  created_at          timestamptz not null default now()
);

create index lng_cart_items_cart_idx on public.lng_cart_items (cart_id, sort_order);

-- Keep lng_carts.subtotal_pence in sync with the sum of its line items.
-- Trigger on AFTER INSERT/UPDATE/DELETE of lng_cart_items.
create or replace function public.lng_cart_items_resync_subtotal()
returns trigger
language plpgsql
as $$
declare
  v_cart_id uuid;
begin
  v_cart_id := coalesce(new.cart_id, old.cart_id);
  update public.lng_carts c
     set subtotal_pence = coalesce((
           select sum(line_total_pence)::int
             from public.lng_cart_items
            where cart_id = v_cart_id
         ), 0),
         updated_at = now()
   where c.id = v_cart_id;
  return null;
end;
$$;

create trigger lng_cart_items_subtotal_after_insert
  after insert on public.lng_cart_items
  for each row execute function public.lng_cart_items_resync_subtotal();
create trigger lng_cart_items_subtotal_after_update
  after update on public.lng_cart_items
  for each row execute function public.lng_cart_items_resync_subtotal();
create trigger lng_cart_items_subtotal_after_delete
  after delete on public.lng_cart_items
  for each row execute function public.lng_cart_items_resync_subtotal();

comment on table public.lng_carts is
  'One cart per visit. total_pence is generated. status flips to paid when sum(succeeded payments) >= total.';
comment on table public.lng_cart_items is
  'Line items. line_total_pence is generated. Edits while cart.status = open; trigger keeps cart.subtotal_pence in sync.';
