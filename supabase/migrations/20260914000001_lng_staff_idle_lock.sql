-- Per-staff exemption from the idle lock screen.
--
-- The lock (src/lib/idleLock.ts) covers Lounge after five idle minutes and
-- asks for the signed-in user's password again, because the tablet sits on a
-- public reception desk showing a patient's name, date of birth, phone
-- number, payments and photos. Some staff work in a setting where that
-- re-prompt is friction without a matching risk, so this switches it off for
-- one named person.
--
-- Denylist semantics, the opposite of marketing_walkthrough_enabled: default
-- TRUE, so every staff member keeps the lock and new staff are protected
-- without anyone remembering to switch it on. An admin opts a specific person
-- OUT in Admin -> Staff -> Manage.
--
-- Read on every app load via fetchCurrentStaffMembership -> useCurrentAccount
-- and consumed by src/lib/idleLockContext.tsx. The client only treats an
-- explicit false as an exemption, so a missing or unreadable value leaves the
-- lock ON. A security control that fails open on a read error is not one.

alter table public.lng_staff_members
  add column if not exists idle_lock_enabled boolean not null default true;

comment on column public.lng_staff_members.idle_lock_enabled is
  'When false, this staff member is exempt from the idle lock screen and Lounge never auto-locks on their session. Denylist: defaults true (everyone is locked), an admin opts a person out in Admin > Staff > Manage. Disabling it leaves patient records readable to anyone at the reception desk for as long as the tablet is signed in.';
