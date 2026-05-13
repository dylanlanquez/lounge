-- Brand identity on appointments.
--
-- Why: a single Supabase project hosts bookings from BOTH venneir.com
-- and denture-services.co.uk. Until now every appointment was
-- implicitly Venneir's because that was the only embed surface; now
-- the modal-overlay embed (lounge-app/src/widgets/{venneir,denture}/)
-- lets a customer book from either Shopify storefront and we need to
-- remember which brand they came in through.
--
-- Downstream consumers (Stage 3 of the widget rebuild):
--   * send-appointment-confirmation picks the FROM address +
--     branding variables per brand. Today the Resend infra for
--     denture-services.co.uk isn't set up so denture rows still
--     fall back to the Venneir sender; once DNS lands the email
--     function reads brand_id and switches over without code change.
--   * Reports / Ledger can filter by brand once they have UI for it.
--
-- Default: 'venneir'. Every existing row predates the denture
-- embed so backfill is implicit. Future rows from the denture
-- bundle write 'denture' explicitly.
--
-- Not a closed enum at the DB level: we want admins to be able to
-- add a third brand surface without a migration. The validation
-- lives in widget-create-appointment which checks against a JS
-- whitelist; bad strings get 400 invalid rather than corrupting
-- the row.

alter table public.lng_appointments
  add column if not exists brand_id text not null default 'venneir';

comment on column public.lng_appointments.brand_id is
  'Customer-facing brand the booking was placed through: ''venneir'' or ''denture''. Set by the widget edge functions from the bundle that submitted the booking.';

-- Reports / dashboards may filter by brand. Cheap index — the
-- table is small enough that even a seq scan is fast, but the
-- index keeps brand-segmented analytics queries from regressing
-- once volume grows.
create index if not exists lng_appointments_brand_id_idx
  on public.lng_appointments (brand_id);
