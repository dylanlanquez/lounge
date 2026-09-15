# Slice — Voice calls: agent resource, booking type, Voice call mode

**Status:** Built, type-checked, unit-tested. Migration applied to shadow and to Meridian (15 Sep 2026, dry-run then apply, post-verified). Awaiting frontend deploy.
**Phase:** Cross-cutting (schedule, staff, notifications). First of the voice call slices; the Twilio call surface and the voice call visit page follow.
**Migration (this slice):** `20260915000001_lng_voice_calls.sql` (applied and verified on shadow and Meridian)

**Touched files:**
- `supabase/migrations/20260915000001_lng_voice_calls.sql` — `lng_staff_members.is_voice_call_agent`, the `voice-call-agent` staff-role pool with two-way flag/pool sync triggers, `voice_call` in every service_type check, closures rule, parent config + "Voice call" phase, four patient email overrides
- `src/lib/voiceCall.ts` — shared vocabulary: `VOICE_CALL_SERVICE_TYPE`, `VOICE_CALL_POOL`, `isVoiceCall`, `voiceCallIsLive`, `telHref`
- `src/lib/voiceCallMode.tsx` — `VoiceCallModeProvider` / `useVoiceCallMode`, remembered per staff member per device
- `src/components/VoiceCallModeSwitch/VoiceCallModeSwitch.tsx` — the Clinic / Voice calls switch in the kiosk tray
- `src/components/VoiceCallDayHero/VoiceCallDayHero.tsx` — next-call hero + day counts shown in Voice call mode
- `src/routes/Schedule.tsx` — mode-aware day: voice calls only, hero, New voice call, voice detail sheet (Call patient, no-show copy)
- `src/components/KioskStatusBar/KioskStatusBar.tsx`, `src/components/TopBar/TopBar.tsx`, `src/components/BottomNav/BottomNav.tsx` — quietened chrome in Voice call mode
- `src/components/Notifications/NotificationBell.tsx`, `NotificationsSheet.tsx`, `src/lib/queries/notifications.ts` — `scope='voice_call'`; rows carry `service_type`
- `src/components/NewBookingSheet/NewBookingSheet.tsx` — `lockedServiceType` (pinned service row, "New voice call" header)
- `src/components/ScheduleListView/ScheduleListView.tsx` — phone glyph on voice call rows
- `src/lib/queries/appointments.ts` — `voiceCall` category, label, colour bucket, "Voice Call" summary
- `src/lib/queries/bookingTypes.ts`, `bookingTypeAxes.ts`, `closures.ts`, `ledger.ts`, `clinicBoard.ts`, `scheduleViews.ts` — `voice_call` everywhere the service list is total; range counts accept a service filter
- `src/lib/queries/staff.ts`, `currentAccount.tsx` — `is_voice_call_agent`, derived `is_voice_call_only`, `setIsVoiceCallAgent`
- `src/routes/Admin.tsx` — "Voice call agent" permission row + pill; `AdminBookingTypesTab.tsx`, `AdminClosuresTab.tsx`, `Ledger.tsx` — voice call in their lists
- `src/theme/index.ts` — `category.voiceCall` (muted indigo, 6.2:1 on white)
- `src/lib/voiceCall.test.ts`, `tests/voice-calls.spec.ts`

---

## 1. User story

> As a voice call agent, I sign in and the top bar has a Clinic / Voice calls switch. In Voice call mode the schedule shows only my calls, tells me who I am ringing next and how the day is going, the nav drops to Schedule, Patients and Ledger, and the bell only rings for my calls. The walk-in, in-clinic, quick sale, cash and admin doors are out of my way. I tap New voice call, pick the patient and time, and the call is booked against the agents' capacity.

> As an admin, I tick Voice call agent on a staff member. They gain the switch and count towards voice call capacity. If I untick them in Conflicts, the flag follows, and vice versa.

---

## 2. The model

