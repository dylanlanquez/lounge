-- 20260609000005_lng_meet_hosts_self_serve_grant.sql
--
-- Follow-up to 20260609000001, which added lng_meet_hosts.self_serve.
--
-- lng_meet_hosts uses COLUMN-level SELECT grants for anon/authenticated
-- (the secret token columns access_token / refresh_token / token_expiry
-- are deliberately withheld; see the meet-host-reorder work that set
-- this up). A column added after those grants were created is NOT
-- covered by them, so the client's `select(... self_serve)` failed at
-- runtime with "permission denied for table lng_meet_hosts" even though
-- RLS would have allowed the row.
--
-- 20260609000001 added the column but not the column grant; this fixes
-- it. self_serve carries no secret, so anon + authenticated may read it
-- (matching every other non-token column). Idempotent — re-runnable.

grant select (self_serve) on public.lng_meet_hosts to anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- revoke select (self_serve) on public.lng_meet_hosts from anon, authenticated;
