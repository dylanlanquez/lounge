-- Track when the shipping notification email was sent for a visit.
-- Null means not yet sent. Used by fill-lng-parcel-code to send the email
-- once parcel_code is confirmed, and to prevent duplicate sends.

ALTER TABLE public.lng_visits
  ADD COLUMN IF NOT EXISTS shipping_email_sent_at timestamptz;
