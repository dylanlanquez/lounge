-- 20260517000012_lng_reline_description.sql
--
-- Rewrites the customer-facing description of the Reline option on
-- the denture-repair widget. Previous text named arches ("upper,
-- lower, or both dentures") which is redundant — the customer picks
-- the arch on the next step — and didn't explain what a reline
-- actually does.
--
-- New copy explains the procedure (we reshape the inside of the
-- denture) and the outcome (grips the gum again, stops slipping),
-- in plain English without dental jargon.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────

update public.lwo_catalogue
   set description = 'We reshape the inside of your denture so it grips your gum again and stops slipping.'
 where service_type = 'denture_repair'
   and repair_variant = 'Relining'
   and code = 'den_reline';
