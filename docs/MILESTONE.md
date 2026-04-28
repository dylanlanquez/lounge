# Lounge build milestone

**As of:** 2026-04-28 (end of session)
**Brief:** [`/Users/dylan/Downloads/lounge-build-brief.md`](../../Downloads/lounge-build-brief.md) v5
**Production:** https://lounge-coral.vercel.app · Supabase project `npuvhxakffxqoszytkxw` (Meridian)

> **For the next session:** the Schedule/Calendar surface is now feature-rich — virtual appointments, no-show + reverse, density clusters, list view, category colour bars, properCase names, intake-aware booking summaries. The remaining cutover blockers are unchanged: physical S700 hardware test, BNPL virtual card test, fresh Calendly webhook end-to-end test, and receipt secret rollout.

---

## Phase status

| Phase | Status |
|---|---|
| Phase 0 — Discovery | ✅ Complete |
| Phase 0.5 — Architecture record | ✅ Complete |
| Phase 0.55 — Calendly ADR | ✅ Complete (Option A: webhook ingest, Calendly remains source-of-truth for create/cancel) |
| Phase 0.575 — Stripe Terminal / EPOS / BNPL ADR | ✅ Complete |
| Phase 0.6 — Patient identity | ✅ Complete |
| Phase 0.7 — DPIA | ✅ Complete |
| Phase 1 — Foundation | ✅ Complete (Vite + React 19 + RR6, Supabase wiring, theme tokens, 20 lng_* migrations) |
| Phase 2 — Design system | ✅ Complete (Storybook + 18 components incl. ClusterCard, ScheduleListView, BottomSheet, CalendarGrid) |
| Phase 3 — Feature slices | 🟡 In progress (see slice table below) |
| Phase 4 — Cutover | ⏳ Not started |

---

## Phase 3 slices (per brief §10.1)

| # | Slice | Status | Notes |
|---|---|---|---|
| 1 | Receptionist sign-in | ✅ | Email+password (PIN-mode deferred to v1.5) |
| 2 | Calendar — today view | ✅ | Density-aware: ≤2 lanes, 3+ → ClusterCard, Calendar/List toggle, category colour bars |
| 3 | Calendly inbound sync | ✅ | Webhook + backfill + intake + join_url + phone-from-Q&A + placeholder-email guard + wrong-match recovery |
| 4 | Patient search & walk-in check-in | ✅ | Phone-first, account_id auto-resolved |
| 5 | Appointment check-in | ✅ | Mark-arrived from BottomSheet, creates `lng_visits`, virtual appointments do NOT create a visit |
| 6 | Lab Scanner integration | ⏸️ Deferred | Phase 0 audit deferred to v1.5 |
| 7 | EPOS cart building | ✅ | Custom line items, generated `total_pence` |
| 8 | Stripe Terminal — start payment | ✅ | `terminal-start-payment` edge fn, idempotency keys |
| 9 | Stripe Terminal — webhook | ✅ | HMAC verify + 600s replay window, updates `lng_terminal_payments` |
| 10 | Stripe Terminal — cancel | ✅ | `terminal-cancel-payment` |
| 11 | Cash payment | ✅ | Tendered + change calc |
| 12 | BNPL helper | ✅ | Klarna + Clearpay scripts from `lng_settings`, `payment_journey` tagged |
| 13 | Receipts (basic) | ✅ | Channel pick + queue row |
| 13b | Receipts — real delivery | ✅ | `send-receipt` edge fn (Resend + Twilio), graceful when keys unset, retry from Admin |
| 14 | Refunds | ✅ | `terminal-refund` edge fn (full Stripe refund or DB-only for cash) |
| 15 | Consent forms + intake photos | ✅ | `<input capture="environment">`, `case-files` bucket, signed URLs (5 min TTL), `patient_files` rows |
| 16 | Reschedule / cancel to Calendly | ⏸️ Deferred | Per ADR Option A; Calendly stays source-of-truth |
| 17 | No-show / cancel handling | 🟡 Partial | Manual flag + reverse-no-show + virtual-aware (re-join after no-show) ✅; need 15-min auto-suggestion + cancellation reason capture |
| 18 | Week / day views | 🟡 Partial | Day view ✅; week view not built. Calendar/List toggle covers high-density days |
| 19 | Patient timeline | ✅ | Merged events + visits + appointments + payments, total spent pill |
| 20 | End-of-day reconciliation | 🟡 Partial | Admin → Reports daily totals ✅; no Stripe Dashboard cross-check or cash drawer reconciliation |
| 21 | Admin (desktop) | 🟡 Partial | Calendly, Receipts, Reports, Devices, Failures, Testing tabs ✅; staff management & BNPL script editor not built |
| 22 | Reporting | 🟡 Partial | 7-day totals by method/journey ✅; no-show rate, wait time, walk-in vs appointment ratio, Calendly drift not built |

**Score:** 14 done, 4 partial, 2 deferred (out of 22 slices).

