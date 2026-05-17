-- lng_staff_members.is_customer_service
--
-- Adds the Customer Service role. A staff member with this flag set
-- (and no admin / super-admin / manager flag) gets a focused view
-- across the app: they can book, reschedule, cancel, and resend
-- confirmation emails — the things a CS agent handles when a patient
-- emails or calls — but lose every "in-clinic" affordance (mark
-- arrived / no-show, cart edits, discounts, payment, print LWO, end
-- visit early, add tech note) because those actions need to be
-- performed by someone physically with the patient.
--
-- Admins flagged as customer_service keep full admin access; the
-- gating client-side checks an `is_cs_only` derived flag rather
-- than this raw column, so dual-role staff (admin + CS) aren't
-- restricted.

alter table public.lng_staff_members
  add column if not exists is_customer_service boolean not null default false;

comment on column public.lng_staff_members.is_customer_service is
  'When TRUE, the staff member is a Customer Service agent. Combined with !is_admin / !is_manager (see useCurrentAccount.is_cs_only) this hides clinic-floor affordances (cart, payment, arrival, no-show, tech notes, print LWO, end visit early) while keeping patient-comms actions (reschedule, cancel, resend, book) available.';

-- Index — UI queries staff lists filtered by role; partial so we
-- only cover rows where the flag is actually set.
create index if not exists lng_staff_members_is_customer_service_idx
  on public.lng_staff_members(is_customer_service)
  where is_customer_service = true;
