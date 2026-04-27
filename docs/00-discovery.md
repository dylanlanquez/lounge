# 00. Lounge — Phase 0 Discovery

**Audit date:** 27 Apr 2026
**Author:** Claude (under Dylan's direction)
**Status:** Draft, awaiting sign-off
**Companion docs:**
- [`00b-meridian-schema-delta.md`](./00b-meridian-schema-delta.md) — PATIENTS.md verified vs migrations
- [`00c-lab-scanner.md`](./00c-lab-scanner.md) — Lab Scanner audit + scope decision
- [`00d-unknown-unknowns.md`](./00d-unknown-unknowns.md) — sweep beyond user's notes
- [`03-calendly-audit.md`](./03-calendly-audit.md) — Calendly integration state + ADR Option A
- [`04-stripe-terminal-state.md`](./04-stripe-terminal-state.md) — Stripe Terminal state (zero hits)

---

## 1. Executive summary

| Area | Verdict |
|---|---|
| **Meridian schema vs PATIENTS.md** | Materially correct. One cosmetic index-name drift. Zero `lng_` collisions. Receptionist role does not exist yet — must be added in Phase 1 slice 1. |
| **Checkpoint Appointments** | Already comprehensively documented in `current-checkpoint-research/APPOINTMENTS-AND-WALKINS.md`. Three new findings beyond the user's notes (walk-in dispatch/shipping, walk-in settings, dormant `job_box`). |
| **Lab Scanner** | Stays in Checkpoint. Lounge cross-links via deep-link and read-only badges. |
| **Calendly integration** | Today: pull-only with a personal access token, no webhooks, manual sync. Adopt brief's **Option A** (Calendly stays as the booking surface) for v1; add webhooks for the freshness guarantee. |
| **Stripe Terminal** | **Zero production code in Checkpoint.** No `stripe` package, no edge functions, no migrations, no env keys. Leapfrog (§5.1 of brief) is risk-free. |
| **BNPL** | Today's Klarna/Clearpay flow routes through Shopify with the ref recorded back. The brief mandates a fundamentally different model (virtual Visa via S700, no Shopify-invoice route). Migration must mark legacy rows distinctly. |
| **Lounge can begin Phase 1** | After: (a) user signs off on this discovery, (b) BNPL staff guide content is dropped into `bnpl-staff-guide/`, (c) Stripe dashboard checks listed in `04 §1` are done by the user. |

---

## 2. Architecture decisions confirmed by Phase 0 evidence

The brief asserts three decisions before Phase 0 (`§0` of the brief). Each is **upheld** by the audit:

### 2.1 Lounge runs on Meridian's Supabase (`npuvhxakffxqoszytkxw`)

Confirmed by audit. The reasoning in the brief §3.1 is intact:
- `patients.lwo_ref`, `patients.lwo_contact_id` already exist (`20260422_03`, `20260419_04`).
- `patient_files` is patient-scoped — exactly the shape Lounge needs.
- Fill-blanks merge rule, per-location email uniqueness, `auth_*()` helpers, `case-files` bucket — all production-grade and reusable.
- A separate Lounge project would mean duplicate identity infrastructure on a schema that explicitly anticipated this integration.

**User direction (received during this Phase 0 session):** Use Meridian's project as the brief specifies. The new project `vkgghplhykavklevfhkz` you created is **parked as a fallback** — to be activated only if a future scoping decision (e.g. multi-region split, separate compliance boundary) makes it necessary. Document in the ADR (`docs/01-architecture-decision.md`, written next phase) and do not delete the project; leave it idle.

### 2.2 Stripe Terminal is built natively in Lounge from day one

Verified — see `04-stripe-terminal-state.md`. There is nothing to migrate, nothing to deprecate. The Stripe webhook URL gets registered against Lounge's edge function when that function exists.

### 2.3 All Lounge-domain tables use the `lng_` prefix

Namespace verified clean — `00b §7`. Zero collisions across migrations and source code.

---

## 3. Separation diagram

The system as it will look after Phase 4 cutover. Bold = new in Lounge; italic = unchanged Checkpoint surface that Lounge cross-links.

```
                              ┌────────────────────────────────────────────────────┐
                              │  Meridian Supabase project (npuvhxakffxqoszytkxw)  │
                              │                                                    │
                              │   patients ─────────────┐                          │
                              │     (existing, shared)   │                          │
                              │                          │                          │
                              │   patient_files          │                          │
                              │   patient_events         │                          │
                              │   accounts               │                          │
                              │   locations              │                          │
                              │   location_members       │                          │
                              │   case-files (storage)   │                          │
                              │                          │                          │
                              │   ── new in Lounge ──    │                          │
                              │   lng_appointments ──────┤                          │
                              │   lng_walk_ins ──────────┤                          │
                              │   lng_visits ────────────┤                          │
                              │   lng_calendly_bookings  │                          │
                              │   lng_carts                                         │
                              │   lng_cart_items                                    │
                              │   lng_payments                                      │
                              │   lng_terminal_payments                             │
                              │   lng_terminal_readers                              │
                              │   lng_terminal_sessions                             │
                              │   lng_receipts                                      │
                              │   lng_receptionist_sessions                         │
                              │   lng_settings                                      │
                              │   lng_event_log                                     │
                              │   lng_system_failures                               │
                              │   lng_lwo_sequences                                 │
                              │                                                    │
                              │   ── new edge functions ──                         │
                              │   calendly-webhook                                 │
                              │   calendly-backfill (admin)                        │
                              │   calendly-reconcile (cron)                        │
                              │   terminal-start-payment                           │
                              │   terminal-webhook                                 │
                              │   terminal-cancel-payment                          │
                              │                                                    │
                              │   ── existing, untouched ──                        │
                              │   shopify-orders-webhook                           │
                              │   checkpoint-walkin-identities                     │
                              │   portal-page                                      │
                              └─────────────────────────┬──────────────────────────┘
                                                        │
                                                        │  same Supabase Auth
                                                        │  (receptionist role added
                                                        │  to lab_role enum)
                                                        ▼
                              ┌────────────────────────────────────────────────────┐
                              │  Lounge frontend (React 19 + Vite)                 │
                              │  lounge.venneir.com                                │
                              │  Galaxy Tab S10 FE (primary), mobile (secondary),  │
                              │  desktop (admin)                                   │
                              └────────────────────────────────────────────────────┘

                              ┌────────────────────────────────────────────────────┐
                              │  Checkpoint Supabase project (emonsrrhflmwfsuupibj)│
                              │                                                    │
                              │   ── stays here, untouched ──                      │
                              │   walk_ins (legacy data, frozen post-cutover)      │
                              │   calendly_bookings (legacy)                       │
                              │   payments_cash / _card / _split / _klarna /       │
                              │     _clearpay (legacy)                             │
                              │   lwo_scans (still receives writes)                │
                              │   lwo_catalogue (still authoritative for lab line  │
                              │     items, shared with Lounge via cross-project    │
                              │     read OR migrated — see Phase 4 plan)           │
                              │                                                    │
                              │   ── stays as live Checkpoint surface ──           │
                              │   /lab/scan       (Lab Scanner)                    │
                              │   /lab/checkin    (Lab check-in/check-out)         │
                              │   shipping queues, materials dispatch              │
                              │   admin / reporting / inbox / etc.                 │
                              └────────────────────────────────────────────────────┘

                              ┌────────────────────────────────────────────────────┐
                              │  External services                                 │
                              │   Calendly       — webhooks → Lounge               │
                              │   Stripe (new direct account) — Terminal API       │
                              │   Stripe webhooks → Lounge                         │
                              │   Shopify        — unchanged                       │
                              │   DPD / ShipTheory — called from Checkpoint;       │
                              │     Lounge can invoke via cross-product edge fn    │
                              │   Resend (email) — reuse for receipts              │
                              │   SMS provider   — none today; Twilio TBD v1.5     │
                              └────────────────────────────────────────────────────┘
```

### What moves, what stays, what is shared

| Surface | Today | After cutover |
|---|---|---|
| Walk-in check-in / till / payment | Checkpoint | **Lounge** |
| Calendly bookings view | Checkpoint | **Lounge** |
| Calendly inbound | Pull-only sync | **Push via webhook → Lounge** |
| Stripe Terminal | Not built | **Built in Lounge** |
| EPOS checkout (cart, line items) | Manual notes + lwo_catalogue lookup | **Lounge** with full line-item, discount, mixed-tender support |
| BNPL (Klarna / Clearpay) | Shopify-routed, ref recorded | **Lounge: virtual Visa via S700, no Shopify** |
| Refunds | Stripe dashboard manual | **Lounge UI for same-day card terminal refund; historical via Stripe API** |
| Receipts (email / SMS / print) | Not implemented | **Lounge: email + SMS in v1, print v1.5** |
| Lab Scanner | Checkpoint `/lab/scan` | _Stays in Checkpoint_, deep-link from Lounge |
| Walk-in collected/shipped checkout | Checkpoint `LabCheckOutModal` | **Lounge owns the decision**, Checkpoint edge functions still book DPD/ShipTheory |
| `lwo_catalogue` | Checkpoint table | **Read by Lounge** during cutover; migrated to `lng_catalogue` post-cutover |
| Tech scan timestamps on walk-in | Checkpoint `walk_ins.tech_*` | Keep in Checkpoint table during cutover; migrate to `lng_visits` post-cutover |
| Patient identity / `patients` table | Meridian | _Stays in Meridian_, Lounge writes to it via fill-blanks rule |
| Patient files (consent, intake photos) | Meridian `patient_files` | _Stays in Meridian_, Lounge writes via existing storage path conventions |
| `patient_events` audit log | Meridian | _Stays in Meridian_, Lounge writes patient-axis events here |

---

## 4. Risk register

Severity scale: **Critical** (blocks production), **High** (likely incident), **Medium** (operational pain), **Low** (cosmetic).

| # | Area | Risk | Severity | Mitigation |
|---|---|---|---|---|
| R1 | **Architecture** | User created a new Supabase project (`vkgghplhykavklevfhkz`) before the brief was followed. Brief specifies Meridian's project. **Resolved this session:** use Meridian's; park the new project as a fallback. | High | Document in ADR. Do not delete; do not migrate to. |
| R2 | **Auth** | Receptionist role does not exist in `accounts.member_type` or `location_members.lab_role`. Phase 1 slice 1 (Receptionist sign-in) is blocked until added. | Medium | Migration in slice 1: `ALTER TYPE lab_role_enum ADD VALUE 'receptionist'`. See `00b §6`. |
| R3 | **BNPL** | Today's Klarna/Clearpay rows live in `payments_klarna` / `payments_clearpay` and are Shopify-tagged. Brief mandates Stripe Terminal flow with no Shopify involvement. Migration must distinguish legacy rows. | High | Backfill historical rows into `lng_payments` with `payment_journey = 'klarna_legacy_shopify'` (or similar). Confirm exact tag in Phase 4 cutover plan. |
| R4 | **BNPL** | `bnpl-staff-guide/` folder was missing — created in this session as empty stub. Helper component cannot be built until the user drops the docx in. | Medium | Phase 1 slice 12 (BNPL helper) is blocked on content. Other slices can proceed. |
| R5 | **Calendly** | Today's integration has no webhooks. The brief's freshness smoke test (§4.4: "a booking made 10 seconds ago is visible") cannot be met without one. | High | Subscribe to `invitee.created`, `invitee.canceled` in Phase 1 slice 3. Verify Calendly plan tier supports webhooks (Standard or higher). |
| R6 | **Calendly** | PAT can be revoked silently (login email change, password change, etc.). No alerting today. | Medium | Add admin "test connection" card in Lounge admin; weekly cron that pings `/users/me`. Failure → row in `lng_system_failures`. |
| R7 | **Calendly** | Browser-side `CalendlyWidget` exposes the PAT in dev tools. | Medium | Move widget reads through a Lounge edge function in v1.5. Acceptable for v1 internal use. |
| R8 | **Stripe Terminal** | If webhook URL is registered before the function is deployed, Stripe sends events to a 404 and retries for 24h before dropping. | High | Deploy and `curl`-verify before clicking "Add endpoint" in Stripe Dashboard. |
| R9 | **Stripe Terminal** | Wrong Stripe account env var in production (legacy HubSpot vs new direct). | Critical | `STRIPE_EXPECTED_ACCOUNT_ID` env var. Account ID assertion at edge function startup. |
| R10 | **Stripe Terminal** | Receptionist double-taps "Take payment". | Medium | Idempotency key per `(cart_id, attempt)`. Disabled button state during in-flight request. |
| R11 | **Stripe Terminal** | Reader offline at moment of payment — pending sale stuck. | Medium | Day-end reconciliation flags `lng_payments.status='processing'` for >5 min. Manual cancel via `terminal-cancel-payment`. |
| R12 | **Identity** | `accounts.account_id ON DELETE CASCADE` on `patients` (PATIENTS.md §10.8). Hard-deleted staff cascades patient deletes. | High | Soft-delete only. Document in `02-data-protection.md` and onboarding. |
| R13 | **Identity** | `patients.email` is per-location unique, not global. A query that joins across locations on email matches incorrectly. | Medium | All Lounge identity-resolution code (§6.1 of brief) scopes by `location_id`. Add automated test. |
| R14 | **LWO ref format conflict** | Checkpoint uses `LWO-YYYYMMDD-NNNN` (per-day counter). Brief §6.5 says `LWO-YYYY-MM-NNN` (per-month counter). | Medium | **Adopt Checkpoint format** to preserve historical refs (`LWO-20260427-0001` etc.). Update the brief's text when user signs off. `lng_lwo_sequences` keys on `(year, month, day)` not `(year, month)`. Confirm with user. |
| R15 | **Migrations** | Meridian ships fast (16 migrations on 27 Apr 2026 alone). A Lounge migration written today against a stale baseline can collide. | High | Migration ritual: read latest `~/Desktop/meridian-app/supabase/migrations/` filename before each Lounge migration. Use `_NN` suffix that does not collide. |
| R16 | **DPIA** | Existing DPIA may not cover tablet-based ingestion at point of service. | High | Confirm with user before go-live. Section in `02-data-protection.md` (Phase 0.7). |
| R17 | **Tablet privacy** | Reception desk + queue → screen visible to other patients. | Medium | Names truncated to first name + last initial on home screen; 60-second auto-lock with PIN re-entry. Brief §7.2. |
| R18 | **Receipts — SMS** | No SMS provider today. Twilio not integrated. Respond.io not used for transactional. | Medium | Email-only receipts in v1. SMS in v1.5 once provider is chosen. |
| R19 | **Receipts — print** | No printer is paired today. | Low | Defer print to v1.5 unless user reveals one is operational. |
| R20 | **Branding** | Brief §9.3 specifies forest green `#1F4D3A`. Favicon uses bright teal background with navy "L" — different palette. | Medium | Confirm with user in Phase 2. Either: (a) update favicon to brief palette, or (b) update brief palette to match favicon. Do not start design system work until resolved. |
| R21 | **Dispatch / shipping** | Walk-in dispatch (DPD/ShipTheory) is a Checkpoint surface today. Lounge inheriting it means a new Lounge edge function calls Checkpoint's. | Medium | Confirm scope with user (recommendation: Lounge owns the *decision*, Checkpoint owns the *carrier API call*). Add slice between brief §10.1 #16 and #20. |
| R22 | **Cross-product reads** | Lounge reading Checkpoint data (e.g. `lwo_scans`) during cutover requires either a service-role-keyed edge function or a Foreign Data Wrapper. | Low | Standard Supabase pattern; service-role from edge function is cheapest. Plan in Phase 4 cutover. |
| R23 | **Calendly plan tier** | Webhooks require Standard plan or higher. | Medium | Confirm in Phase 0.55 final pass. |
| R24 | **PAT scope (Calendly)** | Single Calendly user owns the PAT. If we add Glasgow + London + Motherwell as separate Calendly users, we need org-scope OAuth. | Medium | Scope decision deferred to v1.5. |
| R25 | **Phase 0 audit blind spot** | Checkpoint repo audit was code-level only — no live Supabase introspection (no DB credentials passed to Phase 0). Some `cpt_terminal_*` tables could exist in the DB but not in migrations on disk. Probability low (no migration found) but non-zero. | Low | Confirm via Supabase Studio when user is next in the dashboard. |
| R26 | **Realtime** | Today's Checkpoint Appointments has no realtime; staff at till + bench don't see each other's updates. Lounge will need realtime from day one. | Low | Standard Supabase realtime pattern. Built into the Phase 1 slice scope. |

---

## 5. Operational rituals (per brief §2.10)

The brief lists ten questions that need user input. They are listed below with my Phase 0 inferences; please confirm or correct:

| Question | My inference (please confirm) |
|---|---|
| How many walk-ins per day, per location? | **Unknown — please answer.** |
| How many scheduled appointments per day, per location? | **Unknown — please answer.** |
| Average payment value? Range? | **Unknown — please answer.** Stripe Terminal min is £0.30 GBP; max per transaction varies by reader, S700 supports up to ~£999 per contactless tap. |
| Cash vs card vs BNPL split? Other methods (gift cards, account credit, payment plans)? | **Unknown — please answer.** Today: card and split exist; BNPL is Shopify-routed. Brief says cash + card + BNPL in v1; gift cards and account credit deferred to v1.5 unless Phase 0 reveals they're already in use. **No evidence of gift card or account credit use today.** |
| Longest end-to-end walk-in flow today? | Likely: walk-in arrives without booking → check-in form (5 steps) → waiver signed → repair scoped → till → payment recorded → tech scan → lab → ready → handover. Probably 30–60 mins clock time, but UI-time (active screens) maybe 5–8 mins per visit. **Confirm.** |
| What goes wrong most often? | From `APPOINTMENTS-AND-WALKINS.md §10`: stale Calendly data when nobody opens the reports view, no realtime so till+bench don't sync, manual Shopify ref entry for BNPL is error-prone. **Confirm operational top-3.** |
| What does the receptionist do that is **not** in the code today? | **Unknown — please answer.** Common candidates: phone calls, paper waivers, paper LWOs, manual Shopify order creation for BNPL, mid-flight cash counting, end-of-day handovers. |

These inputs shape the Phase 1 slice priorities. Will pull into Phase 1 plan.

---

## 6. Open questions to user (consolidated)

Asked at Phase 0 mid-session:

| # | Question | Answer received |
|---|---|---|
| Q1 | Which Supabase project? | **Meridian's `npuvhxakffxqoszytkxw`.** New project parked. |
| Q2 | Where is the Checkpoint repo? | `~/Desktop/checkpoint-app/`. |
| Q3 | BNPL staff guide? | User dropping a docx into `bnpl-staff-guide/` (folder created stubbed). |

Outstanding (please answer to unblock Phase 0.55, 0.575, 0.7, and Phase 1):

| # | Question | Why we need it |
|---|---|---|
| O1 | Stripe Dashboard checks (account active, Terminal feature on, Location object created, S700 registered, webhook URL **not** yet registered) | `04 §1` — confirm before slice 8 starts. |
| O2 | Calendly plan tier | Webhooks require Standard or higher (`03 §3`). |
| O3 | Calendly user / scope (single user, multi-location?) | Affects whether we use user-scope or org-scope subscriptions. |
| O4 | LWO ref format — Checkpoint's `LWO-YYYYMMDD-NNNN` or brief's `LWO-YYYY-MM-NNN`? | `R14` — recommendation: use Checkpoint's to preserve historical refs. |
| O5 | Walk-in dispatch (collected/shipped) — does Lounge own this? | `R21`, `00d §1.1` — recommendation: Lounge owns the decision, Checkpoint owns the carrier API call. |
| O6 | Branding palette conflict (brief forest green vs favicon teal) | `R20` — pick one before Phase 2. |
| O7 | DPIA addendum coverage for tablet-based ingestion | `R16` — required before go-live. |
| O8 | Operational ritual answers (volume, average payment, split, longest flow, top-3 problems, what's not in code) | `§5` above — shape Phase 1 slice priorities. |
| O9 | Daily walk-in volume + Calendly volume per location | Capacity planning + API rate-limit budgeting (`§5`). |
| O10 | Existing receipt printer — paired or absent? | `R19` — defer print to v1.5 if absent. |

---

## 7. What we will NOT do in v1

Restating from the brief plus Phase 0 findings:

- No Lounge-owned native booking page (Calendly Option C is v2+).
- No printed receipts unless a printer is paired (deferred to v1.5).
- No SMS receipts unless an SMS provider is chosen (deferred to v1.5).
- No gift cards or account credit (deferred to v1.5).
- No drag-to-reschedule on tablet (brief §9.4.5).
- No partial refunds on the same card terminal action (refund modal handles same-day full refund + historical via Stripe API).
- No multi-currency (GBP only).
- No Cairo / second-location readers (architecture supports it, just not configured).
- No Shopify-invoice route for BNPL (replaced; brief §5.6.5).
- No Lab Scanner duplication in Lounge (`00c`).
- No Apple Pay / Google Pay payment integration *as such* — these come naturally through Stripe Terminal contactless (they ARE the BNPL hand-off mechanism for Klarna/Clearpay).
- No tipping (brief §5.13).

---

## 8. Phase 0 sign-off checklist

Before Phase 0.5 / 0.55 / 0.575 / 0.6 / 0.7 begin, please confirm in writing:

- [ ] Outcome of `00b` (schema verified — receptionist role addition acknowledged)
- [ ] Outcome of `00c` (Lab Scanner stays in Checkpoint — deep-link from Lounge)
- [ ] Outcome of `00d` (three new findings + BNPL conflict + dispatch question)
- [ ] Outcome of `03` (Calendly Option A, webhook addition, plan tier check)
- [ ] Outcome of `04` (Stripe Terminal leapfrog — risk-free)
- [ ] Risk register reviewed; mitigations accepted
- [ ] Outstanding questions O1–O10 answered (or marked deferred to a later phase)
- [ ] Discovery doc score self-assessment (below) acceptable

---

## 9. Self-assessment scorecard

Per brief §1 ("Score every output out of 100"):

| Axis | Score | Notes |
|---|---|---|
| Completeness vs brief §2.11 | 92 | All six required docs produced. Outstanding questions O1–O10 are user-side, not audit-side gaps. Could be 95+ once O1, O2, O3 are answered. |
| Verifiability (every claim cites a file or migration) | 95 | All major claims trace to a file path. PATIENTS.md verification tied to specific migration filenames. |
| Risk register depth | 90 | 26 risks identified across 7 areas. Severity calibrated. Could be 95+ with operational data from §5. |
| Faithfulness to brief | 95 | No architectural decisions revisited without flagging. New project conflict surfaced and resolved with user. BNPL conflict surfaced honestly. |
| Readability | 90 | Tables and headings, friendly tone. Six docs cross-link cleanly. Long, but the brief asked for thoroughness. |
| **Aggregate** | **92** | Above the brief's 90 floor. No stop-and-improve trigger. |

---

*End of Phase 0 discovery. Awaiting sign-off before any code is written.*
