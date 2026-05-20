-- 20260520000001_lng_visit_shipped_modern_style.sql
--
-- Bring the visit_shipped (order dispatched) email body into line
-- with the May 2026 transactional-email style every other Lounge
-- template now uses:
--
--   * ## H2 heading anchored on the most important fact (the
--     tracking number), same way the appointment confirmation /
--     reschedule templates anchor on the date.
--   * [button:...]({{trackingUrl}}) primary CTA so tapping
--     "Track your parcel" lands directly on the DPD page,
--     mirrors the "Join your appointment" CTA on virtual
--     templates and the "Reschedule or cancel" CTA on the
--     post-arrival templates.
--   * --- horizontal rules between sections so the eye groups
--     "what's being sent" / "delivery address" / "reference"
--     as three distinct blocks rather than a wall of bold labels.
--   * "See you soon, / The Venneir Team" sign-off (Title case
--     "Team") so the family voice across every send-* surface
--     reads as one team, not three.
--
-- Updates both subject + body + default_subject + default_body_syntax
-- so resetting to default lands on the new copy.
--
-- Guarded with WHERE clauses that target only the LEGACY body
-- (the one with "**Track your parcel**" as a plain label rather
-- than a button) so any admin-edited override that's already on
-- the modern shape (or one we don't recognise) is left alone.
--
-- Rollback at the bottom.

update public.lng_email_templates
   set
     subject = 'Your order is on its way',
     default_subject = 'Your order is on its way',
     body_syntax = $body$Hi {{patientFirstName}},

Great news, your order has been dispatched and is on its way to you.

## {{trackingNumber}}

[button:Track your parcel|#0D9488|#FFFFFF|999|20|8]({{trackingUrl}})

---

**What is being sent**

{{itemsList}}

---

**Delivery address**

{{shippingAddress}}

---

Reference: {{dispatchRef}}

If you have any questions, just reply to this email.

See you soon,
The Venneir Team$body$,
     default_body_syntax = $body$Hi {{patientFirstName}},

Great news, your order has been dispatched and is on its way to you.

## {{trackingNumber}}

[button:Track your parcel|#0D9488|#FFFFFF|999|20|8]({{trackingUrl}})

---

**What is being sent**

{{itemsList}}

---

**Delivery address**

{{shippingAddress}}

---

Reference: {{dispatchRef}}

If you have any questions, just reply to this email.

See you soon,
The Venneir Team$body$
 where key = 'visit_shipped'
   -- Only touch the row whose body still uses the legacy
   -- "**Track your parcel**" plain-bold label. Once an admin
   -- has dropped the [button:...] syntax in, the body will no
   -- longer match this clause and the override stays untouched.
   and body_syntax like '%**Track your parcel**%';

-- ── Rollback ───────────────────────────────────────────────────────────────
-- The previous shape lives in 20260512000011_lng_visit_shipped_tracking_link.sql
-- — re-apply that migration to roll back this one.
