# Slice — Orders a voice call is about

**Status:** Built, type-checked, linted, unit-tested, verified in the browser against Meridian data. **Migration not yet applied** — see section 6.
**Phase:** Cross-cutting (new-booking sheet, appointment page, appointment timeline). Fourth voice-call slice.
**Migration (this slice):** `20261002_01_lng_appointment_shopify_order_links.sql` (written, pending shadow then Meridian)

**Touched files:**
- `supabase/migrations/20261002_01_lng_appointment_shopify_order_links.sql` — `lng_appointment_shopify_order_links`, staff RLS, unique per (appointment, order)
- `src/lib/queries/appointmentShopifyOrderLinks.ts` — `useAppointmentShopifyOrderLinks`, `linkShopifyOrdersToAppointment`, `unlinkShopifyOrderFromAppointment`, `orderTotalToPence`
- `src/lib/queries/appointmentShopifyOrderLinks.test.ts` — pence conversion + status-label unit tests
- `src/components/ShopifyOrderPicker/ShopifyOrderPicker.tsx` — the multi-select list, shared by both surfaces
- `src/components/NewBookingSheet/NewBookingSheet.tsx` — the picker under Service on voice-call bookings; links written after the appointment row commits
- `src/routes/AppointmentDetail.tsx` — `LinkedOrdersCard`: view, attach, remove
- `src/lib/queries/appointmentTimeline.ts` — `appointment_shopify_order_linked` / `_unlinked` timeline entries

---

## 1. User story

> As a voice call agent booking a call, I pick the patient and then, right under the service, I see that patient's venneir.com orders. I tick the one (or several) the call is about, or leave them all unticked. If the patient has never bought anything, I see nothing at all. Later, on the appointment page, I can attach another order or take one off, and the timeline records who did it and when.

---

## 2. The model, and what this is not

`lng_appointments.shopify_order_*` already exists and means one specific thing: the customer paid online and that amount **credits against the in-clinic bill at checkout**. That is why the booking sheet only offers it on `same_day_appliance` / `click_in_veneers` — attaching a credit to a service with no bill was a real bug (see the comment on `NewBookingSheet.isShopifyService`).

`lng_appointment_shopify_order_links` is deliberately not that. A row is a **reference link**: "this call is about this order". Many per appointment, zero is normal. It never reaches Pay, reports, the manage page or emails, and no money moves. The UI copy says so on both surfaces.

`shopify_order_name`, `total_price_pence` and `currency` are snapshotted at link time so the row still renders if Shopify changes or the reading staff member has no `shopify_orders` access.

## 3. Where the orders come from

`usePatientShopifyOrders` (the existing `lng_patient_shopify_orders` RPC, already powering the Patient Profile card). No new lookup, no order-number typing: the agent picks from a list, so a typo cannot attach the wrong order.

## 4. Audit

Every link and unlink writes a `patient_events` row (`appointment_shopify_order_linked` / `appointment_shopify_order_unlinked`) carrying `appointment_id`, `shopify_order_id` and `shopify_order_name`, with the actor account. The appointment timeline renders these as "Order attached" / "Order removed" with the order name. The row itself also carries `linked_at` and `linked_by_account_id`. Unlink is a hard delete; `patient_events` is the history.

## 5. Smoke test, in plain English

1. Open the schedule, switch to Voice calls, tap the new-call button.
2. Search a patient who has venneir.com orders and pick them. A section titled **Orders this call is about** appears directly under Service, listing each order with its number, total, date, status and items.
3. Pick a patient with no orders. The section is not there at all, heading included.
4. Tick one order, book the call. Open the new appointment: the **Orders this call is about** card lists it with a working "View in Shopify" link.
5. Tap **Attach an order**, tick a second, tap Attach. Both now list. Tap Remove on one. It goes.
6. Open the appointment timeline. "Order attached" and "Order removed" entries carry the order number and the staff member's name.
7. Open a non-voice-call appointment with no links. No card.
8. Turn the network off mid-attach: the card shows a red line saying the orders were not attached. Nothing is silently lost.

## 6. Still to do

- Apply the migration: shadow (`vkgghplhykavklevfhkz`) first, verify, then Meridian (`npuvhxakffxqoszytkxw`). Until then the card degrades to "No orders attached" on read and fails loudly on write (verified: "Could not find the table 'public.lng_appointment_shopify_order_links' in the schema cache").
- Playwright E2E covering steps 2, 4 and 5 once the table exists.
