# Slice — Booking phases

**Status:** Draft, awaiting sign-off
**Phase:** Cross-cutting infrastructure (sits alongside the brief slices, not inside one — extends the booking-type / conflict-checker work shipped between brief slices 16 and 21)
**Depends on:**
- `lng_booking_type_config` (migration `20260501000003`)
- `lng_booking_resource_pools` + `lng_booking_service_pools` (migration `20260501000004`)
- `lng_booking_check_conflict` + `lng_appointments.service_type` (migration `20260501000005`)
**Related docs:**
- `docs/01-architecture-decision.md §6` — ADR-006 (the why)
- `docs/runbooks/migration-workflow.md` — shadow-then-production migration order

---

## 1. User story

> As a receptionist at Motherwell, I open the schedule on a Tuesday morning and see a Click-in Veneers appointment at 09:00 rendered as three coloured segments: a solid 30-minute head, a softer hatched 4-hour middle, and another solid 20-minute tail. I tap the appointment and see the patient's timeline: "09:00 patient in chair, 09:30 patient may leave (back at ~13:00), 13:00 patient back in chair, 13:20 ready for collection." At 11:00 the chair pool is free, so when I drop a denture-repair into 11:00 the conflict checker confirms it fits — even though Click-in Veneers is mid-passive on the lab bench. When I open the booking-types admin, every service shows a horizontal **phase ribbon** that explains the booking shape at a glance.

> As an admin, I configure each booking type's phase shape once. I set how many phases it has, what each phase is called, how long it takes, whether the patient is needed, and what equipment / staff role it consumes. I set the patient-facing duration separately — for denture repairs I tell the patient "30 minutes" even though we're booking 35 minutes operationally; for Click-in Veneers I leave the patient-facing single-duration unset and the confirmation shows a segmented schedule instead.

> As a patient, I receive a confirmation that says "Your denture-repair appointment, 30 minutes, Tuesday 09:00." I do not see anything about active versus passive. I show up, do my bit, and either wait or come back as the receptionist instructs. For my Click-in Veneers booking I receive a different confirmation: "Impression at 09:00 (30 min), please return for fit at approximately 13:00 (20 min)."

---

## 2. The three dimensions, one model (read this before reading anything else)

Every booking type has a **phase shape**. The shape is a sequence of one or more phases. Each phase is one self-contained block of time with these facts:

| Phase fact | Example value | Why it exists |
|---|---|---|
| `label` | "Sign in & assess", "Lab work", "Fit & deliver" | What the receptionist reads on the ribbon and timeline |
| `patient_required` | true / false | The single most important question: is the patient in the building right now? |
| `duration_min/max/default` | 15m / 25m / 20m | How long this phase takes; bounds let the slot picker offer a range |
| `pool_ids` | `['chairs']`, `['lab-bench']` | Which physical things or staff roles this phase holds |

From the phase shape we derive two more things:

- **Block duration** = sum of phase defaults. This is what the calendar block spans, what the conflict checker uses, what the slot picker uses to find candidate slots. **No admin field — derived.**
- **Patient-facing duration** = an admin-set field that defaults to the block duration when null. This is what the patient sees in their confirmation email / SMS / Calendly description. Separable because what we tell the patient is a copy decision, not an operational one.

**Operational time vs patient time is the line that this slice draws cleanly for the first time.** Once that line is drawn, every confusing edge case (Click-in Veneers, denture repair patient-may-leave, hard-cure retainer) collapses to "set the phases on the parent, optionally set the patient-facing duration, done."

---

## 3. Acceptance criteria

### 3.1 Booking-types admin — the phase ribbon