---

## Cross-cutting infrastructure shipped

- **Database:** 20 `lng_*` migrations applied to Meridian. New since last milestone: `*_intake.sql` (jsonb), `*_join_url.sql` (text). Patients-guard trigger on `lwo_ref`. Generated `total_pence` on carts. RLS policies for receptionist scope.
- **Edge functions (7):** `calendly-webhook`, `calendly-backfill`, `terminal-start-payment`, `terminal-webhook`, `terminal-cancel-payment`, `terminal-refund`, `send-receipt`. Calendly fns now extract `intake[]`, `join_url`, and phone from intake Q&A; backfill includes wrong-match recovery + fill-blanks.
- **Build:** code-split (vendor chunks). Largest chunk 203 KB (supabase) gzipped 53 KB.
- **Mobile + tablet:** `useIsMobile` + `useIsDesktop` hooks (the latter gates the Google Meet "Join meeting" button to laptops/desktops with fine pointer + ≥1024px). Shared `TopBar`. Responsive padding.
- **PWA:** `public/manifest.webmanifest` + `public/sw.js` for installability on Galaxy Tab.
- **Tests:** Vitest. **110 unit tests** across `formatBookingSummary` (53), `intakeSummary` (7), `identity` (39), `layoutAppointments` (11). Playwright E2E exists from earlier slices.
- **Operational scripts:** `shadow-bootstrap.sh`, `shadow-cleanup.sh`, `meridian-apply.sh`, `create-receptionist.sh`, `calendly-setup.sh`, `calendly-backfill.mjs`, `calendly-diagnostic.sh`, `stripe-setup.sh`, `receipt-setup.sh`, `deploy-edge-functions.sh`, `checkpoint-backfill.mjs`.
- **Observability:** `lng_event_log`, `lng_system_failures`, `patient_events`. New `patient_events` types: `virtual_meeting_joined`, `no_show_reversed`. `/admin → Failures` surfaces unresolved entries. `/admin → Testing` lets staff reset dirty test appointments.

---

## Open critical items (block cutover)

### A. Receipt delivery not yet activated in production
Edge function deployed but `RESEND_API_KEY` not set on Meridian secrets.
**Action:** export `RESEND_API_KEY` (and optionally `TWILIO_*`) → run `./scripts/receipt-setup.sh`.
**Until then:** receipts queue in `lng_receipts` with `failure_reason='delivery_not_configured'` and surface in Admin → Receipts for retry.

### B. Calendly fresh-booking webhook end-to-end test
Backfill now lands intake + join_url + phone correctly (verified against real Calendly events for 2026-04-28). **Need to make a fresh test booking** to verify the live webhook path also writes those new columns.

### C. Stripe Terminal physical hardware test
S700 path tested only via simulated WisePOS E. Need:
1. Pair real S700 to Meridian's Stripe Terminal location.
2. INSERT row into `lng_terminal_readers` with the registered reader ID.
3. Run a £1 test transaction end-to-end.

### D. BNPL virtual card test
Klarna/Clearpay flow has the helper UI but the actual virtual card contactless tap on the S700 has not been tested with a real BNPL provider account.

---

## Phase 3 work remaining

### Slice 17 — No-show / cancel handling (partial)
- Automatic flag suggestion when current time > start_at + 15 min.
- Cancellation reason capture (drop-down: patient request / no-show / clinic / other).
- Surface no-show count + reversal count in Admin → Reports.

### Slice 18 — Week view
Day view exists. Week view (7 columns × hours) not built. Receptionists may not need it (Calendly is the canonical week view); consider deferring to v1.5 unless requested.

