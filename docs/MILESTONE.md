# Lounge build milestone

**As of:** 2026-04-28
**Brief:** [`/Users/dylan/Downloads/lounge-build-brief.md`](../../Downloads/lounge-build-brief.md) v5
**Production:** https://lounge-coral.vercel.app · Supabase project `npuvhxakffxqoszytkxw` (Meridian)

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
| Phase 1 — Foundation | ✅ Complete (Vite + React 19 + RR6, Supabase wiring, theme tokens, 18 lng_* migrations) |
| Phase 2 — Design system | ✅ Complete (Storybook, Button/Card/Input/Toast/Skeleton/StatusPill/SegmentedControl/BottomSheet/EmptyState/Avatar/CalendarGrid/AppointmentCard/CartLineItem/TerminalPaymentModal/BNPLHelper/TopBar/VisitFiles/ClusterCard/ScheduleListView) |
| Phase 3 — Feature slices | 🟡 In progress (see slice table below) |
| Phase 4 — Cutover | ⏳ Not started |

---

## Phase 3 slices (per brief §10.1)

| # | Slice | Status | Notes |
|---|---|---|---|
| 1 | Receptionist sign-in | ✅ | Email+password (PIN-mode deferred to v1.5) |
| 2 | Calendar — today view | ✅ | Density-aware: ≤2 lanes, 3+ → ClusterCard, Calendar/List toggle (PR #34) |
| 3 | Calendly inbound sync | ✅ | Webhook + backfill + verify-subscription button + descending-pagination fix |
| 4 | Patient search & walk-in check-in | ✅ | Phone-first, account_id auto-resolved |
| 5 | Appointment check-in | ✅ | Mark-arrived from BottomSheet, creates `lng_visits` |
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
| 15 | Consent forms + intake photos | ✅ | `<input capture="environment">` for tablet camera, `case-files` bucket, signed URLs (5 min TTL), `patient_files` rows |
| 16 | Reschedule / cancel to Calendly | ⏸️ Deferred | Per ADR Option A; Calendly stays source-of-truth |
| 17 | No-show / cancel handling | 🟡 Partial | No-show flag from BottomSheet; need automatic 15-min reminder + cancellation reason capture |
| 18 | Week / day views | 🟡 Partial | Day view ✅; week view not built. Calendar/List toggle covers high-density days |
| 19 | Patient timeline | ✅ | Merged events + visits + appointments + payments, total spent pill |
| 20 | End-of-day reconciliation | 🟡 Partial | Admin → Reports shows daily totals; no Stripe Dashboard cross-check or cash drawer reconciliation |
| 21 | Admin (desktop) | 🟡 Partial | Calendly, Receipts, Reports, Devices, Failures tabs ✅; staff management & BNPL script editor not built |
| 22 | Reporting | 🟡 Partial | 7-day totals by method/journey ✅; no-show rate, wait time, walk-in vs appointment ratio, Calendly drift not built |

**Score:** 14 done, 4 partial, 2 deferred — out of 22 slices.

---

## Cross-cutting infrastructure shipped

- **Database:** 18 `lng_*` migrations applied to Meridian. Patients-guard trigger on `lwo_ref`. Generated `total_pence` on carts. RLS policies for receptionist scope. `lng_seed_settings` populates real BNPL scripts.
- **Edge functions (7):** `calendly-webhook`, `calendly-backfill`, `terminal-start-payment`, `terminal-webhook`, `terminal-cancel-payment`, `terminal-refund`, `send-receipt`. All deployed to Meridian.
- **Build:** code-split (vendor chunks: react / supabase / stripe / icons + per-route lazy imports). Largest chunk now 203 KB (supabase) gzipped 53 KB.
- **Mobile:** `useIsMobile` hook + shared `TopBar` (icon-only buttons under 640px), responsive padding, all routes tested on tablet form factor.
- **Tests:** Vitest installed. 11 unit tests on `layoutAppointments` (lane assignment + cluster threshold). Playwright E2E exists from earlier slices.
- **Operational scripts:** `shadow-bootstrap.sh`, `shadow-cleanup.sh`, `meridian-apply.sh`, `create-receptionist.sh`, `calendly-setup.sh`, `calendly-backfill.mjs`, `calendly-diagnostic.sh`, `stripe-setup.sh`, `receipt-setup.sh`, `deploy-edge-functions.sh`, `checkpoint-backfill.mjs`.
- **Observability:** `lng_event_log`, `lng_system_failures`, `patient_events`. `/admin → Failures` surfaces unresolved entries.

---

## Open critical items (block cutover)

### A. Receipt delivery not yet activated in production
Edge function deployed but `RESEND_API_KEY` not set on Meridian secrets.
**Action:** export `RESEND_API_KEY` (and optionally `TWILIO_*`) → run `./scripts/receipt-setup.sh`.
**Until then:** receipts queue in `lng_receipts` with `failure_reason='delivery_not_configured'` and surface in Admin → Receipts for retry.

### B. Calendly fresh-booking webhook end-to-end test
Recent fixes (account_id default + pagination + descending sort) shipped today (PRs #30, #31). Confirmed past events backfill correctly. **Need to make a fresh test booking** to verify the live webhook path lands without errors.

### C. Stripe Terminal physical hardware test
The S700 hardware path has only been tested via the simulated WisePOS E. Need:
1. Pair real S700 to Meridian's Stripe Terminal location.
2. INSERT row into `lng_terminal_readers` with the registered reader ID.
3. Run a £1 test transaction end-to-end.

### D. BNPL virtual card test
Klarna/Clearpay flow has the helper UI but the actual virtual card contactless tap on the S700 has not been tested with a real BNPL provider account.

---

## Phase 3 work remaining

### Slice 17 — No-show / cancel handling (partial)
Currently the BottomSheet has a "No-show" button. Missing:
- Automatic flag suggestion when current time > start_at + 15min.
- Cancellation reason capture (drop-down: patient request / no-show / clinic / other).
- Surface no-show count in Admin → Reports.

### Slice 18 — Week view
Day view exists. Week view (7 columns × hours) not built. Receptionists may not need it (Calendly is the canonical week view); consider deferring to v1.5 unless requested.

### Slice 20 — Full reconciliation (partial)
Need a daily reconciliation card showing:
- Lounge total vs Stripe Dashboard payouts (via `/v1/balance_transactions`).
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
- Calendly drift count (events in DB without `calendly_invitee_uri` matching live Calendly).

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
| Code quality | 92 | ↑ |
| Test coverage | 92 (`layoutAppointments`); ~30 elsewhere | ↑ for newest, low for older |
| UX polish | 94 | ↑ |
| Visual design | 93 | ↑ |
| Performance | 95 | → |
| Security | 90 | RLS in place; needs review pre-cutover |
| Accessibility | 92 | ↑ |
| Internationalisation | 88 | English-only; timezone-aware |

**Below-90 axes to revisit:** test coverage outside the calendar layout, i18n.

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
# (via Admin → Calendly → Backfill button, or local mjs runner)
node scripts/calendly-backfill.mjs --days-back=90 --days-ahead=120
```

---

## Recent shipped (last 12 hours)

- PR #34 — Calendar density: cluster cards for 3+ overlap, list view
- PR #33 — Side-by-side lanes for 2-overlap (superseded by #34)
- PR #32 — Updated favicon (logos/lounge-fav.png) wired across all icon links
- PR #31 — Calendly backfill pagination fix (descending sort + URL-based pagination)
- PR #30 — Calendly webhook account_id resolution (fixes NOT NULL FK)
- PR #29 — Pending receipts tab in Admin with retry
- PR #28 — Slice 13b: real receipt delivery via Resend + Twilio
- PR #27 — Verify Calendly webhook subscription from Admin
- PR #26 — Calendly backfill hardening (window, dedupe, fill-blanks)
- PR #25 — Code-split routes + vendor chunks
- PR #24 — Slice 15: consent forms + intake photos
