-- 20260520000009_lng_default_unassigned_staff_to_lab.sql
--
-- Bulk-assigns every active Lounge staff member without a location
-- to The Venneir Clinic (lab, Glasgow). accounts.location_id is the
-- deterministic location every Lounge view filters on (schedule,
-- till, patient pool, visit list); a null value renders most of the
-- app empty for that staff member on sign-in.
--
-- All Lounge staff currently work the lab axis, so the lab is the
-- correct default. Anyone who actually belongs to the practice
-- can be moved via the Manage Staff > Location dropdown.
--
-- Scoped to lng_staff_members (status = 'active') joined through
-- accounts so we never touch a Meridian-only accounts row that
-- happens to share an email.

update public.accounts a
   set location_id = '89ba5824-30bf-4386-a878-f307096bb402'  -- The Venneir Clinic (lab, Glasgow)
  from public.lng_staff_members s
 where s.account_id = a.id
   and s.status = 'active'
   and a.location_id is null;