- **The agent is a resource.** `voice-call-agent` is a `staff_role` pool (ADR-006). A voice call's single phase consumes it, so concurrent calls are capped at the number of active agents, using the existing conflict checker and slot scanner with no special branch. Capacity 2 when two agents are active; 1 when one is deactivated (verified).
- **One fact, two homes.** `is_voice_call_agent` on the staff member and membership of the pool are kept identical by two triggers (flag → assignment, assignment → flag) with a transaction-local guard against recursion.
- **`voice_call` is a first-class service type** with a parent config row (Mon-Fri 9-18, Sat 10-16), a 15 min "Voice call" phase, and its own patient emails (confirmation, reschedule, cancellation, reminder) that never print the clinic address.
- **Remote team rule.** Whole-clinic closures do not block voice calls, exactly as they do not block virtual impressions. A `voice_call` closure does.
- **Mode is a view, not a permission.** The switch only exists for agents. A pure agent (no admin/manager) starts in Voice call mode; an admin who also takes calls starts in Clinic mode. The choice is stored per staff member on the device (`lng.voiceCallMode.<staff_member_id>`), so a shared iPad does not leak one person's mode onto the next. Every route keeps enforcing its real permission flags.
- **Voice call mode, concretely:** Schedule lists voice calls only (week strip dots count calls only), the Filter and Down time pills go, the next-call hero and counts arrive, New booking becomes New voice call with the service pinned, the detail sheet's primary action is Call patient (`tel:` link until Twilio), the bottom nav is Schedule · Patients · Ledger, the tray hides Cash counts / Reports / Marketing / Admin / My availability, and the bell scopes to rows whose booking is a voice call.

---

## 3. Smoke test (plain English)

1. Admin → Staff → Manage a staff member → tick **Voice call agent**. The list shows a "Voice call agent" pill. Admin → Conflicts: the **Voice call agent** pool lists that person; untick them there and the pill disappears in Staff; tick again and it returns.
2. Sign in as that agent. The kiosk tray leads with a **Clinic | Voice calls** pill. A pure agent lands in Voice calls; an admin lands in Clinic.
3. Tap **Voice calls**. The bottom nav is Schedule, Patients, Ledger (no More menu). The tray has no Cash counts, Reports, Marketing, Admin or My availability glyphs.
4. Schedule: the count reads "N voice calls"; the list shows only indigo-barred rows with a phone glyph; no Filter or Down time pill; a card above the list reads **Next call** with the patient, time and "in N min", and Calls / Answered / Missed / Left. Tap the card: the detail sheet opens.
5. Tap **New voice call**. The sheet is titled New voice call; the Service row reads "Voice call · Pinned". Pick a patient and a Monday at 10:00; times offered are 09:00 to 17:45 in 15 min steps. Book it. The row lands on the schedule; the confirmation email is the voice call copy ("we will phone you").
6. Book a second call at the same time with one active agent: the sheet reports the agent pool at capacity and refuses.
7. Open a booked voice call: footer shows **Call patient** and **No-show**; no Mark as arrived. Guidance reads "Ring … at the booked time".
8. Bell: only voice call events are listed and counted; title reads "Voice call notifications".
9. Tap **Clinic**: everything returns (full nav, filter, down time, all bookings). Reload: the last choice is remembered.
10. Sign in as a non-agent on the same device: no switch, no voice mode.
11. Admin → Closures: add a whole-clinic closure; voice calls on that date still book. Add a Voice calls closure; they do not.
12. Phone width: the switch shows icons only; the hero stacks counts under the headline; pills stay on one row.

---

## 4. Verification done

- `tsc -b --noEmit` clean; eslint clean on every touched file (the repo's pre-existing lint errors are all in `supabase/functions`).
- `src/lib/voiceCall.test.ts` (7 tests) passes; the full suite has the same 10 pre-existing failures as `main` (SnippetEditor, dateRange, emailTemplates, reports), none touched here.
- `tests/voice-calls.spec.ts` passes on all three Playwright projects.
- Shadow DB, all in rolled-back transactions: flag ↔ pool sync both directions; capacity 2 → 1 on deactivation; 36 slots on a Monday, none on Sunday; `pool_at_capacity` once one call is booked and the 10:00 slot leaves the scanner; a voice call does not consume chairs; the overlap guard raises on a second overlapping call; closures rule as specified; `lng_resolve_email_template('booking_confirmation','voice_call')` returns the voice copy.
- Screenshots of the schedule in Voice call mode (iPad width, phone width, empty day, New voice call sheet) reviewed against the theme.

---

## 5. Production rollout order

1. ~~Apply `20260915000001_lng_voice_calls.sql` to Meridian.~~ Done 15 Sep 2026: pre-flight (prerequisites, existing values), rolled-back dry run of the exact file, apply, post-verify (column + grants, pool, both triggers, three checks, config + phase + pool, resolver, four emails, closure rule, other staff-role pools unchanged). Additive: nothing changes until an agent is flagged.
2. Deploy the frontend.
3. Admin → Staff: tick Voice call agent on the agents. Adjust hours in Admin → Booking types → Voice call if the defaults are wrong.

## 6. Out of scope (next slices)

- Twilio dialling, recordings and call outcomes; the voice call visit page (what "Call patient" becomes once Twilio lands).
- Per-agent assignment of a call (the resource is the pool; a call is not yet pinned to one agent).
- Public widget exposure of voice calls (not enabled in `lng_widget_booking_types`).
