-- 20260521000003_lng_email_no_show_late_arrival_line.sql
--
-- Adds a "running late, don't worry" reassurance to every
-- appointment_no_show row, slotted right under the appointment
-- time/address block.
--
-- Rationale: staff sometimes flip an appointment to no-show a beat
-- early. Pairing the "we missed you" tone with a softer "if you're
-- still on your way, no panic" line means a patient who reads the
-- email while walking through the door (or just clicking back into
-- the Meet) doesn't think the slot is closed off.
--
-- Two copy variants:
--   * In-person (General, click_in_veneers, same_day_appliance,
--     denture_repair, impression_appointment): "We'll do our best
--     to get you in today."
--   * Virtual (virtual_impression_appointment): direct the patient
--     back to their original Meet link.
--
-- Idempotent: replaces by anchoring on the existing structure
-- (**{{locationAddress}}** or **{{serviceLabel}}** for virtual,
-- followed by the --- separator). Re-running after admin edits
-- would clobber any customisations downstream of the insertion
-- point — that's the intended re-seed behaviour.

-- ── In-person rows (5: General + 4 service-typed) ───────────────
update public.lng_email_templates
   set body_syntax = regexp_replace(
         body_syntax,
         E'\\*\\*\\{\\{locationAddress\\}\\}\\*\\*\n\n---',
         E'**{{locationAddress}}**\n\nIf you''re still on your way and running a little behind, don''t worry. We''ll do our best to get you in today.\n\n---',
         'g'
       ),
       default_body_syntax = regexp_replace(
         default_body_syntax,
         E'\\*\\*\\{\\{locationAddress\\}\\}\\*\\*\n\n---',
         E'**{{locationAddress}}**\n\nIf you''re still on your way and running a little behind, don''t worry. We''ll do our best to get you in today.\n\n---',
         'g'
       ),
       updated_at = now()
 where key = 'appointment_no_show'
   and (service_type is null
        or service_type in ('click_in_veneers',
                            'same_day_appliance',
                            'denture_repair',
                            'impression_appointment'));

-- ── Virtual row ──────────────────────────────────────────────────
-- The virtual body has no locationAddress block; the anchor is the
-- serviceLabel line immediately above the --- separator.
update public.lng_email_templates
   set body_syntax = regexp_replace(
         body_syntax,
         E'\\*\\*\\{\\{serviceLabel\\}\\}\\*\\*\n\n---',
         E'**{{serviceLabel}}**\n\nIf you''re running a few minutes late joining the call, click your original meeting link and we''ll do our best to reconnect.\n\n---',
         'g'
       ),
       default_body_syntax = regexp_replace(
         default_body_syntax,
         E'\\*\\*\\{\\{serviceLabel\\}\\}\\*\\*\n\n---',
         E'**{{serviceLabel}}**\n\nIf you''re running a few minutes late joining the call, click your original meeting link and we''ll do our best to reconnect.\n\n---',
         'g'
       ),
       updated_at = now()
 where key = 'appointment_no_show'
   and service_type = 'virtual_impression_appointment';
