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

- Filter state is a `Set<AppointmentCategory>` of the categories **shown**. The full set is the resting "no filter" state.
- State lives in `Schedule.tsx` component state, not the URL — it persists as the operator flicks between days but doesn't leak into a shared link.
- The popover shows a live per-category count for the day in view; a category with zero bookings that day renders dimmed and non-interactive.

---

## 3. Smoke test (plain English)

1. Sign in, land on the schedule for a day that has several booking types.
2. The action row shows three matched pills — **Filter**, **Jump to today** (when not on today), **New booking** — all the same height (44px), same pill shape, evenly spaced.
3. Tap **Filter**. A popover opens, right-aligned under the pill, listing the six booking types. Each row shows a colour dot matching the row bars, the type name, and the count of that type today. Types with zero bookings today are dimmed and can't be toggled.
4. All types start ticked (a check on the right of each row). Tap **Impressions** off and **Virtual impressions** off. The strip immediately drops those rows. The header count reads "N of M shown". The Filter pill turns green and shows a badge with the number of types still shown.
5. Tap outside the popover (or press Escape). It closes; the filter stays applied.
6. Flick to the next day with the arrows. The filter persists; counts in the popover update to that day.
7. Filter down to a type that has zero bookings on the current day → the card shows "No matching bookings" with a **Show all types** button. Tap it; every type returns and the pill goes back to neutral.
8. Re-open Filter and tap **Show all** in the popover header (only visible while a filter is active) → resets to all types.
9. On a day with no appointments at all, the Filter pill is not rendered (nothing to narrow).
10. iPad/tablet width: pills wrap cleanly, popover never bleeds off either screen edge.

---

## 4. Notes

- "Jump to today" was previously 32px tall with a 1px border; it now shares the exact toolbar-pill chrome (44px, subtle-tint fill, hover-to-accent) with Filter and New booking so the action row reads as one matched set.
- Native / staff bookings that carry a `service_type` but no `event_type_label` now get their correct category bar colour on the strip (previously they fell through to the graphite "consult" bar).
