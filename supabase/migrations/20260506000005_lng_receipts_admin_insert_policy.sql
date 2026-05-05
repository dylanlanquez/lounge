-- 20260506000005_lng_receipts_admin_insert_policy.sql
--
-- Adds an INSERT RLS policy on lng_receipts for admin users.
-- Migration 003 added the receptionist policy but missed admins;
-- Co-Directors testing Pay.tsx were hitting 403 on receipt insert.
--
-- Rollback: drop policy lng_receipts_admin_insert on public.lng_receipts;

create policy lng_receipts_admin_insert
  on public.lng_receipts for insert
  to authenticated
  with check (public.is_admin());
