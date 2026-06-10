# Slice — Schedule booking-type filter

**Status:** Built, awaiting review
**Phase:** Cross-cutting (Schedule UI polish)
**Migrations:** None — pure frontend, reads fields already on `AppointmentRow`.

**Touched files:**
- `src/lib/queries/appointments.ts` — new canonical `appointmentCategory(row)`, `AppointmentCategory` type, `APPOINTMENT_CATEGORY_LABELS`, `APPOINTMENT_CATEGORY_ORDER`
- `src/components/ScheduleFilter/ScheduleFilter.tsx` — new filter pill + popover
- `src/components/ScheduleListView/ScheduleListView.tsx` — row colour bar now keys off `appointmentCategory(row)` so it matches the filter
- `src/routes/Schedule.tsx` — filter state, counts, filtered list, "no matches" empty state, toolbar-pill sizing parity

---

## 1. User story

> As reception, on a busy day I want to see only one kind of booking at a time, or hide a kind I don't care about right now, so I can scan the strip for what I'm working on (e.g. "show me only impressions"). I tap Filter, tick the types I want, and the list narrows. The day header tells me "4 of 11 shown" so I never forget a filter is on.

---

## 2. The model

**One category derivation drives everything.** `appointmentCategory(row)` returns one of the six buckets that line up 1:1 with `theme.category`: `repair`, `sameDay`, `appliance`, `impression`, `virtualImpression`, `consult`. It reads `service_type` first (axis-pinned native / staff bookings), then falls back to parsing `event_type_label` (Calendly). The same function colours the row bar and powers the filter, so a row's bar colour and its filter bucket can never disagree.

- Filter state is a `Set<AppointmentCategory>` of the categories the operator picked to show. The **empty set is the default** "All booking types" state (no filter); a non-empty set narrows the day to just those types.
- State lives in `Schedule.tsx` component state, not the URL — it persists as the operator flicks between days but doesn't leak into a shared link.
- The popover lists **only the types that occur today** (zero-count types are omitted, not dimmed), each with a live count and a category-tinted checkbox.
- Two moves: tick one or more **types** (shows only those), or tick **All booking types** to clear back to the whole day. Unticking the last type also clears back to All.
- "Active" means a type that *exists today* is being hidden — the only state that changes the list. Ticking a type with no bookings today hides everything else; ticking none hides nothing.
- **Safety:** whenever the filter is hiding bookings, a loud accent banner sits above the list — "Filter on. Showing only X. N appointments hidden." with a **Clear filter** button — and the toolbar pill switches to "Filter on" + a count badge. The operator can never be unaware that appointments are hidden.

---

## 3. Smoke test (plain English)

1. Sign in, land on the schedule for a day that has several booking types.
2. The action row shows three matched pills — **Filter**, **Jump to today** (when not on today), **New booking** — all the same height (44px), same pill shape, evenly spaced.
3. Tap **Filter**. A popover opens, right-aligned under the pill. The top row is **All booking types**, ticked by default (nothing else is ticked). Below it, one row per type that occurs today — a category-tinted checkbox, the type name, and today's count. Types with no bookings today are not listed at all.
4. Tick the **Denture repairs** checkbox → the strip instantly shows only repairs (All booking types un-ticks itself). An accent banner appears above the list: "Filter on. Showing only Denture repairs. N appointments hidden." with a **Clear filter** button. The toolbar pill reads "Filter on" with a count badge.
5. Tick a second type → the banner updates to "Showing 2 booking types"; both kinds show.
6. Tap **All booking types** (or **Clear filter** on the banner) → back to the full day; banner and badge clear. Unticking the last ticked type does the same.
7. Tap outside the popover (or press Escape). It closes; the filter stays applied. Flick to the next day — the filter persists and the popover's rows/counts update to that day.
8. Tick a type, then navigate to a day where that type has no bookings → the card shows "No matching bookings" with **Clear filter**, and the banner reads "All booking types are hidden." Tap either to recover.
9. On a day with no appointments at all, the Filter pill is not rendered.
10. iPad/tablet width: pills wrap cleanly, the popover never bleeds off either screen edge, and the banner reflows without clipping the **Clear filter** button.

---

## 4. Notes

- "Jump to today" was previously 32px tall with a 1px border; it now shares the exact toolbar-pill chrome (44px, subtle-tint fill, hover-to-accent) with Filter and New booking so the action row reads as one matched set.
- Native / staff bookings that carry a `service_type` but no `event_type_label` now get their correct category bar colour on the strip (previously they fell through to the graphite "consult" bar).
