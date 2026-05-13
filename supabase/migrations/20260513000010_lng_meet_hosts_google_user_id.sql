-- Stable Google user ID for each Meet host.
--
-- meet-fetch-attendance used to tag is_host by display_name match
-- against lng_meet_hosts.display_name. Real-world data showed three
-- distinct Google accounts joining the same conference all using the
-- display name "Dylan Lane" — only one was the actual registered
-- host. The display name is a string anyone can type in the Meet
-- "your name" prompt; trusting it for the "is this the host?"
-- determination produced false positives and undermined the verdict
-- line ("Both attended" when actually only the patient and a random
-- "Dylan Lane" joined).
--
-- The fix is to compare against Google's own stable user resource ID,
-- which is what the Meet API returns as signedinUser.user
-- ("users/<id>"). That ID is the same value the OAuth flow returns as
-- the `sub` claim and as `/oauth2/v2/userinfo.id` — un-forgeable
-- because it's issued by Google per Google account, not declared by
-- the user.
--
-- google_user_id holds that bare ID (no "users/" prefix). null on
-- rows that pre-date this column; meet-fetch-attendance falls back to
-- display_name matching for those, so the change is non-breaking at
-- the system level. The backfill below seeds dylan.lane@venneir.com
-- with the user_id we captured from a recent tokeninfo diagnostic
-- (sub: 101758343189325324740). New OAuth grants capture it
-- automatically via meet-auth-callback.

alter table public.lng_meet_hosts
  add column if not exists google_user_id text;

comment on column public.lng_meet_hosts.google_user_id is
  'Google''s stable user resource id (the OAuth sub claim, also returned by /oauth2/v2/userinfo as id). Used by meet-fetch-attendance to match conferenceRecord participants to a registered host without trusting the forgeable display_name. Captured at OAuth callback time.';

create index if not exists lng_meet_hosts_google_user_id_idx
  on public.lng_meet_hosts (google_user_id)
  where google_user_id is not null;

-- One-shot backfill for the only currently-registered host. The
-- user_id was captured from a tokeninfo diagnostic earlier today
-- (sub: 101758343189325324740). New connects populate via the auth
-- callback; this update handles the row that predated the column.
update public.lng_meet_hosts
   set google_user_id = '101758343189325324740'
 where google_email = 'dylan.lane@venneir.com'
   and google_user_id is null;

NOTIFY pgrst, 'reload schema';
