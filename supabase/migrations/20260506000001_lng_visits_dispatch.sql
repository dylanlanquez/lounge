-- 20260506000001_lng_visits_dispatch.sql
--
-- Shipping dispatch columns on lng_visits.
-- When a visit completes with fulfilment_method='shipping' the receptionist
-- opens the dispatch form which calls book-lng-shipment. That edge function
-- stamps these columns once DPD returns successfully.
--
-- Adds:
--   dispatched_at    timestamptz  — when the label was created
--   dispatched_by    text         — staff display name who processed the shipment
--   tracking_number  text         — DPD parcel / tracking number
--   shipment_id      text         — DPD shipmentId for label re-fetch
--   label_data       text         — ZPL payload for the 4x4 thermal printer
--   shipping_address jsonb        — snapshot of the delivery address at dispatch time
--   dispatch_ref     text         — human-readable ref e.g. LVO-A1B2C3D4
--
-- Rollback:
--   alter table public.lng_visits drop column if exists dispatched_at;
--   alter table public.lng_visits drop column if exists dispatched_by;
--   alter table public.lng_visits drop column if exists tracking_number;
--   alter table public.lng_visits drop column if exists shipment_id;
--   alter table public.lng_visits drop column if exists label_data;
--   alter table public.lng_visits drop column if exists shipping_address;
--   alter table public.lng_visits drop column if exists dispatch_ref;

alter table public.lng_visits
  add column if not exists dispatched_at    timestamptz,
  add column if not exists dispatched_by    text,
  add column if not exists tracking_number  text,
  add column if not exists shipment_id      text,
  add column if not exists label_data       text,
  add column if not exists shipping_address jsonb,
  add column if not exists dispatch_ref     text;

comment on column public.lng_visits.dispatched_at    is 'Timestamp when the DPD label was created and the shipment confirmed.';
comment on column public.lng_visits.dispatched_by    is 'Display name of the staff member who processed the dispatch.';
comment on column public.lng_visits.tracking_number  is 'DPD parcel/tracking number. Used to build the track.dpdlocal.co.uk link.';
comment on column public.lng_visits.shipment_id      is 'DPD shipmentId returned by the API. Reserved for label re-fetch.';
comment on column public.lng_visits.label_data       is 'ZPL string for the 4×4 thermal printer label.';
comment on column public.lng_visits.shipping_address is 'Snapshot of the delivery address at dispatch time: {name, address1, address2, city, zip, country_code}.';
comment on column public.lng_visits.dispatch_ref     is 'Human-readable dispatch reference e.g. LVO-A1B2C3D4. Shown on the Shipped items card and inserted into Checkpoint''s shipping_queue as order_name.';