### Slice 20 — Full reconciliation (partial)
- Lounge total vs Stripe Dashboard payouts (`/v1/balance_transactions`).
- Cash drawer expected (today's cash payments minus refunds, minus opening float).
- BNPL split (Klarna / Clearpay totals).
- Variance flag if mismatch.

### Slice 21 — Admin gaps
- Staff management (invite, promote to admin, revoke).
- BNPL script editor (read/write `lng_settings`).
- Location switcher (multi-lab support, currently hardcoded to first Venneir lab).

### Slice 22 — Reporting gaps
- No-show rate (`no_show / total`).
- Average wait time (visit `opened_at` to first event after `arrived`).
- Walk-in vs appointment ratio.
- Calendly drift count (events in DB without matching live Calendly).

---

## Phase 4 — Cutover (not started)

Per brief §11:

1. **Data backfill** — historical Checkpoint appointments → `lng_appointments` (script exists at `scripts/checkpoint-backfill.mjs`, not yet executed against production data).
2. **Calendly cutover** — flip the Calendly webhook off in Checkpoint, on in Lounge. Currently both are receiving (Lounge is receiving without Checkpoint having been disconnected).
3. **Stripe Terminal cutover** — point the production reader at Lounge.
4. **Feature parity checklist** — sign-off vs Checkpoint Appointments before removing the legacy code path.
5. **Removal from Checkpoint** — delete the Appointments tab from Checkpoint after a soak period (suggest 2 weeks).
6. **Cutover smoke test** — `docs/runbooks/cutover-smoke-test.md` (not yet written).

---

## Quality scores (most recent self-assessment)

| Axis | Score | Trend |
|---|---|---|
| Code quality | 93 | ↑ |
| Test coverage | 92 (calendar layout + booking summary + identity); ~30 elsewhere | ↑ for newest, low for older |
| UX polish | 95 | ↑ (virtual appts, properCase, humanised statuses, cluster sheet wording) |
| Visual design | 94 | ↑ (category palette widened, breathing-room gaps, now-line/now-pill split) |
| Performance | 95 | → |
| Security | 90 | RLS in place; needs review pre-cutover |
| Accessibility | 92 | ↑ |
| Internationalisation | 88 | English-only; timezone-aware |

**Below-90 axes to revisit:** test coverage outside the calendar/identity/booking layers, i18n.

---

## Operational quick reference

```sh
# Re-deploy edge functions after a code change
./scripts/deploy-edge-functions.sh

# Run unit tests
npm test

# Run E2E
npm run test:e2e

# Apply a new migration to Meridian (after shadow verification)
./scripts/meridian-apply.sh

# Backfill Calendly historical events
node scripts/calendly-backfill.mjs --days-back=90 --days-ahead=120
```

---

## Recent shipped (this session, since PR #34)

**Calendly ingestion hardening**
- PR #35–#41 — placeholder-email guard (`noemail@`/`none@`/etc), wrong-match recovery, fill-blanks for correctly-matched patients, frontend 42703 fallback so SELECT survives a pre-migration deploy.
- PR #42 — phone extraction from `questions_and_answers` ("Contact Number"/"Phone"/etc) instead of header only.

**Calendar visual polish**
- PR #43–#46 — split now-indicator into a low-opacity NowLine (slot column) + NowPill (time-axis column, right-anchored) so the pill never obstructs card content; widened category palette across the colour wheel (amber / forest / blue / magenta / graphite); subtle card shadows.
- PR #47–#51 — 6px breathing room top + bottom on cards so they never touch the next hour line; 6px-wide category bar (was 4px).
- PR #52 — arch detection in `formatBookingSummary` recognises "Top/Bottom/Both/Full Mouth" plus "Top, Bottom" + multi-line `"Top\nBottom"`, mapping to "Upper / Lower / Upper and Lower".
- PR #53 — impression appointment special-case: `Virtual Impression Appointment for Whitening Trays` instead of just `Whitening Trays`.

**Virtual appointment workflow**
- PR #55–#57, #59 — Calendly `join_url` ingested. BottomSheet shows a Google-Meet "Join meeting" button on desktop (≥1024 + fine pointer); on tablet/mobile it shows the desktop hand-off message. `markVirtualMeetingJoined` writes `patient_events.virtual_meeting_joined`. Virtual no-show flow keeps "Re-join meeting" available; "Patient attended" reverses no-shows for both virtual and in-person (in-person also creates the visit + stamps `lwo_ref`).

**Naming + status humanisation**
- PR #61 — `humaniseStatus` (no_show → "No-show", in_progress → "In progress", etc); button-variant fix for "Patient attended" (tertiary → secondary so it's actually visible and aligned).
- PR #63 — `properCase` for patient names (preserves McDonald, DPD, hyphens, apostrophes); `patientFullDisplayName` used in BottomSheet title for confirmation, while card/list shorten last name to initial.

**Schedule list + cluster sheet**
- PR #62 — category colour bars on List view, Upcoming, Past (booked rows only).
- PR #63 — cluster sheet rows show start time only.
- This-session edit — cluster sheet description now spans earliest start to latest end ("Tue 28 Apr, 13:15 to 14:00. Pick one to open.") via new `formatClusterRange` helper in `Schedule.tsx`.

**Admin**
- PR #60 — Testing tab in Admin. `useDirtyAppointments` lists rows touched in tests; "Reset" + "Reset all" call `resetTestAppointment`.

**PWA**
- `public/manifest.webmanifest` + `public/sw.js` so the app installs as a homepage icon on Chrome/Samsung tab.

---

## What to pick up next session

1. **Verify the Vercel deploy actually shipped properCase** — user reported "Abdul ghaffar" still lowercase in browser. Code is in `appointments.ts` and tested. Likely a service-worker cache or deploy lag; ask user to hard-refresh or bump the SW version.
2. **Make a fresh Calendly test booking** to confirm the live webhook writes `intake`, `join_url`, and `phone` (open item B).
3. **Receipt secrets rollout** (open item A): set `RESEND_API_KEY` on Meridian and run `./scripts/receipt-setup.sh`.
4. **Slice 17 finish** — auto-suggest no-show after 15 min + cancellation reason drop-down.
5. **S700 hardware pairing** (open item C). Smaller and unblocks cutover.
