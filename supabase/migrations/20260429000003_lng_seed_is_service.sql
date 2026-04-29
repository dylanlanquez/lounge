-- 20260429000003_lng_seed_is_service.sql
--
-- One-shot data bootstrap. Migration 02 added the is_service column to
-- lwo_catalogue with default false. PR 3 of the picker overhaul switches
-- the Services/Products grouping from the temporary service_type
-- heuristic to is_service. Without this seed, every existing row would
-- land in the Products bucket on first load until admin flipped each
-- one — even rows that the heuristic already treated as services.
--
-- Match the heuristic exactly: any row with service_type in
-- ('denture_repair', 'impression_appointment') becomes a service.
-- Idempotent: only updates rows that aren't already flagged, so re-running
-- the migration is safe.
--
-- Rollback: there is no automatic rollback for a data update. To revert,
-- set is_service = false on rows where it was bootstrapped.

update public.lwo_catalogue
   set is_service = true
 where service_type in ('denture_repair', 'impression_appointment')
   and is_service = false;
