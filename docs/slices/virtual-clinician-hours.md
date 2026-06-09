# Slice — Virtual clinician hours & availability

**Status:** Built, shadow-verified, awaiting production rollout
**Phase:** Cross-cutting (extends the virtual-impression + meet-hosts work)
**Depends on:**
- `lng_meet_hosts` (migration `20260512000013`) and `lng_appointments.meet_host_id`
- `virtual_impression_appointment` service type (migration `20260504000001`)
- The slot scanners (`20260525000001`) and conflict checker (`20260523000003`)

**New migrations (this slice):**
- `20260609000001_lng_meet_host_hours.sql` — `lng_meet_host_hours`, `lng_meet_host_overrides`, `lng_meet_hosts.self_serve`, `lng_meet_hosts_available()`, admin write RPCs
- `20260609000002_lng_virtual_slot_scanners.sql` — host-aware virtual branch in both slot scanners + `lng_virtual_available_slots()` (adds `p_meet_host_id` to `lng_booking_available_slots`)
- `20260609000003_lng_virtual_host_overlap_guard.sql` — `zz_virtual_host_overlap_guard` constraint trigger
- `20260609000004_lng_conflict_joined_status_restore.sql` — restores `joined` to the conflict checker's active set (separable bug fix)

**Related docs:** `docs/01-architecture-decision.md §6` (ADR-006, resource model), `docs/runbooks/migration-workflow.md`

---

## 1. User story

> As the clinic, I run virtual impression calls with more than one clinician, and they work different hours. Clinician A works weekday mornings; Clinician B is a casual who only picks up the odd shift. I want the booking widget to offer a virtual slot only when a clinician is actually on shift and free, and to allow two concurrent calls when both are working.

> As an admin, in Admin → Services → Meet hosts I set each clinician's weekly hours and add one-off date overrides — "available this Sunday" for a picked-up shift, or "off" for a holiday. A clinician with no hours set is simply not bookable until I set them, so a casual clinician can be left empty and switched on per date.

> As a clinic, some clinicians are special/temp — only used when staff deliberately place a customer with them. I mark them **Staff only**. They never appear in the public widget or in self-serve reschedule; only staff can book a customer with them by choosing them explicitly. A customer can't self-reschedule onto a special clinician's slot.

> As reception, a customer can only do a Sunday. I talk to the special clinician, they can do that Sunday, so I open New Booking, pick that clinician, and the time picker shows their Sunday availability. I book it.

---

## 2. The model (read before the criteria)

**Availability for `virtual_impression_appointment` is driven by per-clinician hours, not clinic hours.** Every other service type is unchanged (clinic / booking-type hours + resource pools).

- **Weekly hours** (`lng_meet_host_hours`): recurring windows per clinician. `day_of_week` 0=Mon..6=Sun, clinic-local. Multiple rows per day = split shifts. No rows for a day = not working.
- **Date overrides** (`lng_meet_host_overrides`): `available` (one-off shift, even with no weekly pattern) or `off` (holiday/sick; whole-day or a slice). Effective windows = weekly + available − off.
- **Self-serve flag** (`lng_meet_hosts.self_serve`, default true): false = special/temp, hidden from all self-serve.
- **Capacity** at any instant = the number of on-shift, free clinicians. Two on shift → two concurrent calls. A clinician can never hold two overlapping virtual calls (DB constraint trigger).
- **Single source of truth**: `lng_meet_hosts_available(start, end, self_serve_only, exclude_appt, host_id)` returns the clinicians who can take an interval. The slot scanners, the booking edge functions, and the host-overlap guard all key off the same rule.

**Who sees whom:**

| Surface | self_serve_only | host filter |
|---|---|---|
| Public widget (create + self-serve reschedule) | true | none |
| Staff New Booking / Reschedule | false | the picked clinician |

Self-serve reschedule of an appointment that's *with* a special clinician is allowed, and reassigns to a general (self-serve) clinician at the new time.

