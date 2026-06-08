-- 20260608000003_lng_meet_host_invites.sql
--
-- One-time, expiring invite tokens that let a remote person connect
-- themselves as a Meet host without a Lounge admin login.
--
-- Why: connecting a Meet host requires that person to complete Google's
-- OAuth consent (only they can authorise their own account). The normal
-- Connect button is admin-gated and assumes the host is sitting at an
-- admin's screen. For remote clinicians (e.g. lanquez.com staff who
-- aren't Lounge admins) an admin generates a link from this table, sends
-- it to them, and they open it on their own device, sign into their
-- Google, and consent. The token authorises ONLY connecting a Meet host
-- for one workspace, nothing else.
--
-- Lifecycle: created by an admin (via the meet-host-invite edge fn),
-- consumed once in meet-auth-callback (used_at + created_host_id set),
-- and ignored thereafter / once expires_at passes. Validation and
-- consumption happen server-side as service_role, so the public connect
-- page never needs row access.

create table public.lng_meet_host_invites (
  id                    uuid primary key default gen_random_uuid(),
  -- Opaque random token carried in the connect link's ?token= param.
  token                 text not null unique,
  -- Which workspace OAuth app the invited host connects through. Keys
  -- live in _shared/meetOAuthClients.ts.
  oauth_client          text not null default 'venneir',
  -- Free-text "who this is for" so the admin list + connect page can
  -- show a name. Not used for matching.
  label                 text,
  created_by_account_id uuid references public.accounts(id) on delete set null,
  expires_at            timestamptz not null,
  -- Set when the invite is successfully redeemed. A second open is
  -- rejected.
  used_at               timestamptz,
  created_host_id       uuid references public.lng_meet_hosts(id) on delete set null,
  created_at            timestamptz not null default now()
);

create index lng_meet_host_invites_token_idx on public.lng_meet_host_invites (token);

comment on table public.lng_meet_host_invites is
  'One-time expiring tokens for remote Meet host self-connect. Created by an admin, consumed once in meet-auth-callback.';

alter table public.lng_meet_host_invites enable row level security;

-- Admins can view invites (for an optional pending-invites list). All
-- writes happen server-side as service_role (edge functions), which
-- bypasses RLS, so no insert/update policy is granted to clients.
drop policy if exists lng_meet_host_invites_admin_select on public.lng_meet_host_invites;
create policy lng_meet_host_invites_admin_select on public.lng_meet_host_invites
  for select to authenticated
  using (public.is_admin());

NOTIFY pgrst, 'reload schema';
