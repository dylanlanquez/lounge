# 01. Architecture decisions

**Status:** Draft, awaiting sign-off
**Covers:** Phase 0.5, Phase 0.55, Phase 0.575
**Authors:** Dylan (deciding), Claude (drafting)
**Date:** 27 Apr 2026
**Supersedes:** none
**Related:**
- `00-discovery.md` — Phase 0 evidence underpinning each decision
- `00b-meridian-schema-delta.md` — schema baseline
- `03-calendly-audit.md` — Calendly evidence
- `04-stripe-terminal-state.md` — Stripe Terminal evidence

---

## 1. ADR-001 — Lounge runs on Meridian's Supabase project

### 1.1 Status

**Accepted.** Pre-decided by Dylan before brief v5; verified against Phase 0 evidence; user reaffirmed during Phase 0 session.

### 1.2 Context

Lounge needs a database. The two realistic options:

- **A. Reuse Meridian's project** (`npuvhxakffxqoszytkxw`).
- **B. Spin up a new project** for Lounge.

A second Supabase project (`vkgghplhykavklevfhkz`) was created during the Phase 0 session but was **not** intended as a replacement of Meridian — it is parked as a fallback.

### 1.3 Decision

**Use Meridian's project.** All Lounge-domain tables live in the `public` schema with the `lng_` prefix. Lounge users authenticate against the same Supabase Auth, scoped by `auth_location_id()`.

### 1.4 Reasoning (sourced from `00b`)

1. `patients.lwo_ref` (`20260422_03`), `patients.lwo_contact_id` (`20260419_04`), `patients.shopify_customer_id` (`20260411_11`), `patients.location_id` (`20260413_01`) all already exist. The schema explicitly anticipates Checkpoint walk-in linkage.
2. `patient_files` (with the `case-files` private storage bucket and a sign-on-demand pattern) is already production-grade and patient-scoped — the exact shape Lounge needs for consent forms and intake photos.
3. The fill-blanks merge rule is enforced in `shopify-orders-webhook` and `checkpoint-walkin-identities` (PATIENTS.md §6). Lounge inherits the rule by reusing `patients` rather than mirroring.
4. Per-location email uniqueness (`patients_email_per_location_unique`, partial index, 20260423_01:88) — the rule the brief explicitly calls out.
5. The auth helpers `is_admin()`, `auth_account_id()`, `auth_location_id()` are reused everywhere. Lounge RLS policies key off the same helpers.
6. The `case-files` bucket and signed-URL pattern is production-grade. Lounge writes consent forms and intake photos here using the same pattern.
7. A separate Lounge project would mean duplicate identity infrastructure on top of a schema that explicitly anticipated this integration. It would also force a cross-project sync for `patients`, doubling the failure surface.

### 1.5 Consequences

#### Positive

- Zero duplication of identity, files, audit trail, RLS helpers.
- Patient timeline in Meridian admin surfaces Lounge visits naturally (write to `patient_events`).
- Single Supabase Auth → no SSO, no cross-project token mapping.

#### Negative / risks

- Lounge migrations must be coordinated against Meridian's fast-moving migration timeline (R15). Mitigation: read latest `~/Desktop/meridian-app/supabase/migrations/` filename before each Lounge migration; never apply to production without diffing first.
- A breaking change on `patients` impacts both products. Mitigation: any change to `patients` shape goes through both teams (Dylan today; later, anyone else).
- A bad Lounge migration could leak into Meridian admin (e.g. an RLS hole). Mitigation: every Lounge migration runs on a Supabase branch first, gets reviewed, then applied.

#### Fallback

The parked project (`vkgghplhykavklevfhkz`) remains available. Activate **only** if a future scoping decision (e.g. multi-region split, separate compliance boundary, divestiture of Lounge as a standalone product) makes it necessary. Do not delete; do not migrate to.

### 1.6 Implementation rules

- All Lounge-domain tables: `public.lng_*`.
- All Lounge edge functions: same Supabase project; deployed via `npx supabase functions deploy <name> --project-ref npuvhxakffxqoszytkxw`.
- Migrations: `~/Desktop/lounge-app/supabase/migrations/`, filenames `YYYYMMDD_NN_lng_<description>.sql` to make Lounge-origin obvious in the file list.
- Edge function module-level constants:
  ```ts
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
  const EDGE_HEADERS = { Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' };
  ```
  Per brief §8.5.

### 1.7 Schema scaffold (locked, will go into Phase 1 slice 0)

Top-level Lounge tables, in dependency order:

```
lng_settings                 (per-location config, BNPL scripts, currency, etc.)
lng_lwo_sequences            (counter for generate_lwo_ref())
lng_terminal_readers         (S700 hardware registry)
lng_terminal_sessions        (terminal connection state, pairing history)
lng_calendly_bookings        (raw Calendly webhook payloads, idempotency-keyed)
lng_appointments             (cleaned, queryable view of appointments regardless of source)
lng_walk_ins                 (drop-ins without prior booking, FK patients)
lng_visits                   (unifying record — appointment-visit OR walk-in-visit)
lng_carts                    (open cart attached to a visit)
lng_cart_items               (line items inside a cart)
lng_payments                 (payment attempts and outcomes, any method/journey)
lng_terminal_payments        (Stripe-Terminal-specific detail rows, FK lng_payments)
lng_receipts                 (issued receipts: print/email/SMS/none)
lng_receptionist_sessions    (who is signed in at which tablet, idle/lock state)
lng_event_log                (Lounge-internal ops events)
lng_system_failures          (structured failure sink)
```

Plus updates to existing Meridian objects:

```
ALTER TYPE lab_role_enum ADD VALUE 'receptionist'
helper auth_is_receptionist()  (new SQL function)
generate_lwo_ref()             (new SQL function — see 06-patient-identity.md §5)
```

Final column-level shape locked in `06-patient-identity.md` and the Phase 1 migration spec; this section is the contract that the Phase 1 migrations honour.

---

## 2. ADR-002 — Calendly Option A for v1, Option B for v1.5

### 2.1 Status

**Accepted.**

### 2.2 Context

Per brief §4.2 and `03-calendly-audit.md`:

- **Option A.** Calendly hosts the booking page. Lounge subscribes to webhooks. Lounge is read-mostly on appointments. Reschedule/cancel happen via Calendly's own URLs.
- **Option B.** Lounge is the source of truth. Calendly continues hosting the public booking page. Lounge mirrors every booking via webhook AND can reschedule/cancel from Lounge by calling the Calendly API.
- **Option C.** Lounge replaces Calendly entirely with a native booking flow.

Today's integration is **pull-only with a personal access token, no webhooks, manual sync.** Adding Option C is a separate product (availability rules, slot picker, public booking page, SMS/email confirmations, ICS attachments). Option B is achievable but adds a sync surface.

