-- verify-cs-order-read.sql
--
-- Verification for 20260908000001_lng_customer_service_order_read.sql.
-- Run against SHADOW first, then Meridian:
--
--   psql "$LNG_SHADOW_DB_URL"   -f scripts/verify-cs-order-read.sql
--   psql "$LNG_MERIDIAN_DB_URL" -f scripts/verify-cs-order-read.sql
--
-- Read-only. Every statement is a SELECT; nothing here mutates.
-- Each check prints its own verdict so the output can be pasted back
-- without needing the file to hand.

\pset pager off
\echo ''
\echo '=== 1. Helpers exist and are security definer ==='

select
  p.proname                                  as function_name,
  p.prosecdef                                as is_security_definer,
  case when p.prosecdef then 'PASS' else 'FAIL: must be security definer' end as verdict
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('auth_is_customer_service', 'auth_lng_mfa_satisfied')
order by p.proname;

\echo ''
\echo '=== 2. All ten CS policies present, SELECT only except the audit insert ==='

select
  tablename,
  policyname,
  cmd,
  case
    when policyname = 'patient_events_cs_order_view_insert' and cmd = 'INSERT' then 'PASS'
    when policyname like '%_cs_select' and cmd = 'SELECT' then 'PASS'
    else 'FAIL: unexpected command for this policy'
  end as verdict
from pg_policies
where schemaname = 'public'
  and policyname like '%_cs_%'
order by tablename, policyname;

\echo ''
\echo 'Expect exactly 10 rows: 9 SELECT policies plus patient_events_cs_order_view_insert.'

\echo ''
\echo '=== 3. The CS role holds NO write policy on any lng_ table ==='

select
  coalesce(count(*), 0) as unexpected_write_policies,
  case when count(*) = 0 then 'PASS'
       else 'FAIL: CS has a write policy on an lng_ table' end as verdict
from pg_policies
where schemaname = 'public'
  and tablename like 'lng_%'
  and policyname like '%_cs_%'
  and cmd <> 'SELECT';

\echo ''
\echo '=== 4. No anon policy on any order table ==='
\echo 'The anon key ships in the public booking embed. Any row here is a leak.'

select
  tablename,
  policyname,
  roles,
  'FAIL: anon can read an order table' as verdict
from pg_policies
where schemaname = 'public'
  and tablename in (
    'lng_visits', 'lng_walk_ins', 'lng_appointments',
    'lng_carts', 'lng_cart_items', 'lng_cart_item_upgrades',
    'lng_cart_discounts', 'lng_payments', 'lng_payment_refunds'
  )
  and roles::text[] && array['anon', 'public'];

\echo ''
\echo 'Zero rows above is a PASS.'

\echo ''
\echo '=== 5. lng_visit_paid_status: does the view bypass RLS? ==='
\echo 'A view without security_invoker runs with its OWNER''s rights, so it'
\echo 'ignores the table policies entirely. If this reports false, the money'
\echo 'block is readable by any authenticated session that can select the'
\echo 'view, regardless of the CS policies above. See risk L2 in the slice.'
\echo 'This is PRE-EXISTING behaviour, not introduced by this migration.'

select
  c.relname as view_name,
  coalesce(
    (select option_value
       from pg_options_to_table(c.reloptions)
      where option_name = 'security_invoker'),
    'not set'
  ) as security_invoker,
  case
    when coalesce(
      (select option_value
         from pg_options_to_table(c.reloptions)
        where option_name = 'security_invoker'), 'false') = 'true'
    then 'PASS: view respects table RLS'
    else 'REVIEW: view runs with owner rights and bypasses the CS policies'
  end as verdict
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'lng_visit_paid_status';

\echo ''
\echo '=== 6. Who can select the view today ==='

select
  grantee,
  privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'lng_visit_paid_status'
order by grantee, privilege_type;

\echo ''
\echo '=== 7. Existing receptionist and admin policies untouched ==='
\echo 'This migration must not have altered them. Expect the same set as before.'

select
  tablename,
  policyname,
  cmd
from pg_policies
where schemaname = 'public'
  and tablename in (
    'lng_visits', 'lng_carts', 'lng_cart_items',
    'lng_payments', 'lng_payment_refunds'
  )
  and policyname not like '%_cs_%'
order by tablename, policyname;

\echo ''
\echo '=== 8. CS accounts and their 2FA posture ==='
\echo 'require_2fa = false means that agent reads payment data at aal1,'
\echo 'which is the same bar Lounge itself applies to them. Worth turning on.'

select
  a.email,
  sm.status,
  sm.is_customer_service,
  sm.require_2fa,
  sm.is_admin,
  sm.is_manager
from public.lng_staff_members sm
join public.accounts a on a.id = sm.account_id
where sm.is_customer_service = true
order by sm.status, a.email;

\echo ''
\echo '=== Done. Checks 1 to 4 and 7 must pass before Meridian. ==='
\echo 'Check 5 is a finding to triage, not a blocker for this migration.'
\echo 'The three-session test (CS at aal2, CS at aal1, non-Lounge account)'
\echo 'runs from the app, not here: see step 2 of the slice doc.'
