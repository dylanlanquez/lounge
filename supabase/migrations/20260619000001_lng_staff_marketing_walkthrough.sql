-- Per-staff gate for the marketing-content walkthrough (the guided tour
-- that auto-starts and the Schedule "Show me how" banner that replays it).
--
-- Allowlist semantics: default false. The tour shows to NOBODY until an
-- admin switches it on for a specific staff member in Admin -> Staff ->
-- Manage. New staff start off. This is read on every app load via
-- fetchCurrentStaffMembership -> useCurrentAccount, then consumed by
-- src/lib/walkthroughs/marketingWalkthrough.tsx (auto-start) and
-- src/components/MarketingCampaignBanner (the replay banner).

alter table public.lng_staff_members
  add column if not exists marketing_walkthrough_enabled boolean not null default false;

comment on column public.lng_staff_members.marketing_walkthrough_enabled is
  'When true, this staff member sees the marketing-content walkthrough (auto-start + Schedule banner). Allowlist: defaults false, an admin opts each staff member in.';
