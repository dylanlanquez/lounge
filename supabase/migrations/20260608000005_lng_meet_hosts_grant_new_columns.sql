-- 20260608000005_lng_meet_hosts_grant_new_columns.sql
--
-- Hotfix: lng_meet_hosts uses COLUMN-level SELECT grants (the token
-- columns were revoked in 20260608000001 to stop client reads). That
-- makes the grant a footgun: any new non-secret column must be granted
-- explicitly, or a client SELECT that includes it fails with 42501
-- "permission denied for table lng_meet_hosts" — which broke the admin
-- host list AND the booking host dropdown the moment the frontend began
-- selecting sort_order.
--
-- Grant the columns added since the lockdown: oauth_client
-- (20260608000002) and sort_order (20260608000004). Idempotent.
grant select (oauth_client, sort_order) on public.lng_meet_hosts to authenticated;
grant select (oauth_client, sort_order) on public.lng_meet_hosts to anon;

NOTIFY pgrst, 'reload schema';
