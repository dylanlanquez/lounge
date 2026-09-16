# Slice — Voice call record, previous calls, and the staff-notes history fix

**Status:** Built, type-checked, linted, unit-tested. Migration applied to shadow and Meridian, verified.
**Phase:** Cross-cutting (appointment page, schedule quick-view, patient history). Third voice-call slice, after the agent/booking-type slice and the buffer-after-booking follow-up.
**Migration (this slice):** `20260916000001_lng_voice_call_log.sql` (applied and verified on shadow and Meridian)

**Touched files:**
- `supabase/migrations/20260916000001_lng_voice_call_log.sql` — `lng_voice_call_log`, append-only, RLS select+insert for staff
- `src/lib/queries/voiceCallLog.ts` — outcome vocabulary, `logVoiceCallOutcome`, `reverseVoiceCallOutcome`, `useVoiceCallLog`, `usePatientVoiceCallHistory`
- `src/components/CallOutcomeSheet/` — `CallOutcomeSheet` (the "Log this call" picker) + `OutcomeBadge`
- `src/components/CallRecordCard/CallRecordCard.tsx` — the call-centre log at the foot of the appointment page
- `src/components/PreviousCallsCard/PreviousCallsCard.tsx` — the count + preview linking to the full history
- `src/components/VoiceCallActionCard/VoiceCallActionCard.tsx` — the phone-number hero card, sibling to `MeetingLinkCard`
- `src/routes/PatientVoiceCallHistory.tsx` — new route, every call this patient has had
- `src/routes/AppointmentDetail.tsx`, `src/lib/queries/appointmentDetail.ts` (+ its test file) — voice-call branch throughout: booking details, the action list, `log_call_outcome`/`reverse_call_outcome`
- `src/routes/Schedule.tsx` — the quick-view sheet uses the same `CallOutcomeSheet` for consistency with the full page
- `src/App.tsx` — `/patient/:patientId/voice-calls` route
- `src/components/StaffNotesCard/StaffNotesCard.tsx` — the "History (1 entry)" fix, applies everywhere this card is mounted

---

## 1. User story

> As a voice call agent, I open a booked call and see the patient's number in a card I can tap to dial, not buried behind "Mark patient as arrived." When the call is done I tap **Log this call**, pick what happened, and add a note if it matters. That becomes part of the call record at the foot of the page — every attempt, outcome first, note underneath, who and when. If this patient has called before, I see how many and the most recent outcome right there, and can open their whole call history in one tap.

> As any staff member, I open a note on any appointment and, if nobody has ever touched it, I don't see a "History" link that turns out to be the note itself.

---

## 2. The model

- **The call record is a table, not a note.** `lng_voice_call_log`: one row per logged attempt (`outcome`, optional `note`, who, when), append-only — a mis-logged call is corrected by reversing the appointment to `booked` and logging again, not by editing history.
- **The appointment's status is still the single source of truth everywhere else.** Logging "Answered" sets `complete`; every other outcome sets `no_show` with the outcome as `cancel_reason` — the same states Ledger, Reports and the schedule already understand, so nothing downstream needed a new branch. The `patient_events` write reuses the `no_show` event type for the same reason (a missed call *is* a no-show); "Answered" gets its own `voice_call_answered` event.
- **One action, not two.** `log_call_outcome` replaces `mark_arrived` + `mark_no_show` for a `voice_call` booking in `availableActions()`; `reverse_call_outcome` replaces `reverse_no_show`. Every other status/source rule (reschedule, cancel, resend) is untouched.
- **Booking details drops what doesn't apply.** A voice call has no address and no Meet host, so `BookingFactsCard` skips Location and "Join from" entirely for `service_type === 'voice_call'` rather than showing the clinic's own postcode as if that's where the call happens.
- **Previous calls is a preview, not a query builder.** It renders nothing on a patient's first call — no "Previous calls (0)" noise — and otherwise shows a count and the latest outcome, linking to `/patient/:patientId/voice-calls` for the full list.
- **The staff-notes fix.** "History" now counts amends and deletes only, never a note's own creation. A single note nobody has touched shows no History toggle at all — there's nothing to look back on. Fixed once in `StaffNotesCard`, live everywhere it's mounted (`AppointmentDetail`, `VisitDetail`).

---

## 3. Smoke test (plain English)

1. Open a booked voice call. The page shows: hero, Staff notes (no phantom History), an indigo-accented "Voice call" card with the patient's number and a **Call patient** button, Booking details with only Staff and Patient email (no address), a **Call record** card reading "No call logged yet," then the actions: **Log this call**, Patient profile, Reschedule, Resend confirmation, Cancel.
2. Tap **Log this call**. Pick an outcome, optionally add a note, submit. The sheet closes; the appointment status flips (Answered → Complete, anything else → No-show); the Call record card now shows that attempt with a coloured badge, the time, who logged it, and the note.
3. The actions list now offers **Undo, log again** instead of Log this call. Tapping it, confirming, returns the booking to Booked with the log entry still visible in the Call record.
4. Book a second call for the same patient. Its appointment page shows a **Previous calls · 1** card previewing the first call's outcome. Tap it: `/patient/:id/voice-calls` lists every call for that patient, most recent first, each with its outcome badge and note, each tapping through to its own appointment page.
5. Schedule's quick-view sheet for a voice call row shows the same **Log this call** button (not the clinic "No-show" picker) and, once logged, the same **Undo, log again**.
6. Any appointment's Staff notes: write one note, never touch it — no History link appears. Amend it once — "History (1 change)" appears, and opening it shows the amend, not the original creation.
7. A clinic (non-voice) booking is unaffected: Mark patient as arrived, Mark as no-show, and the clinic no-show reason picker all work exactly as before.

---

## 4. Verification done

- `tsc -b --noEmit` clean; `eslint` clean on every touched and new file.
- Unit tests: `appointmentDetail.test.ts` — 27 tests (21 existing + 6 new voice-call cases) all pass. Full suite: 717 passed, the same 10 pre-existing failures as `main` (SnippetEditor, dateRange, emailTemplates, reports), none touched here.
- Migration: pre-flight (prerequisite tables + functions present, no pre-existing `voice_call` data conflict), rolled-back dry run of the exact file, apply, post-verify (table, columns, check constraint, both indexes, RLS enabled, both policies) — done on shadow, then repeated identically on Meridian.
- Screenshots reviewed: the booked and no-show states of the rebuilt appointment page, the Log this call sheet mid-fill, the populated Call record + Previous calls preview with mocked data.

---

## 5. Out of scope (future slices)

- The `joined` status branch in `availableActions()` is untouched for voice calls — Twilio, when it lands, is what will make a call reach `joined` before `complete`/`no_show`.
- Per-agent call assignment and the dedicated voice-call visit page remain the next slices, as recorded in `docs/slices/voice-calls.md`.
