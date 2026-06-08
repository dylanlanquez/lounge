-- 20260608000002_lng_meet_hosts_oauth_client.sql
--
-- Multi-workspace OAuth: record which Google OAuth app minted each
-- host's tokens, so refresh + re-exchange use the matching client_id /
-- client_secret. A host connected through the lanquez.com app cannot be
-- refreshed with the Venneir app's secret, and vice versa.
--
-- Existing rows default to 'venneir' (the original app whose secrets are
-- GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), so every already-connected
-- host keeps working unchanged. The set of valid keys lives in code
-- (_shared/meetOAuthClients.ts), not a CHECK constraint, so adding a
-- workspace is just code + secrets, no migration.

alter table public.lng_meet_hosts
  add column if not exists oauth_client text not null default 'venneir';

comment on column public.lng_meet_hosts.oauth_client is
  'Which Google OAuth app (workspace) minted this host''s tokens. Keys are defined in supabase/functions/_shared/meetOAuthClients.ts. Drives which client_id/secret refresh uses. NULL never: defaults to venneir.';

NOTIFY pgrst, 'reload schema';
