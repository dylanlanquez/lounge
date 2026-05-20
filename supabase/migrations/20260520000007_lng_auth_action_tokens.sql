-- 20260520000007_lng_auth_action_tokens.sql
--
-- Custom-token relay for password-recovery and magic-link emails.
-- Same architectural pattern as the staff_invite flow shipped in
-- 20260520000004: instead of putting Supabase's single-use
-- action_link directly into the email (where Outlook ATP / Gmail
-- safe-links / generic mail scanners issue a GET on every URL and
-- consume the one-shot token before the human ever clicks),
-- we ship a long-lived UUID token that points at a React page
-- (/welcome). The page does nothing on GET; only an authenticated
-- POST to lng-exchange-auth-token mints a fresh Supabase link at
-- click-time. Scanner pre-fetches see HTML and walk away.
--
-- The lng_staff_members.invite_token column already solves this for
-- invites. Recovery + magic-link are not tied to staff lifecycle
-- (they may be issued repeatedly for the same staff member), so
-- they live in their own table. Each row is one issued credential;
-- consumed_at is set on first successful exchange so a second click
-- (or a delayed scanner pre-fetch) cannot reuse it.

create table if not exists public.lng_auth_action_tokens (
  id          uuid primary key default gen_random_uuid(),
  token       uuid not null unique,
  account_id  uuid not null references public.accounts(id) on delete cascade,
  -- Restrict to the auth flows that need scanner-proof delivery.
  -- Invites stay on lng_staff_members.invite_token to keep the
  -- existing accept flow unchanged.
  action      text not null check (action in ('recovery', 'magic_link')),
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_by  uuid references public.accounts(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Lookup pattern: edge function receives the URL token, hits this
-- table to validate. Indexing on (token) where not consumed is the
-- hot path; the unique constraint already covers exact-match reads,
-- but the partial filter keeps the index lean once expired rows
-- start accumulating.
create index if not exists lng_auth_action_tokens_active_idx
  on public.lng_auth_action_tokens (token)
  where consumed_at is null;

-- Per-account audit: "show me every token ever issued for this
-- person, newest first". Used by an admin UI later if needed.
create index if not exists lng_auth_action_tokens_account_idx
  on public.lng_auth_action_tokens (account_id, created_at desc);

comment on table public.lng_auth_action_tokens is
  'One row per password-recovery / magic-link credential issued. The UUID token is embedded in the email URL; the row is the truth that lng-exchange-auth-token validates before minting a fresh Supabase action_link at click-time. See lng_staff_members.invite_token for the parallel invite-side credential.';
comment on column public.lng_auth_action_tokens.token is
  'UUID embedded in the /welcome?recovery=<uuid> or /welcome?signin=<uuid> URL. Consumed on first successful exchange.';
comment on column public.lng_auth_action_tokens.expires_at is
  'After this point the token is rejected even if not yet consumed. Set generously (1 hour for recovery, 30 min for magic_link) so mail scanners + real human clicks both fit inside the window.';
comment on column public.lng_auth_action_tokens.consumed_at is
  'Set on first successful exchange. Once non-null the token cannot be reused.';
comment on column public.lng_auth_action_tokens.created_by is
  'The admin account that minted this token (Send password reset / Send sign-in link). Null for any future self-service flow.';

-- RLS: closed by default. Only edge functions running with the
-- service role read or write this table. There is no use case where
-- a signed-in user should be able to enumerate other users'
-- recovery tokens via PostgREST.
alter table public.lng_auth_action_tokens enable row level security;
