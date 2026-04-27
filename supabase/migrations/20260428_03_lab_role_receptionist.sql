-- 20260428_03_lab_role_receptionist.sql
-- Add `receptionist` to the existing lab_role_enum.
--
-- This migration MUST run on its own. Postgres (pre-12) cannot use a newly
-- ALTER TYPE-added value in the same transaction; even on PG 12+ it is best
-- practice to keep this isolated so subsequent migrations can rely on the value.
--
-- ADR-004 in `01-architecture-decision.md`. The boolean overrides for receptionist
-- rows in `location_members` are documented there; they are NOT enforced at the
-- schema level — they are policy / onboarding rules.
--
-- Rollback: not straightforward. Postgres cannot remove an enum value that is in use.
-- If a rollback is needed and no rows reference 'receptionist', re-create the type:
--   ALTER TYPE lab_role_enum RENAME TO lab_role_enum_old;
--   CREATE TYPE lab_role_enum AS ENUM ('lab_admin', 'lab_manager', 'lab_technician', 'cad_designer');
--   ALTER TABLE location_members ALTER COLUMN lab_role TYPE lab_role_enum USING lab_role::text::lab_role_enum;
--   DROP TYPE lab_role_enum_old;

alter type public.lab_role_enum add value if not exists 'receptionist';
