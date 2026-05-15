-- send-appointment-sms-reminders (new cron edge function) needs an
-- idempotency stamp so a re-fired sweep doesn't double-text a
-- patient. Same shape as reminder_sent_at (for the email path) —
-- separate column so SMS and email can be sent independently and
-- their state diverges cleanly (e.g. email sends fine, SMS API
-- returns 4xx — only email gets stamped, SMS retries next sweep).

ALTER TABLE lng_appointments
  ADD COLUMN sms_reminder_sent_at timestamptz;

COMMENT ON COLUMN lng_appointments.sms_reminder_sent_at IS
  'Timestamp the 24h-before SMS reminder was sent via Twilio. NULL until send-appointment-sms-reminders successfully dispatches; set once per appointment. Separate from reminder_sent_at (email) so the two channels stamp independently.';