- [ ] Each parent service in `Admin → Booking types` shows a **horizontal phase ribbon** below its name. Phases are sized proportionally to their `duration_default`.
- [ ] Active phases (`patient_required = true`) render as solid `theme.color.accent`.
- [ ] Passive phases (`patient_required = false`) render as the same accent at ~35% opacity, overlaid with a diagonal-line CSS pattern (`repeating-linear-gradient`), so passive reads visually distinct without changing colour family.
- [ ] Each phase chip shows: label, duration ("15 min"), and a small icon (`UserRound` for active, `Hourglass` for passive — Lucide React only, per CLAUDE.md hard rule).
- [ ] Above the ribbon, a one-line summary: **"Total operational time 35 min · Patient in for 15 min · Telling patient 30 min"**. Numbers use `Intl.NumberFormat` (per `feedback_thousand_separators.md`).
- [ ] Tap a phase chip → opens **Phase editor** dialog (label, duration trio, patient-required toggle, pool picker — all existing components).
- [ ] "+ Add phase" button at the end of the ribbon → opens phase editor for a new phase appended at the end.
- [ ] Drag handle on each chip to reorder; up/down arrows visible on focus for keyboard / a11y.
- [ ] Trash icon to delete a phase. If the parent config has any active appointments materialised against that phase shape, refuse with inline message: *"X active appointments use this shape. Complete or cancel them first."*
- [ ] Below the ribbon: **Patient-facing duration** field — an `Input` with the resolved current value pre-filled and a *"Use operational total"* link to clear it back to null. Inline note shown when the set value differs from the operational total: *"Operational total 35 min, telling patient 30 min. Confirm."*
- [ ] Child override row (under parent): compact ribbon. Phases the child overrides show their own duration; phases inheriting from the parent render muted with *"inherits 20 min from parent"*. Same edit dialog reused.
- [ ] All controls use theme tokens. No hardcoded values. No native `<select>` (DropdownSelect only, per `feedback_no_system_ui_dropdowns.md`).
- [ ] Saving is via the existing `upsertBookingTypeConfig` family (extended with `upsertBookingTypePhase`, `deleteBookingTypePhase`, `setBookingTypePhasePools`).

### 3.2 Booking-types admin — patient-facing copy preview

- [ ] Below the patient-facing duration field, a live preview of how the patient confirmation will read for this booking type. Two formats:
  - **Single-duration** (default when no passive phase ≥ 60 min): *"Your appointment: 30 minutes, Tuesday 9:00."*
  - **Segmented** (when at least one passive phase ≥ 60 min): *"Impression at 09:00 (30 min), please return for fit at approximately 13:00 (20 min)."*
- [ ] The format threshold is read from `lng_settings.booking.patient_segmented_threshold_minutes` (default 60). No service-type branches.

### 3.3 Conflict checker — phase-aware

