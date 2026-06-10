# Slice — Clinic closures / blocked dates

**Status:** Built, shadow-verified, awaiting production rollout
**Phase:** Cross-cutting (availability)
**Migrations (this slice):** `20260610000004_lng_closures.sql`, `20260610000005_lng_closure_range.sql` (range upsert + bulk delete RPCs)

**Add UI:** single day or date range (toggle), multi-select booking-type tiles (whole clinic supersedes the in-person types; virtual independent). A range is stored as one `lng_closures` row per date and shown grouped back into a single range row.

**Touched files:**
- `supabase/migrations/20260610000004_lng_closures.sql` — table, `lng_is_closed`, `lng_add_closure`/`lng_delete_closure`, closure gate in `lng_booking_check_conflict`, guard in `lng_virtual_available_slots`, overlap-guard ignores `closed`
- `supabase/functions/calendly-webhook/index.ts` — logs a system failure when a Calendly booking lands on a closed date
- `src/lib/queries/closures.ts` — read hook + add/delete
- `src/routes/AdminClosuresTab.tsx` + `src/routes/Admin.tsx` — new "Closures" admin tab
- `src/components/ConflictBlock/ConflictBlock.tsx`, `src/lib/queries/rescheduleAppointment.ts` — staff-facing `closed` message + type

---

## 1. User story

> As an admin, when we're on holiday or the clinic is closed, I block out the date so no one can book it — on the public widgets, reschedule, self-serve, or Checkpoint. I can close the whole clinic for a day, or just one booking type. Virtual impressions run off a separate team, so closing the clinic doesn't touch them; I close those separately if their team is off too. Customers never see why a date is unavailable, just that it is.

---

## 2. The model

- A closure is **whole-day**. `lng_closures(closed_date, service_type, reason)`.
- `service_type = NULL` → **whole clinic**: blocks every in-person type, but **not** `virtual_impression_appointment` (a separate team / calendar).
- `service_type = <value>` → just that type (including an explicit virtual closure).
- `reason` is **admin-only** and never reaches a customer surface.
- One rule, `lng_is_closed(service_type, date)`, drives every enforcement point.

**Enforcement (defense in depth):**
1. `lng_booking_check_conflict` emits a `closed` row → every in-person slot scanner (calls it per candidate) returns no slots; both date pickers (delegate to the scanners) drop the day; every create/reschedule path (calls it pre-insert) refuses.
2. `lng_virtual_available_slots` early-returns on an explicit virtual closure → virtual slot + date pickers drop the day.
3. The `lng_appointments` overlap guard **ignores** `closed`, so closing a date never breaks managing a booking already on it.
4. Calendly (no pre-insert check; availability lives in Calendly) → the webhook logs a `lng_system_failures` warning if a booking lands on a closed date.

---

## 3. Smoke test (plain English)

1. Admin → **Closures**. Add a closure for a date, scope **Whole clinic (in-person)**, reason "Bank holiday". It appears under Upcoming.
2. On the public widget, that date is no longer offerable for any in-person service (greyed in the date picker; no slots). Reschedule, self-serve, Lounge New Booking, and Checkpoint all refuse it too.
3. Virtual impressions on that date are **still bookable** (whole-clinic closure doesn't touch them).
4. Add a **Virtual impressions** closure for a date → virtual is now blocked that day; in-person is unaffected.
5. A booking that already exists on a now-closed date is untouched; staff can still mark it arrived / complete (the overlap guard ignores `closed`).
6. A staff booking attempt on a closed date shows "The clinic is closed on this date." (ConflictBlock). The customer widget only shows the generic "slot unavailable" — never the reason.
7. Remove the closure → the date is bookable again everywhere.
8. (Edge) A Calendly booking that lands on a closed date is saved (we can't refuse Calendly) and raises a warning in Admin → Failures.

---

## 4. Shadow verification done

- `lng_is_closed` rule matrix (6 cases) passes: whole-clinic blocks in-person, not virtual; explicit virtual blocks only virtual; no closure = open.
- `lng_booking_check_conflict` emits `closed` for in-person on a whole-clinic closure, and **not** for virtual on a whole-clinic closure.
- Migration applies cleanly; no leftover rows.
- (Shadow has no seed locations, so a live positive slot-count delta isn't demonstrable there; the scanner behaviour follows by construction from the checker result, which is verified.)

---

## 5. Production rollout (pending approval)

1. `psql "$LNG_MERIDIAN_DB_URL" -f supabase/migrations/20260610000004_lng_closures.sql`
2. `npx supabase functions deploy calendly-webhook --project-ref npuvhxakffxqoszytkxw`
3. Commit + push frontend (Vercel production deploy).

Widget create/reschedule edge functions need **no** redeploy — they call `lng_booking_check_conflict` at runtime, so they pick up the closure gate as soon as the migration lands.
