-- 20260517000014_lng_email_strip_reply_seed_virtual.sql
--
-- Two coordinated changes on top of M13.
--
-- 1. Strips the "Just reply to this email and we'll find another
--    time / we'll get you back on the schedule" copy from every
--    template body and replaces it with a {{manageUrl}} link, which
--    is the self-serve route the patient should take anyway. Email
--    inboxes aren't the right place to ask staff to step in when
--    the patient can fix it themselves. Affects every General row
--    AND every service-typed override seeded in M13.
--
-- 2. Pre-seeds Virtual impression service-typed overrides so the
--    Virtual impression pill in Admin > Emails opens its dropdowns
--    directly — no "Customise" click. Four rows seeded at
--    service_type='virtual_impression_appointment':
--      * booking_confirmation_virtual
--      * booking_reschedule_virtual
--      * booking_cancellation       (no _virtual variant; shared key)
--      * appointment_reminder_virtual
--
-- The DO block loops over (service_type, label-placeholder) tuples
-- and re-upserts every body using one canonical template per key.
-- Re-running this rewrites every targeted row to the clean
-- baseline; the per-service subjects vary so each booking type's
-- email is recognisable in the inbox.

do $$
declare
  -- Per-service display label that lands in the body. Picked so
  -- each pill's rendered email mirrors the booking type's name on
  -- the schedule + manage page. Includes a slot for the virtual
  -- variant even though the actual labels are interpolated from
  -- the appointment row by the edge function.
  v_service     text;
  v_label_html  text;   -- the {{…}} that renders the service line
  v_subj_word   text;   -- the word that replaces "your" in subjects

  -- Service catalogue iterated below. service_type is the value
  -- written to lng_email_templates.service_type; label_word is the
  -- noun used in subject lines + body openings ("your click-in
  -- veneers appointment" etc.).
  v_specs jsonb := jsonb_build_array(
    jsonb_build_object(
      'service_type', 'click_in_veneers',
      'label',        '**{{sameDayServiceLabel}}**',
      'subj_word',    'click-in veneers'
    ),
    jsonb_build_object(
      'service_type', 'same_day_appliance',
      'label',        '**{{sameDayServiceLabel}}**',
      'subj_word',    'same-day'
    ),
    jsonb_build_object(
      'service_type', 'denture_repair',
      'label',        '{{dentureRepairTable}}',
      'subj_word',    'denture repair'
    ),
    jsonb_build_object(
      'service_type', 'impression_appointment',
      'label',        '**{{inPersonImpressionLabel}}**',
      'subj_word',    'impression'
    )
  );
  v_spec jsonb;
begin
  -- ── General (service_type IS NULL) — universal serviceLabel ───
  update public.lng_email_templates
     set body_syntax = $body$Hi {{patientFirstName}},

Thank you for booking with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

---

**{{serviceLabel}}**

---

**{{locationAddress}}**

---

{{paymentStatusBlock}}

---

**Need to make a change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
         default_body_syntax = body_syntax,
         updated_at = now()
   where key = 'booking_confirmation' and service_type is null;

  update public.lng_email_templates
     set body_syntax = $body$Hi {{patientFirstName}},

We've moved your appointment to a new slot.

## {{appointmentDateTime}}

---

**{{serviceLabel}}**

**{{locationAddress}}**

*Was {{oldAppointmentDateTime}}.*

---

Your existing calendar entry will update automatically. Apple Mail and Outlook pick up the new and old calendar files together, so the old slot disappears and the new one drops in cleanly.

**Need to make another change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
         default_body_syntax = body_syntax,
         updated_at = now()
   where key = 'booking_reschedule' and service_type is null;

  update public.lng_email_templates
     set body_syntax = $body$Hi {{patientFirstName}},

Your appointment with us has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

**{{serviceLabel}}**

**{{locationAddress}}**

---

**Need to rebook?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
         default_body_syntax = body_syntax,
         updated_at = now()
   where key = 'booking_cancellation' and service_type is null;

  update public.lng_email_templates
     set body_syntax = $body$Hi {{patientFirstName}},

A friendly reminder that you have an appointment with us tomorrow.

## {{appointmentDateTime}}

**{{serviceLabel}}**

**{{locationAddress}}**

**Need to make a change?**

{{manageUrl}}

See you soon,
The Venneir Team$body$,
         default_body_syntax = body_syntax,
         updated_at = now()
   where key = 'appointment_reminder' and service_type is null;

  -- ── Virtual variants (General) — strip the reply-to copy too ──
  update public.lng_email_templates
     set body_syntax = $body$Hi {{patientFirstName}},

Your virtual impression appointment is confirmed. We will connect with you online at the time below.

## {{appointmentDateTime}}

**{{serviceLabel}}**

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

No app is needed. The link opens in your browser on any phone, tablet, or computer. Find a well-lit spot and join a couple of minutes before your start time.

Apple Mail and Outlook pick up the attached calendar file automatically.

---

**Need to make a change?**

[Reschedule or cancel your appointment]({{manageUrl}})

Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
         default_body_syntax = body_syntax,
         updated_at = now()
   where key = 'booking_confirmation_virtual' and service_type is null;

  update public.lng_email_templates
     set body_syntax = $body$Hi {{patientFirstName}},

We have moved your virtual impression appointment to a new time.

## {{appointmentDateTime}}

**{{serviceLabel}}**

*Was {{oldAppointmentDateTime}}.*

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

The link above has been updated to your new time. No app is needed — it opens in your browser.

Your existing calendar entry will update automatically. Apple Mail and Outlook pick up the new and old calendar files together, so the old slot disappears and the new one drops in cleanly.

---

**Need to make another change?**

[Reschedule or cancel your appointment]({{manageUrl}})

Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
         default_body_syntax = body_syntax,
         updated_at = now()
   where key = 'booking_reschedule_virtual' and service_type is null;

  update public.lng_email_templates
     set body_syntax = $body$Hi {{patientFirstName}},

A friendly reminder that your virtual impression appointment is tomorrow.

## {{appointmentDateTime}}

**{{serviceLabel}}**

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

This link will be live at your appointment time. No app is needed, just a browser and a well-lit space. Join a couple of minutes early so we can start on time.

**Need to make a change?**

[Reschedule or cancel your appointment]({{manageUrl}})

See you soon,
The Venneir Team$body$,
         default_body_syntax = body_syntax,
         updated_at = now()
   where key = 'appointment_reminder_virtual' and service_type is null;

  -- ── Non-virtual service-typed overrides (re-upsert all 16) ───
  for v_spec in select * from jsonb_array_elements(v_specs)
  loop
    v_service    := v_spec->>'service_type';
    v_label_html := v_spec->>'label';
    v_subj_word  := v_spec->>'subj_word';

    -- booking_confirmation
    insert into public.lng_email_templates (key, service_type, subject, body_syntax, default_subject, default_body_syntax, version, enabled)
    values (
      'booking_confirmation', v_service,
      'Your ' || v_subj_word || ' appointment is confirmed',
      format($body$Hi {{patientFirstName}},

Thank you for booking your %s appointment with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

---

%s

---

**{{locationAddress}}**

---

{{paymentStatusBlock}}

---

**Need to make a change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$, v_subj_word, v_label_html),
      'Your ' || v_subj_word || ' appointment is confirmed',
      format($body$Hi {{patientFirstName}},

Thank you for booking your %s appointment with us. We're looking forward to seeing you.

## {{appointmentDateTime}}

---

%s

---

**{{locationAddress}}**

---

{{paymentStatusBlock}}

---

**Need to make a change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$, v_subj_word, v_label_html),
      1, true
    )
    on conflict (key, service_type) do update
       set subject = excluded.subject,
           body_syntax = excluded.body_syntax,
           default_subject = excluded.default_subject,
           default_body_syntax = excluded.default_body_syntax,
           updated_at = now();

    -- booking_reschedule
    insert into public.lng_email_templates (key, service_type, subject, body_syntax, default_subject, default_body_syntax, version, enabled)
    values (
      'booking_reschedule', v_service,
      'Your ' || v_subj_word || ' appointment has moved',
      format($body$Hi {{patientFirstName}},

We've moved your %s appointment to a new slot.

## {{appointmentDateTime}}

---

%s

**{{locationAddress}}**

*Was {{oldAppointmentDateTime}}.*

---

Your existing calendar entry will update automatically.

**Need to make another change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$, v_subj_word, v_label_html),
      'Your ' || v_subj_word || ' appointment has moved',
      format($body$Hi {{patientFirstName}},

We've moved your %s appointment to a new slot.

## {{appointmentDateTime}}

---

%s

**{{locationAddress}}**

*Was {{oldAppointmentDateTime}}.*

---

Your existing calendar entry will update automatically.

**Need to make another change?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$, v_subj_word, v_label_html),
      1, true
    )
    on conflict (key, service_type) do update
       set subject = excluded.subject,
           body_syntax = excluded.body_syntax,
           default_subject = excluded.default_subject,
           default_body_syntax = excluded.default_body_syntax,
           updated_at = now();

    -- booking_cancellation
    insert into public.lng_email_templates (key, service_type, subject, body_syntax, default_subject, default_body_syntax, version, enabled)
    values (
      'booking_cancellation', v_service,
      'Your ' || v_subj_word || ' appointment is cancelled',
      format($body$Hi {{patientFirstName}},

Your %s appointment has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

%s

**{{locationAddress}}**

---

**Need to rebook?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$, v_subj_word, v_label_html),
      'Your ' || v_subj_word || ' appointment is cancelled',
      format($body$Hi {{patientFirstName}},

Your %s appointment has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

%s

**{{locationAddress}}**

---

**Need to rebook?**

{{manageUrl}}

Booking Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$, v_subj_word, v_label_html),
      1, true
    )
    on conflict (key, service_type) do update
       set subject = excluded.subject,
           body_syntax = excluded.body_syntax,
           default_subject = excluded.default_subject,
           default_body_syntax = excluded.default_body_syntax,
           updated_at = now();

    -- appointment_reminder
    insert into public.lng_email_templates (key, service_type, subject, body_syntax, default_subject, default_body_syntax, version, enabled)
    values (
      'appointment_reminder', v_service,
      'Reminder: your ' || v_subj_word || ' appointment is tomorrow',
      format($body$Hi {{patientFirstName}},

A friendly reminder that your %s appointment is tomorrow.

## {{appointmentDateTime}}

%s

**{{locationAddress}}**

**Need to make a change?**

{{manageUrl}}

See you soon,
The Venneir Team$body$, v_subj_word, v_label_html),
      'Reminder: your ' || v_subj_word || ' appointment is tomorrow',
      format($body$Hi {{patientFirstName}},

A friendly reminder that your %s appointment is tomorrow.

## {{appointmentDateTime}}

%s

**{{locationAddress}}**

**Need to make a change?**

{{manageUrl}}

See you soon,
The Venneir Team$body$, v_subj_word, v_label_html),
      1, true
    )
    on conflict (key, service_type) do update
       set subject = excluded.subject,
           body_syntax = excluded.body_syntax,
           default_subject = excluded.default_subject,
           default_body_syntax = excluded.default_body_syntax,
           updated_at = now();
  end loop;

  -- ── Virtual impression overrides — 4 rows ────────────────────
  insert into public.lng_email_templates (key, service_type, subject, body_syntax, default_subject, default_body_syntax, version, enabled)
  values
    ('booking_confirmation_virtual', 'virtual_impression_appointment',
     'Your virtual impression appointment is confirmed',
     $body$Hi {{patientFirstName}},

Your virtual impression appointment is confirmed. We will connect with you online at the time below.

## {{appointmentDateTime}}

**{{virtualImpressionLabel}}**

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

No app is needed. The link opens in your browser on any phone, tablet, or computer. Find a well-lit spot and join a couple of minutes before your start time.

Apple Mail and Outlook pick up the attached calendar file automatically.

---

**Need to make a change?**

[Reschedule or cancel your appointment]({{manageUrl}})

Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
     'Your virtual impression appointment is confirmed',
     $body$Hi {{patientFirstName}},

Your virtual impression appointment is confirmed. We will connect with you online at the time below.

## {{appointmentDateTime}}

**{{virtualImpressionLabel}}**

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

No app is needed. The link opens in your browser on any phone, tablet, or computer. Find a well-lit spot and join a couple of minutes before your start time.

Apple Mail and Outlook pick up the attached calendar file automatically.

---

**Need to make a change?**

[Reschedule or cancel your appointment]({{manageUrl}})

Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
     1, true),
    ('booking_reschedule_virtual', 'virtual_impression_appointment',
     'Your virtual impression appointment has moved',
     $body$Hi {{patientFirstName}},

We have moved your virtual impression appointment to a new time.

## {{appointmentDateTime}}

**{{virtualImpressionLabel}}**

*Was {{oldAppointmentDateTime}}.*

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

The link above has been updated to your new time. No app is needed — it opens in your browser.

Your existing calendar entry will update automatically.

---

**Need to make another change?**

[Reschedule or cancel your appointment]({{manageUrl}})

Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
     'Your virtual impression appointment has moved',
     $body$Hi {{patientFirstName}},

We have moved your virtual impression appointment to a new time.

## {{appointmentDateTime}}

**{{virtualImpressionLabel}}**

*Was {{oldAppointmentDateTime}}.*

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

The link above has been updated to your new time. No app is needed — it opens in your browser.

Your existing calendar entry will update automatically.

---

**Need to make another change?**

[Reschedule or cancel your appointment]({{manageUrl}})

Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
     1, true),
    ('booking_cancellation', 'virtual_impression_appointment',
     'Your virtual impression appointment is cancelled',
     $body$Hi {{patientFirstName}},

Your virtual impression appointment has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

**{{virtualImpressionLabel}}**

---

**Need to rebook?**

[Reschedule or rebook]({{manageUrl}})

Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
     'Your virtual impression appointment is cancelled',
     $body$Hi {{patientFirstName}},

Your virtual impression appointment has been cancelled. Your calendar will update automatically.

## {{appointmentDateTime}}

**{{virtualImpressionLabel}}**

---

**Need to rebook?**

[Reschedule or rebook]({{manageUrl}})

Reference: {{appointmentRef}}

See you soon,
The Venneir Team$body$,
     1, true),
    ('appointment_reminder_virtual', 'virtual_impression_appointment',
     'Reminder: your virtual impression appointment is tomorrow',
     $body$Hi {{patientFirstName}},

A friendly reminder that your virtual impression appointment is tomorrow.

## {{appointmentDateTime}}

**{{virtualImpressionLabel}}**

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

This link will be live at your appointment time. No app is needed, just a browser and a well-lit space. Join a couple of minutes early so we can start on time.

**Need to make a change?**

[Reschedule or cancel your appointment]({{manageUrl}})

See you soon,
The Venneir Team$body$,
     'Reminder: your virtual impression appointment is tomorrow',
     $body$Hi {{patientFirstName}},

A friendly reminder that your virtual impression appointment is tomorrow.

## {{appointmentDateTime}}

**{{virtualImpressionLabel}}**

[button:Join your appointment|#0D9488|#FFFFFF|999|20|8]({{joinMeetingUrl}})

This link will be live at your appointment time. No app is needed, just a browser and a well-lit space. Join a couple of minutes early so we can start on time.

**Need to make a change?**

[Reschedule or cancel your appointment]({{manageUrl}})

See you soon,
The Venneir Team$body$,
     1, true)
  on conflict (key, service_type) do update
     set subject = excluded.subject,
         body_syntax = excluded.body_syntax,
         default_subject = excluded.default_subject,
         default_body_syntax = excluded.default_body_syntax,
         updated_at = now();
end $$;
