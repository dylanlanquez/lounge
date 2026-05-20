-- 20260520000013_lng_undo_pre_launch_no_show_backfill.sql
--
-- Reverses the one-shot lng_pre_launch_no_show_backfill() RPC.
--
-- Why: stamping every pre-launch Calendly row as status='no_show'
-- kept reports clean, but bled into staff workflows everywhere else
-- (the action sheet still offered "Reverse no-show", audit trails
-- read as if staff actively flipped the patient, every legacy row
-- looked like a real no-show forever). The replacement approach
-- leaves the data untouched and surfaces "pre-launch" purely in the
-- UI via a banner on the AppointmentDetail page + an auto floor on
-- reports' start dates at lng_settings.lounge.launch_date.
--
-- Targets only rows the backfill RPC wrote. The sentinel string is
-- the exact text the function stamped on every flipped row (see
-- 20260517000001_lng_pre_launch_no_show_backfill.sql line 82). No
-- real no-show would carry that exact free-text reason: staff pick
-- from the NoShowReason enum (did_not_turn_up / patient_cancelled_late
-- / clinic_cancelled / other) or type a custom "Other" note.
--
-- After this migration the launch_date setting row stays in place
-- (the new banner + report-range clamp both read it). Do NOT remove
-- the lng_settings row.

update public.lng_appointments
   set status        = 'booked',
       cancel_reason = null
 where status = 'no_show'
   and cancel_reason = 'Pre-Lounge launch backfill, not a real no-show';

drop function if exists public.lng_pre_launch_no_show_backfill();

-- ── Rollback ───────────────────────────────────────────────────────
-- There is no clean rollback. The original RPC's source is still
-- preserved in 20260517000001_lng_pre_launch_no_show_backfill.sql if
-- it needs to be re-created; the rows it flipped are now back to
-- 'booked' and can't be distinguished from any other booked legacy
-- row, so a re-run with the same launch_date would re-flip them.