### 2.3 Decision

**Option A for v1.** Webhooks added on top of the existing pull. Reschedule and cancel still use Calendly's own URLs. **Option B in v1.5** if operational evidence warrants it (drift, frequent receptionist re-typing, etc.).

### 2.4 Reasoning

1. Brief preference (§4.2 final paragraph).
2. The Phase 0 evidence shows Calendly is barely-integrated today (no webhooks). Replacing the manual sync with webhooks meets the freshness smoke test (§4.4) without re-implementing Calendly's product.
3. Cost is one new edge function (`calendly-webhook`) + one cron (`calendly-reconcile`). Two days of work, not two months.
4. Option C is a much bigger surface; deferring keeps the v1 scope tight.

### 2.5 Consequences

#### Positive

- Receptionist sees overnight bookings the moment she opens the tablet (webhook-driven).
- 10-second-old bookings appear; 10-second-old cancellations disappear (webhook-driven).
- Daily reconciliation against `/scheduled_events` catches missed deliveries.

#### Negative / risks

- Reschedule and cancel from Lounge are **not** supported in v1 — receptionist directs the patient to use the Calendly link in their email. Acceptable per brief.
- Webhook failures are silent unless we wire an alert. Mitigation: any webhook delivery older than 3 minutes (replay) or with an invalid signature writes to `lng_system_failures` with severity `warning`; the daily reconciliation job catches drift.
- Calendly plan tier must be **Standard or higher** for webhooks (R23). User to confirm.

### 2.6 Implementation rules

