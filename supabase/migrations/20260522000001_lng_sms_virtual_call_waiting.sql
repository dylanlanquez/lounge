-- 20260522000001_lng_sms_virtual_call_waiting.sql
--
-- New SMS template `virtual_call_waiting`. Fired by reception from
-- the AppointmentDetail page when the clinician is on the Meet
-- call but the patient hasn't joined yet. The body carries the
-- meeting join URL so the patient can tap straight in from their
-- phone, plus the appointment time so the reminder reads like the
-- continuation of the day-of reminder they already received.
--
-- Single General row (service_type = null). The send surface lives
-- on the AppointmentDetail page and is shown only when the booking
-- carries a join_url, so we don't need a per-service override row
-- to constrain visibility — that's enforced UI-side instead.
--
-- New variable {{joinUrl}} resolves to lng_appointments.join_url at
-- send time; see send-visit-ready-sms's variable resolver in the
-- same slice.
--
-- Rollback:
--   delete from public.lng_sms_templates
--    where key = 'virtual_call_waiting' and service_type is null;

insert into public.lng_sms_templates (key, service_type, body, default_body, description)
values (
  'virtual_call_waiting',
  null,
  'Hi {{patientFirstName}}, your clinician at {{clinicName}} is on the call now waiting for your {{apptTime}} virtual appointment. Tap to join: {{joinUrl}}',
  'Hi {{patientFirstName}}, your clinician at {{clinicName}} is on the call now waiting for your {{apptTime}} virtual appointment. Tap to join: {{joinUrl}}',
  '"Patient not on the call" — manually fired from the virtual appointment page when the clinician is on the meeting and the patient has not joined. Carries the join URL so the patient can tap straight into the call.'
)
on conflict (key, service_type) do nothing;
