-- 20260429000010: per-row quantity-selector flag on lwo_catalogue.
--
-- Why a deliberate flag instead of inferring from unit_label:
--   Until now the picker decided whether to show the Quantity stepper
--   by checking unit_label != null. That conflates display copy with
--   behaviour: a row labelled 'per tooth' got the stepper, a row with
--   no unit_label didn't. Fragile — a new product with a unit_label
--   for clarity would silently inherit a quantity stepper, even when
--   the clinic only ever sells exactly one of it.
--
-- This column is the deliberate, schema-driven flag. The picker reads
-- it; the admin catalogue editor exposes it as a checkbox. unit_label
-- stays as a display hint only.
--
-- Defaults true so every existing row keeps its current behaviour. We
-- explicitly backfill false on the canonical single-instance services
-- (impression appointment) where qty > 1 doesn't make sense.

alter table public.lwo_catalogue
  add column if not exists quantity_enabled boolean not null default true;

update public.lwo_catalogue
   set quantity_enabled = false
 where code in ('impression_appt');

comment on column public.lwo_catalogue.quantity_enabled is
  'When false, the Lounge picker does not show a Quantity stepper for this row. Defaults true; admin flips it off for one-shot services.';
