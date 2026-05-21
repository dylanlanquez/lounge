-- 20260521000001_lng_customer_note.sql
--
-- Splits the customer-typed booking note out of lng_appointments.notes
-- (which was double-duty as the staff customer-service note). Same
-- column was getting whatever the customer typed in the widget AND
-- whatever staff later wrote as their internal CS handoff — so the
-- AppointmentDetail page rendered the customer's "I already paid for
-- the kit, want to confirm I only owe the difference on £399" as if
-- it was a staff-authored CS note, which is confusing on the floor.
--
-- After this:
--   * lng_appointments.notes        — staff customer-service note
--                                      (editable from AppointmentNotesHero).
--   * lng_appointments.customer_note — patient-typed widget note,
--                                      read-only on the staff side.
--
-- Backfill: every row where created_via='widget' AND notes is not
-- null. The widget is the only path that writes a customer-typed
-- note into the column today, so a populated `notes` on a widget
-- row is overwhelmingly the customer's original text (the
-- AppointmentNotesHero edit path on a brand-new widget booking has
-- effectively never been exercised since launch was 24h ago).
-- After this runs the `notes` column on those rows becomes null
-- and staff can layer a proper CS note on top via the existing
-- AppointmentNotesHero — no UX regression because the data is now
-- showing in the right place.

alter table public.lng_appointments
  add column if not exists customer_note text;

comment on column public.lng_appointments.customer_note is
  'Patient-typed note captured during widget booking (free-text input on the Details step). Read-only on the staff side; surfaced in its own CustomerNoteHero on AppointmentDetail/VisitDetail. Distinct from `notes`, which is the staff customer-service handoff note editable via AppointmentNotesHero.';

update public.lng_appointments
   set customer_note = notes,
       notes         = null
 where created_via   = 'widget'
   and notes         is not null
   and customer_note is null;

-- ── Rollback ────────────────────────────────────────────────────────
-- update public.lng_appointments
--    set notes         = coalesce(notes, customer_note),
--        customer_note = null
--  where customer_note is not null;
-- alter table public.lng_appointments drop column if exists customer_note;
