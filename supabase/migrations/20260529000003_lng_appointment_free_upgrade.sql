-- ─────────────────────────────────────────────────────────────────────────────
-- Free same-day upgrade flag
--
-- Staff can book a same-day upgrade (appliance / click-in veneers) as
-- "free of charge" — goodwill, a complaint resolution, or a promise
-- already made. This must be a deliberate, accountable decision: it
-- carries a required reason, surfaces loudly on the Lounge appointment +
-- visit, and zeroes the appliance at the till so it's never accidentally
-- charged. Captured by the Checkpoint booker; null/false for everything
-- else (normal paid upgrades, impressions, the customer widget).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.lng_appointments
  add column if not exists free_upgrade boolean not null default false;

alter table public.lng_appointments
  add column if not exists free_upgrade_reason text;

comment on column public.lng_appointments.free_upgrade is
  'True when a same-day upgrade was booked free of charge. Drives the '
  '"Free upgrade" banner on the appointment + visit and zeroes the '
  'appliance at the till. Set only by the Checkpoint booker.';

comment on column public.lng_appointments.free_upgrade_reason is
  'Required short reason captured when free_upgrade is set (e.g. goodwill, '
  'complaint, promised free) — shown on the Lounge booking so a £0 upgrade '
  'is accountable, not a mystery.';
