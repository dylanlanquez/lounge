-- 20260520000008_lng_reset_today_invite_state.sql
--
-- One-shot reset. The staff added on 2026-05-20 received Supabase
-- action_link invite emails (the pre-custom-token flow) which mail
-- scanners GET-prefetched, consuming the one-shot tokens before the
-- humans could click. The backfill in 20260520000004 then marked
-- every active staff member as invite_accepted_at = hired_at, which
-- hid the Resend invite button (gated on !invite_accepted_at) and
-- left no recovery path from the UI.
--
-- This migration clears the invite + last_sign_in lifecycle for
-- staff hired on 2026-05-20 so they re-enter the pending bucket. An
-- admin can then click Resend invite on each from Admin > Staff
-- and a fresh /welcome?invite=<uuid> URL goes out via the working
-- custom-token relay (lng-resend-staff-invite + lng-accept-invite).
--
-- Excludes anyone hired before 2026-05-20 — those staff (Dylan,
-- Beth, the super-admin) accepted under the old Supabase flow long
-- before scanners became an issue and are signing in fine. Status
-- filter is kept so deactivated rows are untouched.

update public.lng_staff_members s
   set invite_token        = null,
       invite_sent_at      = null,
       invite_expires_at   = null,
       invite_accepted_at  = null,
       last_sign_in_at     = null
 where s.status = 'active'
   and s.hired_at >= '2026-05-20 00:00:00+00'
   and s.hired_at <  '2026-05-21 00:00:00+00';

-- No event-log row written here — the migration filename itself is
-- the audit trail. lng_event_log inserts require a non-null source +
-- event_type with structured payloads and there's no clean caller
-- identity to attribute this DDL-time reset to.