- New edge function `calendly-webhook`. **Public** at the Supabase level (Calendly doesn't authenticate via Supabase auth). First action: HMAC-SHA256 verify against `CALENDLY_WEBHOOK_SIGNING_KEY` over `<t>.<raw_body>`. Reject if `t > 3 min ago` (replay).
- Subscribe to `invitee.created`, `invitee.canceled`. (Reschedules surface as a cancel-then-create pair; the cancel payload's `rescheduled = true` lets us match.)
- `lng_calendly_bookings.delivery_id` is unique. Duplicate delivery → no-op insert.
- New edge function `calendly-backfill` (admin-only, behind anon-key Bearer JWT per §8.5). Reads `/scheduled_events` for a time window and replays each event through the same logic.
- New cron `calendly-reconcile` at 03:00 UTC daily. Compares `lng_appointments` next-14-day window against `/scheduled_events`. Drift → row in `lng_system_failures`.
- The browser-side `CalendlyWidget` exposure (R7) is acceptable for v1 internal use. Move to edge-function-mediated in v1.5.

### 2.7 Identity resolution on `invitee.created`

Per `06-patient-identity.md §4`. Concretely: when a new invitee is created, we attempt to match against `patients` using the priority order (lwo_ref → shopify_customer_id → email+location → phone → name+DOB). Match → fill-blanks update. No match → insert new `patients` row. Either way, `lng_appointments` is then created with `patient_id` pointing at the resolved patient.

A booking that never becomes a visit (no-show, cancellation) leaves the `patients` row in place but with no `lwo_ref` stamped. The first time the patient actually walks in or is checked in, `lwo_ref` is stamped at that point.

---

## 3. ADR-003 — Stripe Terminal: leapfrog, lng_terminal_*, native EPOS

### 3.1 Status

**Accepted.**

### 3.2 Context

Per brief §5.1 and `04-stripe-terminal-state.md`:

- The new direct Stripe account exists (the brief asserts; user to confirm via O1).
- The S700 hardware has arrived.
- **Zero Stripe Terminal code is in production today** — no `stripe` package, no edge functions, no migrations, no env vars, no test payments.

### 3.3 Decision

- **Lounge owns Stripe Terminal end-to-end from day one.** No completion-then-migrate from Checkpoint.
- The Stripe webhook URL is registered against **Lounge's** `terminal-webhook` edge function (`https://npuvhxakffxqoszytkxw.functions.supabase.co/terminal-webhook`).
- The S700 is registered to a Stripe Location object (`tml_xxx`); Lounge's `lng_terminal_readers` row maps friendly name → `stripe_reader_id`.
- All `*_terminal_*` tables are `lng_terminal_*` in Meridian's project. Not `cpt_terminal_*` in Checkpoint.
- `TerminalPaymentModal` and `BNPLHelper` are Lounge components built in the Lounge design system.

### 3.4 EPOS data model (locked)

Per brief §5.4. The "three roles, no overlap" rule (§5.4 final paragraph) is the contract.

```
lng_visits
  id                     uuid  PK
  patient_id             uuid  FK patients
  location_id            uuid  FK locations
  appointment_id         uuid  FK lng_appointments         (null for true walk-ins)
  walk_in_id             uuid  FK lng_walk_ins             (null when from appointment)
  status                 text  ('opened' | 'in_progress' | 'complete' | 'cancelled')
  arrival_type           text  ('walk_in' | 'scheduled')
  opened_at              timestamptz NOT NULL
  closed_at              timestamptz
  receptionist_id        uuid  FK accounts                 (the staff who opened)
  created_at             timestamptz NOT NULL DEFAULT now()
  updated_at             timestamptz NOT NULL DEFAULT now()
  -- exactly one of (appointment_id, walk_in_id) is non-null (CHECK)

lng_carts
  id                     uuid  PK
  visit_id               uuid  FK lng_visits UNIQUE        (one cart per visit)
  status                 text  ('open' | 'paid' | 'voided')
  subtotal_pence         int   NOT NULL DEFAULT 0
  discount_pence         int   NOT NULL DEFAULT 0
  tax_pence              int   NOT NULL DEFAULT 0
  total_pence            int   GENERATED ALWAYS AS (subtotal_pence - discount_pence + tax_pence) STORED
  opened_at              timestamptz NOT NULL DEFAULT now()
  closed_at              timestamptz

lng_cart_items
  id                     uuid  PK
  cart_id                uuid  FK lng_carts ON DELETE CASCADE
  sku                    text                              (catalogue key, nullable for custom)
  name                   text  NOT NULL
  description            text
  quantity               int   NOT NULL CHECK (quantity > 0)
  unit_price_pence       int   NOT NULL CHECK (unit_price_pence >= 0)
  discount_pence         int   NOT NULL DEFAULT 0
  line_total_pence       int   GENERATED ALWAYS AS (unit_price_pence * quantity - discount_pence) STORED
  sort_order             int   NOT NULL DEFAULT 0
  created_at             timestamptz NOT NULL DEFAULT now()

lng_payments
  id                     uuid  PK
  cart_id                uuid  FK lng_carts
  method                 text  NOT NULL
                              CHECK (method IN ('card_terminal', 'cash', 'gift_card', 'account_credit'))
  payment_journey        text  NOT NULL DEFAULT 'standard'
                              CHECK (payment_journey IN ('standard', 'klarna', 'clearpay',
                                                         'klarna_legacy_shopify',
                                                         'clearpay_legacy_shopify'))
  amount_pence           int   NOT NULL CHECK (amount_pence > 0)
  status                 text  NOT NULL
                              CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled'))
  failure_reason         text
  created_at             timestamptz NOT NULL DEFAULT now()
  succeeded_at           timestamptz
  cancelled_at           timestamptz
  taken_by               uuid  FK accounts                 (receptionist who initiated)
  notes                  text                              (internal, never on receipt)

lng_terminal_payments
  id                          uuid PK
  payment_id                  uuid FK lng_payments UNIQUE   (1:1 with lng_payments.method='card_terminal')
  stripe_payment_intent_id    text NOT NULL UNIQUE
  stripe_reader_id            text NOT NULL
  stripe_location_id          text NOT NULL
  idempotency_key             text NOT NULL UNIQUE
  reader_action_status        text                          (latest from Stripe API)
  created_at                  timestamptz NOT NULL DEFAULT now()
  succeeded_at                timestamptz
  raw_event                   jsonb                         (last webhook payload, for debug)

lng_terminal_readers
  id                     uuid  PK
  friendly_name          text  NOT NULL                    ("Motherwell counter")
  stripe_reader_id       text  NOT NULL UNIQUE             (tmr_xxx)
  stripe_location_id     text  NOT NULL                    (tml_xxx)
  location_id            uuid  FK locations
  status                 text  NOT NULL DEFAULT 'unknown'
                              CHECK (status IN ('online', 'offline', 'unknown'))
  last_seen_at           timestamptz
  created_at             timestamptz NOT NULL DEFAULT now()

lng_receipts
  id                     uuid  PK
  payment_id             uuid  FK lng_payments
  channel                text  NOT NULL
                              CHECK (channel IN ('print', 'email', 'sms', 'none'))
  recipient              text                              (email address or phone number)
  sent_at                timestamptz
  content                jsonb                             (rendered receipt body for replay)
  failure_reason         text
  created_at             timestamptz NOT NULL DEFAULT now()
```

#### Derived `paid_status` on a visit

**Never store as a column.** Always compute:

```sql
CREATE OR REPLACE VIEW public.lng_visit_paid_status AS
SELECT
  v.id AS visit_id,
  c.total_pence AS amount_due_pence,
  COALESCE(SUM(p.amount_pence) FILTER (WHERE p.status = 'succeeded'), 0) AS amount_paid_pence,
  CASE
    WHEN c.total_pence IS NULL OR c.total_pence = 0 THEN 'no_charge'
    WHEN COALESCE(SUM(p.amount_pence) FILTER (WHERE p.status = 'succeeded'), 0) >= c.total_pence
      THEN 'paid'
    WHEN COALESCE(SUM(p.amount_pence) FILTER (WHERE p.status = 'succeeded'), 0) > 0
      THEN 'partially_paid'
    ELSE 'unpaid'
  END AS paid_status
FROM public.lng_visits v
LEFT JOIN public.lng_carts c ON c.visit_id = v.id
LEFT JOIN public.lng_payments p ON p.cart_id = c.id
GROUP BY v.id, c.total_pence;
```

### 3.5 Edge functions

Per brief §5.5. Three functions, all in `supabase/functions/`:

- **`terminal-start-payment`**
  - Authenticated Lounge staff (anon-key Bearer JWT per §8.5).
  - Module-load asserts `STRIPE_EXPECTED_ACCOUNT_ID` matches `stripe.accounts.retrieve().id`. Mismatch → throw, log to `lng_system_failures`, refuse all requests until restart.
  - Body: `{ visit_id, amount_pence, reader_id }` (UUID for our reader, not the Stripe `tmr_xxx`).
  - Validates: cart exists, cart total matches `amount_pence`, reader is active, reader has a `stripe_reader_id` and `stripe_location_id`.
  - Generates idempotency key `cart_${cart_id}_attempt_${COALESCE(attempt+1, 1)}` server-side.
  - Creates Stripe `PaymentIntent` with `payment_method_types: ['card_present']`, `capture_method: 'automatic'`, `metadata: { visit_id, cart_id, payment_journey }`.
  - Inserts `lng_payments` row (status `processing`, taken_by from JWT) and `lng_terminal_payments` row.
  - Calls `POST /v1/terminal/readers/{stripe_reader_id}/process_payment_intent`.
  - Returns `{ payment_id, payment_intent_id }`.
  - Error paths: reader offline → return error, **do not insert payment row**. Reader busy → return error, do not insert. Invalid amount → 400.

- **`terminal-webhook`**
  - **Public** at the Supabase level (Stripe doesn't use Supabase auth).
  - **First action**: verify `Stripe-Signature` against `STRIPE_WEBHOOK_SECRET`. Failure → 401, no body, log to `lng_system_failures` with severity `critical`, exit. **No exceptions.**
  - Events handled: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `payment_intent.requires_action` (rare for in-person but possible with SCA).
  - Lookup: `lng_terminal_payments` by `stripe_payment_intent_id` (the canonical link, not metadata).
  - Updates `lng_terminal_payments.reader_action_status`, `lng_terminal_payments.raw_event`, and the parent `lng_payments.status` / `succeeded_at` / `failure_reason` / `cancelled_at`.
  - Writes a `patient_events` row: `event_type = 'payment_succeeded' | 'payment_failed' | 'payment_cancelled'`, `payload = { payment_id, payment_journey, amount_pence }`.
  - Returns `200` within 3 seconds. Heavy work async.

- **`terminal-cancel-payment`**
  - Authenticated Lounge staff.
  - Body: `{ payment_id }`.
  - Looks up `lng_terminal_payments` → reader → calls `POST /v1/terminal/readers/{stripe_reader_id}/cancel_action`.
  - Updates `lng_payments.status = 'cancelled'`, `cancelled_at = now()` immediately. The webhook will confirm later.
  - Returns success.

### 3.6 BNPL approach (Klarna and Clearpay)

Per brief §5.6. **No separate API integration.** BNPL is a guided receptionist UX on top of the same Stripe Terminal flow. The customer's Klarna/Clearpay app presents a virtual Visa via Apple Pay or Google Pay; the S700 sees a normal contactless tap.

#### Helper component `BNPLHelper`

- Triggered when the receptionist picks "Buy now, pay later" → "Klarna" or "Clearpay" in the EPOS payment-method selector.
- States, mirrored from §5.6.2:
  1. **Pre-flight check.** "Does the customer already have the Klarna app, with Apple Pay or Google Pay set up on their phone?" Yes → step 2. No → guidance to download + register, with "Switch to card" / "They'll wait" buttons.
  2. **Customer steps**, scripted per provider, lifted verbatim from `bnpl-staff-guide/`. **Loaded from `lng_settings`** at runtime — never hardcoded.
  3. **Ready to charge.** Hand-off to `TerminalPaymentModal` with `payment_journey: 'klarna'` (or `'clearpay'`).
  4. **Outcome.** On success: "£X paid via Klarna. Receipt printed will say Visa contactless — that's correct." On failure: troubleshooting matrix from staff guide + "Try again" pill.
- Always-reachable collapsibles: "If something goes wrong" and "If the customer asks", lifted from staff guide.
- Always-visible chip-list at bottom: "What I can't say" — lifted from "Don't" section. Hard rules:
  - Don't promise approval.
  - Don't quote interest or fees.
  - Don't advise on whether to use BNPL.
  - Don't encourage setting card limit higher than needed.

#### Scripts in `lng_settings`

```sql
INSERT INTO lng_settings (key, value, description) VALUES
  ('bnpl.klarna.preflight',    '"Does the customer already have...?"',        'BNPL pre-flight question (Klarna)'),
  ('bnpl.klarna.steps',        '[{"id":1,"text":"..."}]',                       'Customer step list (Klarna)'),
  ('bnpl.klarna.troubleshoot', '[{"row":"declined tap","says":"..."}]',         'Troubleshooting (Klarna)'),
  ('bnpl.klarna.faq',          '[{"q":"...","a":"..."}]',                       'If customer asks (Klarna)'),
  ('bnpl.clearpay.preflight',  '"..."',                                         'BNPL pre-flight (Clearpay)'),
  ('bnpl.clearpay.steps',      '[...]',                                         'Customer step list (Clearpay)'),
  ('bnpl.clearpay.troubleshoot','[...]',                                        'Troubleshooting (Clearpay)'),
  ('bnpl.clearpay.faq',        '[...]',                                         'If customer asks (Clearpay)'),
  ('bnpl.never_say',           '["Don\'t promise approval","Don\'t quote..."]', 'What I can\'t say (both)');
```

Editing rule: Dylan can update these rows directly via Supabase Studio without redeploying. Helper re-reads on mount; no caching beyond a 60-second TTL.

#### Refunds (BNPL)

- Process as a normal Stripe Terminal contactless refund.
- The customer relaunches the same virtual card and taps the terminal.
- Refund modal, when original `payment_journey IN ('klarna', 'clearpay')`, shows the inline note: *"Ask the customer to reopen their Klarna/Clearpay app and tap the same virtual card to receive the refund."*
- Their instalment schedule updates within 5–7 days — Klarna/Clearpay's responsibility.

#### What Lounge does NOT do

Per brief §5.6.5, **all of these are hard rules**:

- No Shopify-invoice route. The helper has no "send an invoice" option.
- No eligibility checks. Klarna/Clearpay decide. Helper never says "approved" or "denied".
- No interest, fee, or repayment-term display. Ever.
- No card-limit suggestions.

#### Reporting

`payment_journey` is surfaced from day one:

- BNPL transaction count, split Klarna / Clearpay.
- BNPL share of total takings.
- BNPL refund rate vs standard refund rate.

### 3.7 Cash payment flow

- Receptionist enters amount tendered. Lounge calculates change.
- Writes `lng_payments` with `method = 'cash'`, `payment_journey = 'standard'`, `status = 'succeeded'` immediately.
- No webhook, no PaymentIntent.
- Receipt selector shown the same way.

### 3.8 Receipts

- **Email** — Lounge sends via Resend (already wired into Checkpoint per `00d §4`; reusable).
- **SMS** — no current provider. Defer to v1.5; pick Twilio.
- **Print** — defer to v1.5 unless Phase 0 reveals a paired printer (`00 R19`: confirmed absent).

### 3.9 Day-end reconciliation

Per brief §5.10. `/admin/reconciliation` desktop screen:

- Total card payments today (Lounge view) vs Stripe Dashboard total.
- Total cash today vs receptionist-entered drawer count.
- BNPL totals split Klarna / Clearpay vs Stripe Dashboard (BNPL appears as Visa in Stripe — match by `payment_journey`).
- Any `lng_payments.status IN ('processing','pending')` for >5 minutes → flagged stuck.
- Any Stripe payment with no matching `lng_terminal_payments` row → flagged orphaned.

Drift triggers a `lng_system_failures` row.

### 3.10 Critical safety flags (carry-forward, non-negotiable)

Restated for any reader landing on this section:

- Webhook signature verification is mandatory.
- PaymentIntent created server-side only.
- Idempotency keys on every PaymentIntent creation.
- Location is mandatory before reader registration.
- Stripe account ID asserted at startup.
- BNPL: never suggest, never advise, never quote, never encourage higher card limits.
- BNPL scripts loaded from `lng_settings`, not hardcoded.
- Receipts are emailed or SMS'd from server-side only — no Stripe iframes on our domain (PCI scope minimisation, see `02-data-protection.md §5`).

---

## 4. ADR-004 — Receptionist role on Meridian

### 4.1 Status

**Accepted.**

### 4.2 Context

Per `00b §6`, the receptionist role does not exist in `accounts.member_type` or `location_members.lab_role`. Phase 1 slice 1 (Receptionist sign-in) is blocked until added.

### 4.3 Decision

Add `receptionist` to **`lab_role_enum`** (not `member_type`), because the Motherwell lab is a `lab` location and `lab_role` is the right axis for location-scoped lab-side roles.

### 4.4 Boolean override flags for the receptionist row in `location_members`

| Flag | Value | Reason |
|---|---|---|
| `messaging_access` | true | Reads/writes patient comms in the visit detail. |
| `can_submit_cases` | false | Receptionists do not submit CAD cases. |
| `view_cases_only` | false | They have no business in the CAD case stream. |
| `can_approve_cad` | false | Same. |
| `access_invoices` | true | Refunds, reconciliation, dispute lookup. |

A new SQL helper `auth_is_receptionist()`:

```sql
CREATE OR REPLACE FUNCTION public.auth_is_receptionist() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.location_members lm
    JOIN public.accounts a ON a.id = lm.account_id
    WHERE a.auth_user_id = auth.uid()
      AND lm.lab_role = 'receptionist'
      AND lm.status = 'active'
  );
$$;
```

RLS on `lng_*` tables uses `auth_is_receptionist() OR is_admin()` plus `auth_location_id() = location_id` for visibility.

### 4.5 Migration order

1. `ALTER TYPE lab_role_enum ADD VALUE 'receptionist';` (cannot be rolled back; cannot run in a transaction with subsequent statements that use the new value — split into its own migration).
2. New SQL function `auth_is_receptionist()`.
3. Optional seed: insert a receptionist `location_members` row for Dylan against the Motherwell location for development.

---

## 5. ADR-005 — Inline styles, no Tailwind / CSS-in-JS framework

### 5.1 Status

**Accepted.** Pre-decided in brief §8.1.

### 5.2 Decision

Inline styles only, with a **theme system** built atop a `theme` object:

```ts
// src/theme/index.ts
export const theme = {
  color: {
    bg: '#F7F6F2',
    surface: '#FFFFFF',
    ink: '#0E1414',
    inkMuted: 'rgba(14,20,20,0.6)',
    accent: '#1F4D3A',          // forest green per brief §9.3 — see R20 conflict
    accentBg: '#E8F5EC',
    alert: '#B83A2A',           // single red, used sparingly
    border: 'rgba(14,20,20,0.08)',
  },
  type: {
    family: '"Inter", "SF Pro", system-ui, -apple-system, sans-serif',
    size: { xs: 12, sm: 14, base: 16, md: 18, lg: 22, xl: 28, '2xl': 36, '3xl': 48, '4xl': 64 },
    weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
  },
  space: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64, 24: 96 },
  radius: { input: 14, card: 18, pill: 999 },
  shadow: {
    card: '0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06)',
  },
  motion: {
    spring: 'cubic-bezier(0.25, 1, 0.3, 1) 240ms',
  },
} as const;
```

Components consume via `theme.color.ink`, etc. Hardcoded values inside JSX are forbidden by lint rule (ESLint plugin `no-hardcoded-pixels`-shaped, written for this project).

### 5.3 Reasoning

- Inline styles + theme tokens give a deliberately small, explicit surface — no Tailwind learning curve, no styled-components runtime cost, no CSS-modules build setup.
- Theme tokens are the single source of truth — adding a new colour requires touching `theme/index.ts`, full stop.
- Brief is explicit (§8.1) and §1 ("anti-shortcut philosophy") forbids hardcoded values.

### 5.4 Caveats

- Pseudo-classes (`:hover`, `:focus-visible`) and media queries cannot be done in inline styles directly. Pattern: a thin `useStyles({state})` hook or per-component `<style>` injection through a tiny utility. Final pattern locked in Phase 2 component build (component #1, `Button`).
- Server-rendered animations (e.g. spring) use Framer Motion's `style` prop which is compatible.

---

## 6. ADR-006 — Booking phases (active vs passive segmentation)

### 6.1 Status

**Draft, awaiting sign-off.** Generalises the booking-type model shipped between brief slices 16 and 21 (`lng_booking_type_config`, `lng_booking_resource_pools`, `lng_booking_service_pools`, `lng_booking_check_conflict`). No code written yet — slice spec at `docs/slices/booking-phases.md`.

### 6.2 Context

The current model treats every booking as one contiguous `[start_at, end_at]` window that consumes its service-level pool list for the entire duration. Operationally, several Lounge services do not behave this way:

- **Denture repair** (~35 min total). The first ~15 min is sign-in, assessment, and hand-off to the bench (chair held, patient present). The remaining ~15–20 min is bench work the patient is not needed for; the chair is free for someone else.
- **Click-in Veneers** (~5–7 h end-to-end). The first ~30 min is impression-taking (chair held, patient present). The next 3–6 h is lab fabrication (lab bench / oven held, patient not present, chair free). The final ~20 min is fit-and-deliver (chair held *again*, patient back).
- **Same-day appliance** behaves similarly to denture repair for some products (night guard) and similarly to Click-in Veneers for others (hard-cure retainer).

The single-window model has three failure modes against this reality:

1. **Over-blocks chair capacity.** A 9:00 denture repair "occupies" the chair until 9:35 in the conflict checker, but in practice it's free at 9:15. The next booking is denied a slot it could have had.
2. **Under-tells the patient operationally.** There is no first-class answer to "when do I need to be back?" for staff to read off. The reschedule sheet can only show the booking's start time, not the moment(s) the patient is required.
3. **Conflates operational time with patient-facing time.** The patient experiences a denture repair as a single 30-minute appointment — they don't see or care about "15m active + 15m passive". Our staff need the operational phase view; the patient needs a single "your appointment is 30 min" line in the confirmation. Click-in Veneers is the inverse: operationally it spans 5–7 hours, but no patient is ever told "your appointment is 7 hours" — they're told "impression at 9:00, return at ~13:00 for fit". The model needs a separate patient-facing duration that the admin controls per booking type.

A scalar shortcut (adding `active_minutes` and `passive_minutes` columns to `lng_booking_type_config`) cannot represent a "patient comes back" service: Click-in Veneers needs the chair at the start *and* again at the end, with passive lab time in between. Any model that does not let pool consumption vary across the booking window will require a second rewrite the moment the third phase is needed.

### 6.3 Decision

**A booking type is a sequence of one or more phases. Each phase has its own duration, its own answer to "is the patient required?", and its own pool consumption.** Three durations now exist on a booking type, each serving a distinct audience.

#### 6.3.1 Three durations, three audiences

| Field | What it is | Who reads it | Source |
|---|---|---|---|
| **Phase durations** | Per-phase timing inside the booking | The conflict checker, the schedule grid, the appointment-detail timeline | `lng_booking_type_phases.duration_*` (parent + child override per `phase_index`) |
| **Block duration** | Sum of phase defaults | The schedule grid block width, the slot picker's "next available slot" search, the operational total shown to staff | Derived: `SUM(phase.duration_default)` |
| **Patient-facing duration** | What we tell the patient in the confirmation | Confirmation email/SMS subject + body, Calendly event duration, any patient-facing copy | `lng_booking_type_config.patient_facing_duration_minutes` (parent + child fallback) — defaults at resolve time to the block duration if unset |

The patient-facing duration is **explicitly separable** from the block duration. Two motivating cases:

- **Denture repair.** Block = 35 min (15m active + 20m passive). Patient-facing = 30 min — the operational total, rounded for the patient. The patient experiences their appointment as one 30-min slot, regardless of what's happening on the bench. The fact that we round 35 → 30 in the confirmation is an admin choice, not a system decision.
- **Click-in Veneers.** Block = 6 h (30m + 4h + 20m). Patient-facing = unset / split — telling a patient "your appointment is 7 hours" is wrong. Their confirmation reads as a *segmented* schedule: "Impression at 09:00 (30 min), return at ~13:00 for fit (20 min)". The patient comms layer reads `patient_facing_duration_minutes` AND the active-phase schedule and renders accordingly (see slice doc §6).

#### 6.3.2 Schema additions

- New table `lng_booking_type_phases` (FK to `lng_booking_type_config(id) on delete cascade`). Per-phase columns: `phase_index`, `label`, `patient_required boolean`, `duration_min/max/default`, `notes`.
- New table `lng_booking_type_phase_pools` (junction `phase_id × pool_id`). Pool consumption moves from service-level (`lng_booking_service_pools`) to phase-level. The old service-level table is retained as a fallback during the migration window, then dropped.
- New column `lng_booking_type_config.patient_facing_duration_minutes int` — nullable, with the standard parent/child fallback. Null on a child = inherit parent. Null on a parent = use the derived block duration at resolve time.
- New table `lng_appointment_phases` — per-appointment snapshot of the resolved phase sequence (label, patient_required, pool_ids, start_at, end_at, status), frozen at booking time so subsequent config edits do not rewrite live appointments. (Same invariant as `lng_visits` snapshotting appointment data on check-in.)

#### 6.3.3 Override rules

Child override rows (under the existing `repair_variant` / `product_key` / `arch` shape) can:

- Retune individual phases' durations by `phase_index` (insert a row in `lng_booking_type_phases` with the same `phase_index` against the child config).
- Override `patient_facing_duration_minutes` (single scalar on the child config row).

Children **cannot** add or remove phases, change `patient_required`, or change pool consumption — those are structural properties of the parent service. Children retune timings and patient-facing copy; parents own the shape.

#### 6.3.4 Conflict checker

`lng_booking_check_conflict` is rewritten to walk `lng_appointment_phases × lng_booking_type_phase_pools`. Same two rules (pool capacity, per-service `max_concurrent`), finer time grain. The conflict checker **never** reads `patient_facing_duration_minutes` — that field is for patient comms only.

#### 6.3.5 Backwards compatibility

A 1-phase booking is the degenerate case and behaves identically to today. Every existing parent config is seeded with a default 1-phase row at migration time so nothing observably changes until an admin breaks a service into multiple phases. `patient_facing_duration_minutes` defaults to null (= use block duration) so no existing patient-comms output changes either.

### 6.4 Reasoning

1. **Operational fidelity.** The chair-pool occupation that the conflict checker reports matches what's physically true at any given minute. No more false denials caused by counting passive lab time as chair time.
2. **One model handles every shape.** 1-phase (today's default), 2-phase (denture repair), 3-phase with a patient return (Click-in Veneers), and any future N-phase service all use the same row shape. No per-service code branches.
3. **Patient mental model is a separate concern from operational fidelity.** Staff need to know phase boundaries to the minute; the patient needs one number ("30 min") or one segmented schedule ("9:00 impression, ~13:00 fit"). Coupling these two views to the same field is what causes the "tell the patient the operational total" anti-pattern. Separating them makes both correct.
4. **Children stay narrow on purpose.** Allowing a child to add/remove phases or flip `patient_required` would create an explosion of override-shape rules and admin confusion ("which row decides whether the patient is needed?"). Restricting children to per-phase duration override + patient-facing duration matches the existing override surface and keeps the resolver linear.
5. **Snapshot-at-materialisation.** A receptionist who edits a booking type at 14:30 should not retroactively change a 09:00 appointment that's already in flight. Snapshotting is the same defence used elsewhere in `lng_*` and the simplest way to make config edits forward-only.
6. **Phase-level conflict reasons enable plain-English copy.** "Lab bench busy 14:00–17:30 (Click-in Veneers — Lab fabrication)" is what a receptionist needs. Pool-slug copy ("Pool `lab-bench` at capacity") is what the developer wrote first because it was the only thing the checker knew. Phases are what unlocks the operator-facing version.

### 6.5 Consequences

#### Positive

- Conflict checker is operationally correct. The chair pool is held only while the chair is actually held.
- Schedule grid can render two-tone blocks (active solid, passive hatched) so the receptionist sees who is in a chair right now versus who is passively occupying lab time.
- Appointment detail surfaces "patient back by 13:00" as a first-class fact rather than something the receptionist has to compute.
- Booking-types admin reads as a phase ribbon — staff understand "what shape is this service" at a glance, which is the simplification the brief is asking for.

#### Negative / risks

- This is a real schema migration + conflict-checker rewrite + three UI surface re-designs (booking-types admin, schedule grid, appointment detail). Sized as its own cross-cutting infrastructure slice, not a tweak. Mitigation: per-slice template, migrations split per concern (see slice doc §11).
- The migration window has an active period: new bookings created between the M1 (phase definitions) and M4 (conflict-checker port) migrations need to materialise phases at insert time *before* the checker is switched. Order is enforced by the slice doc step list, not by anything in the schema.
- Per-child phase override (duration only, by `phase_index`) is conceptually clean but the admin UI must show inheritance lineage clearly — a child phase row that doesn't override a field has to read "inherits 20m from parent", not just blank.
- An existing closed appointment's "what was its phase shape" is unrecoverable. Backfill only covers active appointments (`status in ('booked','arrived','in_progress')`). Reporting that wants historical phase analytics will start at the migration date.

### 6.6 Implementation rules

- All new tables `lng_*` per ADR-001: `lng_booking_type_phases`, `lng_booking_type_phase_pools`, `lng_appointment_phases`.
- `lng_appointment_phases.label`, `patient_required`, `pool_ids` are SNAPSHOTS. Editing the source config does not propagate.
- `lng_booking_type_resolve` returns three new fields: `phases` (array of resolved phase rows in `phase_index` order), `block_duration_minutes` (derived sum), and `patient_facing_duration_minutes` (resolved from child or parent; falls back to `block_duration_minutes` if both null).
- `lng_booking_check_conflict` signature changes: the candidate's repair variant / product key / arch are passed in alongside the service type so it can resolve the candidate's own phase list (today it only knows the service-level pool list). Returns one row per conflict; row carries `phase_index`, `phase_label`, and a `conflict_window tstzrange` so the reschedule sheet can render operator copy directly. **The conflict checker never reads `patient_facing_duration_minutes`** — block / phase times are the only inputs.
- `lng_booking_service_pools` is **read by the new resolver only as a fallback** during the migration window (any config row with zero phase rows). Dropped in a follow-up migration once every parent has at least one phase.
- Backfill: every existing parent config row gets a default single phase named after the service, `patient_required = true`, `duration_default = parent.duration_default`, `pool_ids = current service-level pools`. Every active appointment gets a single materialised phase covering `[start_at, end_at]` with that pool set. `patient_facing_duration_minutes` left null on parents (resolves to block default = today's behaviour). Backfill is idempotent (safe to re-run).
- Booking creation paths (Calendly inbound, native reschedule, future native new-booking flow) all call a single helper `materialiseAppointmentPhases(appointment_id)` that resolves the booking type and inserts the snapshot rows. There is exactly one place phase materialisation happens.
- Phase status transitions (`pending` → `in_progress` → `complete`) are **explicit receptionist actions**, never time-based auto-advance. The receptionist is the source of truth for "patient may leave" and "ready for collection".
- **Patient-facing copy reads `patient_facing_duration_minutes`** (resolved). Confirmation emails, SMS, and Calendly event durations source it. Operational surfaces (calendar block, slot picker, reschedule sheet) read the block / phase durations. The two paths must not cross — flagged in code review per the brief's anti-shortcut rules.
- For services where `patient_facing_duration_minutes` is meaningfully shorter than the block (Click-in Veneers): patient comms render the *segmented schedule* — the active-phase start times — rather than a single duration line. The email template branches on whether the booking has a passive phase ≥ 60 min, not on the service type.
- Per the brief's anti-shortcut rules: no `if (service_type === 'click_in_veneers')` branches anywhere in the rendering, conflict, or comms code. The phase set + the patient-facing duration are the source of truth; renderers and templates read them.

### 6.7 Open questions parked for slice spec

| # | Question | Recommendation |
|---|---|---|
| AQ6 | Can children override phase **labels**? | No — labels are a service-level concern; durations are the only override axis. |
| AQ7 | Phase reorder UX in admin — drag handle vs arrows? | Drag handle (touch-first), with up/down arrow fallback for keyboard / a11y. |
| AQ8 | Deleting a phase from a config that has live appointments | Refuse, with "X active appointments use this shape — complete them first" inline message. |
| AQ9 | Overdue passive→active transition (patient hasn't returned by ~13:00 for the Fit phase) | Add an `overdue` derived state to the phase status pill. No auto-cancel — receptionist decides. |
| AQ10 | When `patient_facing_duration_minutes` is set but doesn't match the block sum, do we surface the mismatch in admin? | Yes — small inline note on the booking-types editor: "Operational total 35m, telling patient 30m. Confirm." Prevents silent drift between what we book and what we tell the patient. |
| AQ11 | When does the patient-facing copy switch from "single duration" to "segmented schedule"? | Threshold rule: any booking type with at least one passive phase of ≥ 60 min renders patient comms in segmented mode. No service-type branch. |

Resolutions land in `docs/slices/booking-phases.md` at sign-off.

---

## 7. Branding palette conflict (R20)

Brief §9.3 says forest green `#1F4D3A`. The favicon is bright teal background with navy "L". This must be resolved before Phase 2.

**Recommendation.** Keep the forest green as the **primary action accent** per brief, and treat the favicon's teal/navy as **brand identity** at the icon level only (it does not appear in app chrome). The app uses cream + white + forest green + ink, as the brief describes; the icon and the wordmark sit at the corners but do not dictate UI palette.

If Dylan would prefer the app-side palette to follow the favicon (teal accent, navy ink), that is a brief revision and needs explicit sign-off — flag in the discovery doc risk register (R20) and resolve at Phase 2 kickoff.

---

## 8. Migration filename convention

Format: `YYYYMMDD_NN_lng_<description>.sql`

- `YYYYMMDD_NN` — counter per day, same as Meridian.
- `_lng_` — explicit segment so Lounge-origin migrations are visible in `git log` / `ls` next to Meridian's.
- `<description>` — snake_case, terse, describes the change (`receptionist_role`, `lng_payments_init`, `lng_terminal_readers_seed`).

Example sequence for Phase 1 slice 0:

```
20260428_01_lng_lwo_sequences.sql
20260428_02_lng_settings.sql
20260428_03_lab_role_receptionist.sql       ← single ALTER TYPE, can't be in tx with consumers
20260428_04_auth_is_receptionist.sql
20260428_05_lng_terminal_readers.sql
20260428_06_lng_terminal_sessions.sql
20260428_07_lng_appointments_walk_ins_visits.sql
20260428_08_lng_calendly_bookings.sql
20260428_09_lng_carts_cart_items.sql
20260428_10_lng_payments_terminal_payments.sql
20260428_11_lng_receipts.sql
20260428_12_lng_event_log_system_failures.sql
20260428_13_lng_visit_paid_status_view.sql
20260428_14_generate_lwo_ref.sql
20260428_15_lng_rls_policies.sql
20260428_16_lng_triggers.sql
```

(Final ordering and split locked in Phase 1 slice 0.)

---

## 9. Open architecture questions parked

These do not block Phase 0 sign-off but must be resolved before the slice they touch:

| # | Question | Phase blocking it | Recommendation |
|---|---|---|---|
| AQ1 | Does Lounge own walk-in dispatch (collected/shipped)? | Phase 1 slice ~16 (between reschedule/cancel and reconciliation) | Yes — Lounge owns the *decision*, Checkpoint edge functions still book DPD/ShipTheory. |
| AQ2 | LWO ref format | Phase 0.6 doc (`generate_lwo_ref()`) | Adopt Checkpoint's `LWO-YYYYMMDD-NNNN`. Updated in `06-patient-identity.md` accordingly. |
| AQ3 | Cross-product Lab Scanner read | Phase 4 cutover plan | Service-role read from a Lounge edge function. Lab Scanner stays in Checkpoint. |
| AQ4 | SMS provider | Phase 1 slice 13 (receipts) | Twilio. Set up env keys, add a thin abstraction. **Defer if O8 reveals SMS is not a v1 must-have.** |
| AQ5 | Multi-location Calendly | v1.5 | OAuth org-scope. Out of scope for v1 (single user PAT). |

---

## 7. ADR-007 — Multi-axis booking-type overrides

### 7.1 Status

**Decided.** Generalises the override model in `lng_booking_type_config` from "exactly one of {repair_variant, product_key, arch}" to "any subset of a per-service axis registry". Migration M15 carries the schema change. No deprecation of existing single-axis rows — they remain valid (chain length = 2).

### 7.2 Context

The original override model gave each booking type a single child-override dimension:

- `denture_repair` → per `repair_variant`.
- `click_in_veneers` → per `arch`.
- `impression_appointment` → per `arch`.
- `same_day_appliance` → per `product_key`.

This was enforced in three places: the `at_most_one_child_key` check constraint on `lng_booking_type_config`, the resolver function `lng_booking_type_resolve` (which picks one branch by `if p_repair_variant is not null then … elsif p_product_key is not null then … elsif p_arch is not null …`), and the per-service `childKindLabel` helper in `AdminBookingTypesTab.tsx`.

It breaks the moment a booking type genuinely spans two dimensions. The first concrete case is **Virtual impression appointment**, which can be for any of six products (Retainers, Whitening Trays, Night Guards, Day Guards, Click-in Veneers, Missing Tooth Retainer) and any of three arches (Upper, Lower, Both). The same shape applies to in-person impression. A patch that gives virtual a second `childKindLabel` would only postpone the next collision.

### 7.3 Decision

**A booking type declares its axes in priority order. An override row pins values on any subset of those axes (zero pinned = parent / defaults). The resolver walks rows from most-specific to least-specific and coalesces field-by-field; same-specificity ties are broken by axis priority.**

#### 7.3.1 The axis registry

Lives in code, in a new module `src/lib/queries/bookingTypeAxes.ts`. The registry is the source of truth for "what dimensions does this service have, what values can each take, and in what priority". The DB stays a dumb store; validation happens at write time.

Schema in TypeScript:

```ts
type AxisKey = 'repair_variant' | 'product_key' | 'arch';

interface AxisDef {
  key: AxisKey;                                // column name on lng_booking_type_config
  label: string;                               // UI label, e.g. "Product", "Arch"
  source: AxisSource;                          // how to enumerate valid values
}

type AxisSource =
  | { kind: 'arch_enum' }                      // upper | lower | both
  | { kind: 'denture_variants' }               // catalogue lookup of denture repair variants
  | { kind: 'catalogue_for'; serviceKey: string } // catalogue products tagged for this service
  ;

const SERVICE_AXES: Record<BookingServiceType, AxisDef[]>;
```

Order in the array IS the priority order. First entry = highest priority for tie-breaks.

#### 7.3.2 Resolver semantics

Given a request `(service_type, repair_variant?, product_key?, arch?)`:

1. **Candidate set**: every config row where `service_type` matches and, for each axis, the row's value is either NULL (matches anything) or equal to the request's value.
2. **Specificity**: for each candidate, count the number of axes whose row value is non-null AND matches the request value.
3. **Sort**: specificity DESC. Ties broken by axis priority — the row that pins the higher-priority axis wins. (Concrete: with axes [product_key, arch] and a request pinning both, an override pinning only product_key beats an override pinning only arch at specificity 1.)
4. **Walk**: for each field on the resolved row (working_hours, durations, max_concurrent, patient_facing_*, notes), use the first non-null value down the chain. The parent (specificity 0, all axes null) is the final fallback.

Phase resolution follows the same pattern, scoped per `phase_index`. The parent's phase set defines the canvas (number of phases, ordering, label). Child rows in the chain override per-phase fields by phase_index. Most-specific match per field wins, with axis-priority tie-break.

Pool consumption per phase chains the same way: the most-specific row that has any pool assignment wins (replace, not merge — pool sets aren't additive across the chain because that would be confusing).

#### 7.3.3 Database changes

- **Drop** `at_most_one_child_key` check constraint. Existing single-axis rows remain valid.
- **Keep** the unique index `(service_type, repair_variant, product_key, arch) NULLS NOT DISTINCT` — already supports multi-axis combos.
- **Rewrite** `lng_booking_type_resolve(text, text, text, text)` to implement the chain semantics above.
- **Rewrite** the phase-pool resolver in `20260501000004_lng_booking_resource_pools.sql` (function: `lng_booking_resolve_pool_ids`) to walk the chain.
- **Rewrite** the per-phase override resolver added in `20260503000010_lng_phase_label_override.sql` to walk the chain by phase_index.

No data migration needed. Existing rows have at most one axis pinned, so the new resolver returns identical values for them.

#### 7.3.4 Catalogue ↔ booking-type linkage

The `catalogue_for:X` axis source needs to enumerate "which products can be the subject of this booking type". Two implementations:

- **Phase 1 (now)**: a code-side allow-list keyed by service_type, in the same registry module. Hardcoded, type-safe, ships with this ADR.
- **Phase 2 (post-Calendly)**: a `lng_booking_type_product_keys (service_type, product_key)` join table editable from admin. The registry's `source: 'catalogue_for:X'` is the seam — flipping A→B later only changes how that source resolves at the UI/validation layer.

Per-service product lists are independent; in-person impression and virtual impression have different lists. Dylan supplies them.

#### 7.3.5 UI changes

**Add override** (per service card): single button "Add an override" → opens a BottomSheet with one picker per axis the service declares. Each picker has an "Any" option meaning "leave this axis unpinned". After picking, save creates the row (or jumps straight to edit if a row with that exact axis combination exists). Services with zero axes (`other`) hide the button.

**Override list** (under each service card): each row displays its pinned axes as a label string, e.g. `Whitening Tray · Upper`, `Upper`, or `Whitening Tray`. Sorted most-specific first, with a subtle indent so the chain reads visually.

**Edit override**: opens the existing PhaseEditor / config editor unchanged. Phase canvas still comes from parent.

**One-axis services** behave identically to today's UX (the picker collapses to a single field, list rendering shows just that one axis's value).

### 7.4 Alternatives considered

- **Patch virtual_impression_appointment with a second `childKindLabel`**: rejected — would postpone the same collision to the next two-axis service.
- **Compose chain field-by-field instead of row-by-row** (each field independently picks the most specific row that sets it): rejected — produces "frankenrows" where a config blends fields from several different override rows. Hard for an admin to predict; hard to display in the UI.
- **Replace single-row override with a join table per axis** (e.g. `lng_booking_type_arch_override`): rejected — N tables for N axes, heavyweight, breaks the unique-key clean-up of the existing model.
- **Move axis declarations into the database** (a `lng_booking_service_axes` table): deferred to Phase 2 alongside the catalogue allow-list table.

### 7.5 Consequences

- Existing override rows keep working unchanged.
- The Booking Types admin tab gets a new "Add override" sheet. List rows render axis chips instead of single-axis labels.
- Adding a new booking type with multi-axis overrides is a one-line addition to the registry.
- The DB stays loose — same row schema for one-axis or multi-axis. Validation lives in the registry.
- Resolver complexity goes from "lookup parent + lookup one child" to "lookup all candidates + sort + walk". For typical N (≤ 6 rows per service), the cost is a single indexed scan + an in-memory sort. Negligible.

---

## 8. Sign-off

By signing off this ADR, you accept:

- ADR-001: Lounge runs on Meridian's Supabase project. New Supabase project parked.
- ADR-002: Calendly Option A for v1, Option B for v1.5.
- ADR-003: Stripe Terminal leapfrog, EPOS data model locked, BNPL via S700 only.
- ADR-004: `receptionist` added to `lab_role_enum`, with the boolean overrides specified.
- ADR-005: Inline styles + theme system, no CSS framework.
- ADR-006: Booking phases — phase sequence with per-phase pool consumption + patient-facing duration as a separate, admin-controlled field. Slice spec at `docs/slices/booking-phases.md`.
- ADR-007: Multi-axis booking-type overrides — service axes declared in code registry, override rows pin any subset, resolver walks specificity-sorted chain.

Open architecture questions AQ1–AQ5 will be resolved at the slice they block, not as a Phase 0 sign-off prerequisite. AQ6–AQ11 (booking-phases) are resolved in the slice doc at sign-off.

---

*End of 01.*