---

## 3. Acceptance criteria

1. A virtual slot appears in the widget only if ≥1 self-serve clinician is on shift and free for it.
2. Two self-serve clinicians on shift at the same time → two concurrent virtual bookings allowed at that time; a third is refused.
3. A clinician with no hours and no overrides is never bookable.
4. A casual clinician with only an `available` override on a date is bookable on that date only.
5. A `Staff only` clinician never appears in the public widget or self-serve reschedule, but staff can book/reschedule a customer onto them by choosing them in the sheet.
6. Staff New Booking: picking a clinician shows that clinician's real availability, including dates/times outside the booking-type hours (e.g. a Sunday override).
7. A clinician can never be double-booked for overlapping virtual calls (DB-enforced, `23P01`).
8. Self-serve reschedule of a special-clinician appointment lands on a general clinician.

---

## 4. Smoke test (plain English → Playwright)

Seed: Clinician A (self-serve) weekly Mon 09:00–12:00; Clinician B (self-serve) weekly Mon 09:00–12:00; Clinician C (staff-only) no weekly hours, `available` override next Sunday 10:00–14:00.

1. **Union + capacity** — Public widget, pick a Monday. Times 09:00–11:30 are offered. Book 10:00 (assigned to A). Re-open the widget for the same Monday 10:00 — still offered (B free). Book it (assigned to B). Re-open 10:00 — no longer offered (both busy).
2. **Off until set** — A clinician with no hours never surfaces; remove A's and B's Monday hours → that Monday shows no virtual times.
3. **Casual on a date** — Public widget shows **no** Sunday times (C is staff-only). In staff New Booking, pick Clinician C → the calendar lets you choose that Sunday and the time list shows 10:00–13:30. Book 11:00 → assigned to C.
4. **Special hidden from self-serve** — C never appears in the widget or in a self-serve reschedule's resulting host.
5. **Self-serve reschedule off a special** — Take the booking with C from step 3, open its self-serve manage link, reschedule to a Monday slot → it lands on A or B (a general clinician), not C.
6. **No double-book** — Two near-simultaneous bookings for the same clinician at the same time: exactly one succeeds; the other gets `slot_unavailable` / falls through to the next clinician.

> The E2E spec lives in `tests/` and requires the migrations applied to the target DB plus seeded hosts/hours. It cannot run against production until the rollout below completes.

---

## 5. Verification done

SQL-level behaviour was verified on the **shadow** DB (all rolled back, no data persisted):
- Availability T1–T7: self-serve hides the special clinician; the staff path reveals it; slot boundaries correct (last Monday 30-min slot is 11:30; last Sunday slot 13:30).
- Guard G1–G3: overlapping same-clinician insert blocked (`23P01`); non-overlapping same-clinician allowed; overlapping different-clinician allowed.
- `joined`-status restored in `lng_booking_check_conflict` (lines confirmed).

Frontend + edge functions: `tsc -b --noEmit` clean; affected unit tests pass.

---

## 6. Production rollout order (important)

The frontend and edge functions call the new RPCs / select `self_serve`, so they must not ship before the migrations land. Safe order:

1. Apply `20260609000001`–`0004` to **Meridian** (shadow already verified). Read the latest Meridian migration first (`/Users/dylan/Documents/Apps/meridian-app/supabase/migrations`). From this point, virtual self-serve availability = host hours, so it is **quiet until hours are entered**.
2. Deploy the frontend and the two edge functions (`widget-create-appointment`, `widget-reschedule-booking`).
3. Enter the real clinicians' hours in Admin → Services → Meet hosts.

To avoid any quiet window, do steps 1–3 in one maintenance window, or pre-seed the current clinician's weekly hours via SQL alongside step 1.

**Behaviour changes introduced:** virtual concurrency goes from unlimited → capped at on-shift clinicians; virtual slots outside every clinician's hours stop appearing. Existing virtual appointments are unaffected (the guard applies going forward).
