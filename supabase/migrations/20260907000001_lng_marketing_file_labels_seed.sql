-- 20260907000001_lng_marketing_file_labels_seed.sql
--
-- Seeds the file_labels rows the Before & after and Marketing content
-- galleries write against. Read against Meridian on 7 Sep 2026, only
-- ONE of the three is actually missing:
--
--   before_photo       Before photo       present  (scope patient_file, sort_order 900)
--   after_photo        After photo        MISSING  <- the upload that fails
--   marketing_content  Marketing content  present  (scope patient_file, sort_order 900)
--
-- All three are listed below anyway. The guard makes the two existing
-- rows a no-op, and naming the full set documents what the galleries
-- depend on rather than leaving the next reader to infer it.
--
-- Why this is needed: PhotoGallery.tsx hardcodes these three label
-- keys (LABEL_BEFORE / LABEL_AFTER / LABEL_MARKETING) and hands them
-- to uploadPatientFile, which resolves the key through
-- getOrCreateLabel in src/lib/queries/patientFiles.ts. No migration
-- ever put the rows in file_labels, so the lookup came back empty and
-- the helper fell through to INSERT INTO public.file_labels. That is
-- a Meridian-owned table: Lounge staff have no write privilege on it,
-- so PostgREST returned
--
--   new row violates row-level security policy for table "file_labels"
--
-- and the after-photo upload failed at the first step, before the file
-- ever reached the case-files bucket. "Add before" worked, because that
-- label happened to exist, which is why the card looked half-broken
-- rather than dead.
--
-- Labels are catalogue data, not runtime data. They belong in a
-- migration, applied with the migration role, and the app should only
-- ever read them. The companion code change removes the INSERT path
-- from getOrCreateLabel so this class of failure cannot come back
-- disguised as an RLS error.
--
-- Column choices:
--   scope = 'patient_file'  matches the rows the patient files grid
--                           already reads (usePatientFileLabels
--                           filters scope = 'patient_file' AND
--                           active = true). Anything else and the
--                           labels are invisible to that hook.
--   active = true           the galleries need them live now.
--   sort_order = 900        the value both sibling rows already carry.
--                           These three never render as fixed slots in
--                           the patient files grid (they are owned by
--                           BeforeAfterGallery and MarketingGallery),
--                           so ordering only matters to a
--                           Meridian-side label picker, and matching
--                           the siblings keeps them grouped there.
--
-- Idempotent: guarded on `where not exists`, so re-running is a no-op
-- and any row Meridian has already created keeps its own wording,
-- scope and sort_order.
--
-- Rollback:
--   delete from public.file_labels
--    where key in ('before_photo', 'after_photo', 'marketing_content')
--      and not exists (
--        select 1 from public.patient_files pf where pf.label_id = file_labels.id
--      );
--   (the guard matters: once photos are attached, deleting the label
--    orphans them from every gallery query.)

insert into public.file_labels (key, label, scope, active, sort_order)
select v.key, v.label, 'patient_file', true, v.sort_order
  from (values
          ('before_photo',      'Before photo',      900),
          ('after_photo',       'After photo',       900),
          ('marketing_content', 'Marketing content', 900)
       ) as v(key, label, sort_order)
 where not exists (
   select 1 from public.file_labels fl where fl.key = v.key
 );
