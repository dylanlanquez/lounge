-- 20260520000004_lng_staff_invite_tracking.sql
--
-- Staff invite + last-active tracking on lng_staff_members.
--
-- Two distinct problems this addresses:
--
-- 1. "Invite link expired" before the user even clicks. Cause:
--    corporate mail scanners (Outlook ATP, Gmail safe-links, generic
--    spam gateways) issue a GET on every URL in every email to
--    sandbox-scan it. The Supabase /auth/v1/verify endpoint is GET
--    AND state-mutating — the scan consumes the single-use token,
--    and the staff member's real click lands on an "expired" page.
--    Fix: stop putting the Supabase action_link in the email. Email
--    carries a custom UUID invite_token that points at
--    /welcome?invite=<uuid>. The scanner pre-fetch sees an HTML
--    page that does nothing without a follow-up authenticated
--    exchange. The real user's click hits lng-accept-invite which
--    mints a fresh Supabase magic-link at that moment, valid for
--    Supabase's own short window.
--
-- 2. The Admin Staff tab had no visibility into invite state or
--    sign-in recency. invite_sent_at + invite_accepted_at +
--    last_sign_in_at make those facts visible alongside the per-
--    staff Resend invite button.
--
-- Backfill: invite_accepted_at = hired_at for every existing
-- active staff row so the Admin sheet doesn't suddenly read "never
-- accepted" for people who set up their accounts months ago.

alter table public.lng_staff_members
  add column if not exists invite_token        uuid,
  add column if not exists invite_sent_at      timestamptz,
  add column if not exists invite_expires_at   timestamptz,
  add column if not exists invite_accepted_at  timestamptz,
  add column if not exists last_sign_in_at     timestamptz;

create unique index if not exists lng_staff_members_invite_token_key
  on public.lng_staff_members (invite_token)
  where invite_token is not null;

create index if not exists lng_staff_members_pending_invite_idx
  on public.lng_staff_members (invite_expires_at)
  where invite_accepted_at is null and invite_token is not null;

comment on column public.lng_staff_members.invite_token is
  'Custom UUID embedded in the staff_invite email link. Cleared once accepted. Long-lived (7 days) so corporate mail scanners pre-fetching the link cannot exhaust a short-TTL Supabase token before the human clicks.';
comment on column public.lng_staff_members.invite_sent_at is
  'Last time a staff_invite email was successfully dispatched. Re-set by lng-resend-staff-invite each time the admin resends.';
comment on column public.lng_staff_members.invite_expires_at is
  'Timestamp after which the custom invite_token stops being valid. lng-accept-invite refuses to mint a Supabase session after this point. Reset on resend.';
comment on column public.lng_staff_members.invite_accepted_at is
  'First time the invite token was successfully exchanged for a Supabase session (i.e. the staff member opened /welcome and Supabase signed them in). Never cleared once set.';
comment on column public.lng_staff_members.last_sign_in_at is
  'Updated on every successful Lounge sign-in by lng_record_staff_sign_in() RPC, called from the AuthProvider on SIGNED_IN events. Used by Admin to surface "last active".';

-- Backfill: existing active accounts predate the invite_token flow;
-- they accepted via the old Supabase invite link, so mark them
-- accepted at hire time so the Admin sheet reads correctly.
update public.lng_staff_members
   set invite_accepted_at = hired_at
 where status = 'active'
   and invite_accepted_at is null;
