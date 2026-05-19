-- 20260519000015_lng_manager_notification_template_and_settings.sql
--
-- Seeds the "manager_notification" email template plus the
-- lng_settings key that holds the list of accounts who should be
-- notified.
--
-- The notification fires after a cashier has actioned something that
-- previously required a manager picker on the cart sheet:
--   * discount applied / amended / removed
--   * partial or full refund issued
--   * payment voided (a full-amount refund under the hood today)
--
-- Variables exposed to the template editor:
--
--   {{actionTitle}}   Human heading for the action, e.g.
--                     "Discount applied", "Refund issued",
--                     "Payment voided".
--   {{actionSummary}} One-line summary, e.g. "£25.00 discount
--                     applied to LAP-00042".
--   {{amount}}        Formatted GBP amount, e.g. "£25.00".
--   {{reason}}        The free-text reason the cashier typed.
--   {{patientName}}   Patient on the visit, e.g. "Sarah Henderson".
--   {{visitRef}}      LAP reference of the appointment, e.g.
--                     "LAP-00042". Empty if intake hasn't stamped
--                     one yet.
--   {{staffName}}     The cashier who processed it.
--   {{managerName}}   The recipient's first + last name (per-send).
--   {{processedAt}}   Date + time in the clinic's locale.
--   {{visitUrl}}      Deep-link back to the visit page.
--
-- The default copy is intentionally plain: a heading, a one-line
-- summary, a labelled list, a button-style CTA back to the visit.
-- Admins can rewrite it freely.
--
-- Rollback at the bottom.

-- ── 1. lng_email_templates row ─────────────────────────────────────────────

insert into public.lng_email_templates (
  key, service_type, subject, body_syntax,
  default_subject, default_body_syntax, version, enabled, description
) values (
  'manager_notification',
  null,
  'Manager notification: {{actionTitle}} for {{patientName}}',
  $body$Hi {{managerName}},

A manager notification has been logged at the Lounge.

## {{actionTitle}}

{{actionSummary}}

---

**Amount**
{{amount}}

**Reason**
{{reason}}

**Patient**
{{patientName}}

**Visit**
{{visitRef}}

**Processed by**
{{staffName}}

**Time**
{{processedAt}}

---

[button:Open visit]({{visitUrl}})

This notification is for your records. No action is required.

The Venneir Team$body$,
  'Manager notification: {{actionTitle}} for {{patientName}}',
  $body$Hi {{managerName}},

A manager notification has been logged at the Lounge.

## {{actionTitle}}

{{actionSummary}}

---

**Amount**
{{amount}}

**Reason**
{{reason}}

**Patient**
{{patientName}}

**Visit**
{{visitRef}}

**Processed by**
{{staffName}}

**Time**
{{processedAt}}

---

[button:Open visit]({{visitUrl}})

This notification is for your records. No action is required.

The Venneir Team$body$,
  1,
  true,
  'Sent to each configured manager whenever a cashier processes an action that previously needed manager sign-off (discounts, refunds, voids). Edit the recipient list above; this row controls the copy.'
)
on conflict (key, service_type) do nothing;

-- ── 2. lng_settings recipient list ─────────────────────────────────────────

insert into public.lng_settings (location_id, key, value, description)
values (
  null,
  'manager_notifications.recipient_account_ids',
  '[]'::jsonb,
  'JSONB array of accounts.id values. Each listed manager receives the manager_notification email whenever a cashier applies, amends, or removes a discount, issues a refund, or voids a payment. Managed from Admin → Emails → General → Manager notifications.'
)
on conflict (key) where location_id is null do nothing;

-- ── Rollback ───────────────────────────────────────────────────────────────
-- DELETE FROM public.lng_settings
--  WHERE key = 'manager_notifications.recipient_account_ids' AND location_id IS NULL;
-- DELETE FROM public.lng_email_templates
--  WHERE key = 'manager_notification' AND service_type IS NULL;
