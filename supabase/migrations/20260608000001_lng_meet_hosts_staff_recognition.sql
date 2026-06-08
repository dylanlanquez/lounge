-- 20260608000001_lng_meet_hosts_staff_recognition.sql
--
-- Staff (name-recognition) Meet hosts + RLS hardening.
--
-- Why: a virtual appointment's Meet space is OWNED by an OAuth-connected
-- host (e.g. Karly) whose grant the Meet REST API reads attendance
-- through. But the person who actually RUNS the call is often a different
-- staff member who can't (or shouldn't) connect their own Google account
-- (e.g. they sit outside the Workspace org, so Google's org_internal gate
-- blocks the OAuth consent screen). Those staff still join the Meet, and
-- we want them recognised as the host on the attendance card, not
-- mistaken for the patient.
--
-- This migration lets an admin register a staff member as a
-- name-recognition host: kind = 'staff', no OAuth tokens. The attendance
-- pipeline (meetAttendanceCore) matches them by display name, and
-- auto-binds their stable Google user id the first time it sees an
-- exact-name match, so future meetings match on the un-forgeable id.
--
-- It ALSO fixes two pre-existing defects on lng_meet_hosts:
--   1. No INSERT / UPDATE / DELETE RLS policy existed, so the admin
--      Deactivate / Remove buttons silently no-opped (the writes matched
--      zero rows under RLS and returned success). Admin write policies
--      are added.
--   2. access_token / refresh_token / token_expiry were SELECT-able by
--      every authenticated user: the select policy is `is_admin() OR
--      true` and the column grants were wide open, so any signed-in
--      account could read the OAuth credentials. Those column grants are
--      revoked. Edge functions read tokens as service_role, which
--      bypasses column privileges, so server-side reads are unaffected.

-- 1. Schema: name-recognition hosts ------------------------------------

-- OAuth hosts always carry a google_email (from the Google profile);
-- staff hosts never do. Drop NOT NULL. The UNIQUE constraint still holds
-- (Postgres permits multiple NULLs in a unique index).
alter table public.lng_meet_hosts
  alter column google_email drop not null;

alter table public.lng_meet_hosts
  add column if not exists kind text not null default 'oauth'
    check (kind in ('oauth', 'staff'));

alter table public.lng_meet_hosts
  add column if not exists staff_member_id uuid
    references public.lng_staff_members(id) on delete cascade;

-- One staff member maps to at most one recognition host.
create unique index if not exists lng_meet_hosts_staff_member_unique
  on public.lng_meet_hosts (staff_member_id)
  where staff_member_id is not null;

-- Shape guard: an oauth host must carry an email; a staff host must
-- reference a staff member and must never hold OAuth tokens.
alter table public.lng_meet_hosts
  drop constraint if exists lng_meet_hosts_kind_shape;
alter table public.lng_meet_hosts
  add constraint lng_meet_hosts_kind_shape check (
    (kind = 'oauth' and google_email is not null)
    or (kind = 'staff' and staff_member_id is not null
        and access_token is null and refresh_token is null)
  );

comment on column public.lng_meet_hosts.kind is
  'oauth = Google-connected host that owns Meet spaces and whose grant reads attendance. staff = name-recognition only host (no tokens); matched by display name, auto-binds google_user_id on first exact match.';
comment on column public.lng_meet_hosts.staff_member_id is
  'For kind = staff: the lng_staff_members row this recognition host represents. NULL for oauth hosts.';

-- 2. RLS: admin write policies (fixes silent no-op deactivate / remove) -

drop policy if exists lng_meet_hosts_admin_insert on public.lng_meet_hosts;
create policy lng_meet_hosts_admin_insert on public.lng_meet_hosts
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists lng_meet_hosts_admin_update on public.lng_meet_hosts;
create policy lng_meet_hosts_admin_update on public.lng_meet_hosts
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists lng_meet_hosts_admin_delete on public.lng_meet_hosts;
create policy lng_meet_hosts_admin_delete on public.lng_meet_hosts
  for delete to authenticated
  using (public.is_admin());

-- 3. Harden secret columns: no client reads of OAuth tokens ------------
-- A table-level SELECT grant implicitly covers every column, so revoking
-- the secret columns alone is a no-op while it exists. Revoke the
-- table-level grant, then grant SELECT back on only the non-secret
-- columns. Edge functions read tokens as service_role, which bypasses
-- column privileges, so server-side reads are unaffected.
revoke select on public.lng_meet_hosts from authenticated;
revoke select on public.lng_meet_hosts from anon;

grant select (
  id, display_name, google_email, google_user_id, is_active, created_at,
  kind, staff_member_id, connected_by_account_id
) on public.lng_meet_hosts to authenticated;
grant select (
  id, display_name, google_email, google_user_id, is_active, created_at,
  kind, staff_member_id, connected_by_account_id
) on public.lng_meet_hosts to anon;

NOTIFY pgrst, 'reload schema';