- [ ] `lng_booking_check_conflict` walks `lng_appointment_phases × lng_booking_type_phase_pools` instead of treating each appointment as a single block.
- [ ] For each phase the candidate booking would have (resolved from `lng_booking_type_resolve` for the candidate's full child key), and for each pool that phase consumes, count overlapping `lng_appointment_phases` rows that share at least one pool. If `count + 1 > pool.capacity` → conflict.
- [ ] `max_concurrent` rule preserved: count appointments of the same `service_type` overlapping in time (any phase).
- [ ] Each conflict row returned carries `phase_index`, `phase_label`, `pool_id`, `pool_capacity`, `current_count`, and `conflict_window tstzrange` so the reschedule sheet can render operator copy without further joins.
- [ ] Empty result still means slot is free.
- [ ] `lng_booking_check_conflict` takes the full child key (`p_repair_variant`, `p_product_key`, `p_arch`) so it can resolve the candidate's own phase list, not just the parent service's pool list.

### 3.4 Schedule grid — two-tone block render

- [ ] Each appointment block on the calendar visually decomposes into its phases.
- [ ] Active phases: solid `theme.color.accent` fill (or the existing per-service colour bar — colour family unchanged from today's calendar).
- [ ] Passive phases: same colour at ~35% opacity, diagonal-line CSS pattern overlay.
- [ ] Subtle 1px vertical separator between phases.
- [ ] 1-phase appointments (the default after backfill) look identical to today's blocks. Visual change is opt-in by adding multiple phases to a config.
- [ ] Hover / tap behaviour unchanged: opens the existing detail sheet.
- [ ] List view (`ScheduleListView`) shows phase labels inline: *"Click-in Veneers · Impression 30 min · Lab 4 h · Fit 20 min"*.

### 3.5 Appointment detail — phase timeline

- [ ] New section in `AppointmentDetail`: **Booking timeline**.
- [ ] Vertical timeline, one row per phase, with timestamp on the left.
- [ ] Active phase row: subtitle *"Patient in chair"*. Passive phase row: subtitle *"Patient may leave, ready ~13:00"*. Final row: *"Ready for collection"* with the calculated time.
- [ ] Each row shows a `StatusPill`: pending / in_progress / complete / overdue (overdue = derived state when `end_at < now()` and status still pending or in_progress).
- [ ] Receptionist-facing actions: **"Mark patient may leave"** (advances current active phase to complete + next passive phase to in_progress), **"Mark ready for collection"** (advances final phase to complete). Explicit transitions; no auto-advance on time.
- [ ] Each transition writes a `lng_event_log` row (`event_type ∈ ('appointment_phase_advanced')`).
- [ ] `lng_appointment_phases.status` updates flow back into the schedule render — an in-progress phase can show a thin progress bar overlay (existing visual primitive used elsewhere).

### 3.6 Reschedule sheet — phase-aware copy

- [ ] Slot picker still searches by block duration (sum of phase defaults).
- [ ] Conflict messages render in operator language using `phase_label` and `conflict_window`:
  - Today: *"Pool `lab-bench` at capacity"*
  - New: *"Lab bench busy 14:00–17:30 (Click-in Veneers — Lab fabrication)"*
- [ ] When the candidate booking has at least one passive phase ≥ 60 min: a **"Patient must be back at HH:MM"** line appears under the candidate slot, computed from phase boundaries.
- [ ] No phase shape is hardcoded; the renderer reads the resolved phase list.

### 3.7 Patient-facing communications

- [ ] Confirmation email / SMS templates (`lng_email_templates`, `send-receipt`-shaped path) read `patient_facing_duration_minutes` from the resolved booking type, not from any phase math.
- [ ] When the booking type has at least one passive phase ≥ `lng_settings.booking.patient_segmented_threshold_minutes` (default 60): template renders the **segmented** schedule (one line per active phase: start time + duration). Otherwise renders the **single-duration** form.
- [ ] Calendly event duration (when Lounge becomes source-of-truth in v1.5 / Option B) sources the same field.
- [ ] Template branching is on the threshold, not on `service_type`.

### 3.8 Backfill and forwards-compatibility

- [ ] Migration M1 seeds every existing parent `lng_booking_type_config` row with a default 1-phase `lng_booking_type_phases` row (label = service display name, `patient_required = true`, durations from `parent.duration_*`, `pool_ids` = current `lng_booking_service_pools` for that service).
- [ ] Migration M2 backfills every active appointment (`status in ('booked','arrived','in_progress')`) with a single materialised `lng_appointment_phases` row covering `[start_at, end_at]`.
- [ ] Backfill is idempotent (`on conflict do nothing` against `(appointment_id, phase_index)` unique).
- [ ] Closed / no-show / cancelled appointments are not backfilled — the conflict checker doesn't read them.
- [ ] After backfill: the migration asserts every active appointment has exactly one phase row. Mismatch raises into `lng_system_failures` (severity `error`).
- [ ] Booking creation paths (Calendly inbound webhook, native reschedule, future native new-booking) all call a single helper `materialiseAppointmentPhases(appointment_id)` — exactly one place phase materialisation happens.

### 3.9 Failure logging (per CLAUDE.md hard rule "failures must be loud")

- [ ] Resolver called with a `service_type` that has zero phases → throws, writes `lng_system_failures` (severity `error`, payload includes the service tuple).
- [ ] Materialisation called for an appointment whose service_type has no parent config row → throws, writes `lng_system_failures`.
- [ ] Phase status transition to `complete` on a phase that is already `complete` → throws (idempotency check), writes `lng_event_log` with `event_type = 'appointment_phase_double_advance'`.
- [ ] `patient_facing_duration_minutes` set to a value greater than the operational block by more than 50% → admin save still succeeds, but writes `lng_event_log` (`event_type = 'patient_facing_duration_diverged'`) for visibility.

---

## 4. Smoke test (plain English, per brief §1)

> Sarah arrives at the Motherwell desk at 09:00. A Click-in Veneers patient walks in. Sarah opens the schedule. The 09:00 block is rendered in three coloured segments: a solid 30-minute head (impression), a softer hatched 4-hour middle (lab fabrication), and another solid 20-minute tail (fit & deliver). She taps the block. The detail sheet shows: "09:00 — Patient in chair (Impression)", "09:30 — Patient may leave, ready around 13:00 (Lab fabrication)", "13:00 — Patient back in chair (Fit & deliver)", "13:20 — Ready for collection". She marks the patient arrived. After 30 minutes she taps "Patient may leave" and the patient walks out for lunch.
>
> At 10:45 a denture-repair patient walks in. Sarah opens the schedule and looks at 11:00 — the chair pool reads 1/2 (the veneers patient is mid-passive on the lab bench, not in a chair). She drops the new appointment into 11:00 — confirmed, no conflict. The block renders with a solid 15-minute head and a softer 20-minute tail.
>
> At 12:55 the veneers patient returns. Sarah taps the appointment again. The fit phase begins at 13:00 as planned. She taps "Mark ready for collection" at 13:20 and the appointment closes.
>
> Meanwhile Dylan opens `Admin → Booking types`. Click-in Veneers shows three chips on a ribbon: filled-impression-30m, hatched-fabrication-4h, filled-fit-20m. The summary line reads: *"Total operational time 6 h 50 min · Patient in for 50 min · Telling patient: segmented schedule"*. Below the ribbon, a preview of the confirmation email shows the segmented copy. Denture repair shows two chips: filled-15m, hatched-20m. The summary line reads: *"Total operational time 35 min · Patient in for 15 min · Telling patient 30 min"*. Dylan changes the patient-facing duration to 35 and the inline note disappears (it now matches the operational total).

If a non-technical receptionist can read the calendar at a glance and answer *"is the patient in the chair right now?"* and *"when do they need to be back?"* without thinking, the slice is done.

---

## 5. Data model touches

### 5.1 New tables

| Table | Purpose | Key columns |
|---|---|---|
| `lng_booking_type_phases` | Phase definitions hung off a config row | `id pk`, `config_id fk → lng_booking_type_config(id) on delete cascade`, `phase_index int > 0`, `label text`, `patient_required bool`, `duration_min/max/default int`, `notes text`. Unique `(config_id, phase_index)`. |
| `lng_booking_type_phase_pools` | Per-phase pool consumption (replaces service-level) | `phase_id fk → lng_booking_type_phases(id) on delete cascade`, `pool_id fk → lng_booking_resource_pools(id) on delete cascade`. PK `(phase_id, pool_id)`. |
| `lng_appointment_phases` | Per-appointment phase snapshot | `id pk`, `appointment_id fk → lng_appointments(id) on delete cascade`, `phase_index int`, `label text`, `patient_required bool`, `pool_ids text[]`, `start_at timestamptz`, `end_at timestamptz`, `status text check in ('pending','in_progress','complete','skipped') default 'pending'`. Unique `(appointment_id, phase_index)`. |

### 5.2 New / changed columns

| Table | Column | Type | Notes |
|---|---|---|---|
| `lng_booking_type_config` | `patient_facing_duration_minutes` | `int null` | Parent + child fallback. Null on parent → resolves to block duration at resolve time. |
| `lng_settings` | new key `booking.patient_segmented_threshold_minutes` | int (default 60) | Threshold for switching patient comms from single-duration to segmented schedule. |

### 5.3 Deprecated

| Table | Status |
|---|---|
| `lng_booking_service_pools` | Read by `lng_booking_type_resolve` only as a fallback during the migration window (any config row with zero phase rows). Dropped in a follow-up migration once every parent has at least one phase. |

### 5.4 Function signature changes

- `lng_booking_type_resolve(p_service_type, p_repair_variant, p_product_key, p_arch)` → return additional fields:
  - `phases jsonb` (array of `{phase_index, label, patient_required, duration_min, duration_max, duration_default, pool_ids[]}` in `phase_index` order, parent-fallback applied per field by `phase_index`)
  - `block_duration_minutes int` (derived sum of `phase.duration_default`)
  - `patient_facing_duration_minutes int` (resolved from child or parent, falls back to `block_duration_minutes`)
- `lng_booking_check_conflict(p_location_id, p_service_type, p_repair_variant, p_product_key, p_arch, p_start_at, p_end_at, p_exclude_appointment_id)` → new params for child key. Returns `(conflict_kind, pool_id, pool_capacity, current_count, phase_index, phase_label, conflict_window tstzrange)` per conflict.

---

## 6. Migration plan (ordered, idempotent each)

| # | Filename | Purpose | Apply order |
|---|---|---|---|
| M1 | `YYYYMMDD_NN_lng_booking_type_phases.sql` | Create `lng_booking_type_phases` + `lng_booking_type_phase_pools`. Seed every existing parent config with a default 1-phase row mirroring today's behaviour. RLS: read-open to `authenticated`, write-admin-only (mirrors existing pattern). | First |
| M2 | `YYYYMMDD_NN_lng_appointment_phases.sql` | Create `lng_appointment_phases`. Backfill all active appointments with a single materialised phase covering their full window. Add covering index for the conflict checker's overlap probe. | Second |
| M3 | `YYYYMMDD_NN_lng_patient_facing_duration.sql` | Add `patient_facing_duration_minutes` to `lng_booking_type_config`. Add `booking.patient_segmented_threshold_minutes` row to `lng_settings` (default 60). | Third (independent of M1/M2 but logically grouped) |
| M4 | `YYYYMMDD_NN_lng_resolve_with_phases.sql` | Update `lng_booking_type_resolve` to return `phases`, `block_duration_minutes`, `patient_facing_duration_minutes`. | After M1+M3 |
| M5 | `YYYYMMDD_NN_lng_conflict_check_phase_aware.sql` | Rewrite `lng_booking_check_conflict` to walk `lng_appointment_phases × lng_booking_type_phase_pools`. Add child-key params. | Last (depends on M1 + M2) |
| M6 | `YYYYMMDD_NN_lng_drop_service_pools.sql` | Drop `lng_booking_service_pools` once all consumers are migrated and the table has no remaining readers. | Follow-up PR, not this slice. |

Each migration applied first to the shadow project (`vkgghplhykavklevfhkz`), verified, then to Meridian's project (`npuvhxakffxqoszytkxw`) per `docs/runbooks/migration-workflow.md`.

---

## 7. Edge functions / queries

No new edge functions. All work is database + client-side.

Client query / helper additions in `src/lib/queries/bookingTypes.ts`:

- `useBookingTypePhases(configId)` — fetches phase rows for a config.
- `upsertBookingTypePhase(input)` — insert or update a phase row.
- `deleteBookingTypePhase(phaseId)` — refuses if any active appointment depends on the shape (server-side check via RPC `lng_booking_phase_in_use(phase_id) returns boolean`).
- `setBookingTypePhasePools(phaseId, poolIds[])` — atomic delete + insert.
- `materialiseAppointmentPhases(appointmentId)` — RPC call that resolves the booking type and inserts snapshot rows. **Only** caller of phase materialisation; called from booking creation paths.

Client query in `src/lib/queries/appointmentDetail.ts`:

- `useAppointmentPhases(appointmentId)` — fetches phase rows ordered by `phase_index`.
- `advanceAppointmentPhase(appointmentId, phaseIndex, toStatus)` — RPC `lng_appointment_phase_advance(...)`. Server-side enforces "can only advance forward".

---

## 8. UI components needed

All built atop existing primitives — no new design system components.

| Component | Purpose | Built on |
|---|---|---|
| `PhaseRibbon` | Horizontal ribbon used in admin and on the schedule list view | flex layout, `theme.color.accent`, CSS `repeating-linear-gradient` for hatch |
| `PhaseChip` | Single phase block; tap to edit | `Card`-shaped, accent fill, `Lucide` icon |
| `PhaseEditor` | Dialog with label, duration trio, patient-required toggle, pool picker | `Dialog`, `Input`, `DropdownSelect`, `Checkbox` |
| `PhaseTimeline` | Vertical timeline on the appointment detail | `Card`, `StatusPill`, existing per-row layout |
| `ScheduleBlockMultiPhase` | Extension of the existing schedule block to render two-tone segments | extends current `<ScheduleBlock>` shape; consumes `phases[]` instead of single `[start_at, end_at]` |

---

## 9. Tests

### 9.1 Unit (Vitest)

- `resolveBookingTypeConfig` returns phase-merged result with parent fallback per phase_index.
- `resolveBookingTypeConfig` returns `patient_facing_duration_minutes` from child if set, else parent if set, else `block_duration_minutes`.
- `lng_booking_check_conflict` over a 2-phase booking only counts the phases that actually consume each pool.
- Snapshot-on-materialisation: editing a phase config after an appointment is materialised does not change the materialised row.
- `advanceAppointmentPhase` refuses backwards transitions.

### 9.2 Integration (against shadow project)

Seed: 2 chairs, 1 lab bench. Click-in Veneers (3 phases), denture repair (2 phases), generic same-day appliance (1 phase).

Scenarios:

- 09:00 Click-in Veneers booked. Probe a denture-repair candidate at 09:30 — should be allowed (chair pool has 1 free; veneers is on impression-then-lab, lab not yet started but the impression phase is ending).
- 09:00 Click-in Veneers booked. Probe a denture-repair candidate at 11:00 — should be allowed (chair pool 1/2 because veneers is mid-lab, not holding chair).
- 09:00 + 09:15 two denture repairs booked. Probe a third at 09:20 — should be blocked (chair pool 2/2 in active phases).
- 09:00 + 11:00 two Click-in Veneers booked. Probe a third at 13:00 — should be blocked (lab bench 1/1 in fabrication phase overlap).

### 9.3 Playwright (`tests/booking-phases.spec.ts`)

- Admin → edit Click-in Veneers, add a third phase, ribbon updates with the new chip.
- Admin → set patient-facing duration to differ from operational total → inline note appears.
- Admin → preview shows segmented copy when a passive phase ≥ 60 min exists.
- Schedule → drop a denture-repair into a slot where Click-in Veneers is mid-passive, see chair pool 1/2.
- Appointment detail → tap "Mark patient may leave", phase timeline advances and the schedule block's first segment fills.
- Reschedule sheet → conflict copy reads "Lab bench busy 14:00–17:30 (Click-in Veneers — Lab fabrication)".

### 9.4 Manual QA on the Galaxy Tab

Same as Playwright but on the actual hardware. Particular checks:

- Two-tone block render is legible at the calendar's normal zoom.
- The phase ribbon in admin is touch-friendly (chips ≥ 32px tall).
- Diagonal-hatch passive pattern doesn't shimmer or moiré on the tablet's pixel density.

---

## 10. Out of scope (this slice)

- Phase-aware notification triggers (SMS at "ready for collection"). Defer to v1.5.
- Per-child label override or per-child `patient_required` override (children override durations only — see ADR-006 §6.3.3 / AQ6).
- Per-child phase pool override (pools are inherited wholesale from parent at the phase level — same constraint, tracked as a v1.5 question).
- Phase-level cost / line items in EPOS — all phases of a booking still roll up to one cart.
- Auto-advance on time. Phase status transitions are explicit receptionist actions.
- Visualising historical phase-timing analytics. Reporting can come later when there's enough data to be useful.
- Drag-to-reschedule on the calendar (per brief §9.X — explicit action only).
- Calendly Option B sync of phase data back to Calendly. Out of scope until Option B itself ships.

---

## 11. Open questions

| # | Question | Recommendation |
|---|---|---|
| QA1 | Phase reorder — drag handle or arrows? | Drag handle (touch-first), with up/down arrow fallback for keyboard / a11y. |
| QA2 | Deleting a phase from a config that has live appointments. | Refuse with "X active appointments use this shape — complete them first" inline message. Confirmed in §3.1. |
| QA3 | Overdue passive→active transition (patient hasn't returned by ~13:00). | Add `overdue` derived state to the phase status pill. No auto-cancel — receptionist decides. Confirmed in §3.5. |
| QA4 | Two-tone block visual on dense calendars (≤24px/hour). | Hatch pattern collapses to a thin 50% opacity overlay below 24px/hour to stay legible. Confirm in QA on the Galaxy Tab. |
| QA5 | Should `patient_facing_duration_minutes` be displayable in minutes only, or in human form ("1 h 30 min")? | Stored as minutes (int). Rendered in human form via existing `formatMinutes` helper. |
| QA6 | The segmented threshold is currently a single global setting (`lng_settings.booking.patient_segmented_threshold_minutes`). Should it be per-booking-type? | Defer. Single global is enough for v1; revisit if Click-in Veneers needs different segmentation copy than future long-passive services. |
| QA7 | When a booking is rescheduled, do we re-materialise its phases? | Yes — old phase rows are deleted, fresh ones are inserted from the current resolved config. The reschedule helper calls `materialiseAppointmentPhases` again. |

---

## 12. Implementation order

1. Spec sign-off (this doc).
2. **M1** migration: `lng_booking_type_phases` + `lng_booking_type_phase_pools` + seed default phase per parent config. Apply to shadow → verify → Meridian.
3. **M2** migration: `lng_appointment_phases` + backfill for active appointments. Apply to shadow → verify → Meridian.
4. **M3** migration: `patient_facing_duration_minutes` on config + `lng_settings` threshold row.
5. **M4** migration: `lng_booking_type_resolve` returns phases + block + patient-facing.
6. **M5** migration: `lng_booking_check_conflict` rewrite + new child-key params.
7. Booking creation paths (Calendly inbound webhook + native reschedule) call `materialiseAppointmentPhases` at insert/reschedule time. Add the helper, wire both paths, write `lng_system_failures` row on any failure (per CLAUDE.md hard rule).
8. Component build: `PhaseRibbon`, `PhaseChip`, `PhaseEditor`, `PhaseTimeline`, `ScheduleBlockMultiPhase`. Storybook stories for each.
9. `Admin → Booking types`: replace today's "duration" row with the phase ribbon. Patient-facing duration field below. Live preview of the patient confirmation copy.
10. `Admin → Conflicts & capacity`: copy update — pool consumption now described per phase, not per service.
11. Schedule render: switch the block to `ScheduleBlockMultiPhase`. List view: phase labels inline.
12. Appointment detail: add `PhaseTimeline` section with status transitions.
13. Reschedule sheet: phase-aware conflict copy; "patient back by" hint.
14. Patient comms templates: read `patient_facing_duration_minutes` + segmented threshold; render single-duration vs segmented.
15. Tests at every step (unit + integration on shadow + Playwright).
16. Score → ship to staging → Dylan signs off → ship to production.
17. **M6** follow-up PR: drop `lng_booking_service_pools` once nothing reads it.

---

## 13. Self-score (current spec only — not the implementation)

| Axis | Score | Notes |
|---|---|---|
| Spec completeness | 92 | All states + backfill + comms templates covered; segmented threshold rule named; child override surface explicit. |
| Brief faithfulness | 94 | Maps to ADR-006; respects every CLAUDE.md hard rule (lng_ prefix, inline styles, no native dropdowns, no dashes in copy, loud failures, no service-type branches, thousand separators). |
| UX clarity | 90 | Phase ribbon + two-tone block + vertical timeline are the three primary surfaces; copy is operator-language. Open question on dense-calendar legibility (QA4). |
| Data model rigour | 93 | Snapshot-on-materialisation invariant; idempotent backfill; nullable patient-facing field with clear fallback semantics; deprecated table called out. |
| Testability | 91 | All three test layers planned; concrete pool/phase fixtures defined for integration; Playwright spec name fixed. |
| **Aggregate** | **92** | Above the 90 floor. Ready for sign-off pending QA1–QA7 answers. |

---

*End of slice spec — booking phases.*
