# 00d. Unknown-unknowns sweep

**Audit date:** 27 Apr 2026
**Source:** `~/Desktop/checkpoint-app/` (full `src/`, `supabase/migrations/`, `supabase/functions/`, `package.json`, `.env.local`)
**Outcome:** Three new findings missing from `APPOINTMENTS-AND-WALKINS.md`. One major architectural conflict with the brief on BNPL.

---

## 1. The "missing" surfaces (new findings)

These exist in Checkpoint and touch walk-ins but are not in the user's existing notes.

### 1.1 Walk-in dispatch / shipping

**Migration:** `supabase/migrations/20260411_05_walk_in_dispatch.sql`

Adds these columns to `walk_ins`:

| Column | Purpose |
|---|---|
| `dispatch_method` | `'collected'` \| `'shipped'` |
| `dispatched_at` | Timestamp of handover or shipment booking |
| `tracking_number` | Carrier tracking ref |
| `shipment_id` | Internal shipment record ID |
| `label_data` | ZPL label payload |
| `shipping_address` | Shipping address jsonb |
| `cpid` | Carrier-side parcel ID |
| `dispatch_email_sent` | Boolean flag for customer notification |

**Used by:** `src/components/LabCheckOutModal.jsx`, which routes the walk-in to one of two outcomes:
- **Collected** — patient picks up in person, no carrier action.
- **Shipped** — calls the `book-dpd-shipment` or `create-shiptheory-shipment` edge function, persists carrier ref into the columns above, sends a customer notification email via `send-customer-email`.

**Impact on Lounge scope:** The brief is silent on whether shipped handover is a Lounge concern. Two options:

1. **Lounge inherits the dispatch model.** `lng_visits` carries the dispatch columns; the receptionist closes a visit with "collected" or "shipped". Shipping booking calls the existing Checkpoint-side edge functions via service-role from a Lounge edge function.
2. **Lab Scanner / lab-side keeps dispatch.** Lounge closes a visit at "tech complete"; the bench-side surface in Checkpoint owns the collected/shipped decision.

**Recommendation:** Option 1 for Phase 1. The receptionist greets the patient at handover; a shipped order requires an address-confirm conversation that belongs at the desk, not the bench. This adds a small slice to §10.1 between `Reschedule and cancel appointments` and `End-of-day reconciliation`. Confirm with user.

### 1.2 Walk-in settings

**Migration:** `supabase/migrations/20260411_03_walk_in_settings.sql`

`walk_in_settings` table holds catalogue version, default service type, waiver text, branding config. Read by `WalkInSettingsView.jsx` at `/walk-ins-settings`.

**Impact on Lounge scope:** Lounge's `lng_settings` (already in §3.2) absorbs this. Migration of values is a one-time backfill on cutover.

### 1.3 Job box (dormant)

**Migration:** `supabase/migrations/20260411_04_walk_ins_job_box.sql`

Adds `walk_ins.job_box`. Indexed but **no UI uses it today** (zero hits in `src/`). Prepared for a future lab-dispatch routing feature.

**Impact on Lounge scope:** Carry the column across to `lng_visits` or `lng_walk_ins` to preserve the dormant capability. No new functionality required.

---

## 2. BNPL: critical conflict with the brief

**Today (Checkpoint):**

- `payments_klarna` and `payments_clearpay` tables (one row per BNPL transaction).
- `record_walk_in_payment()` PL/pgSQL handles the methods.
- `RecordPaymentModal.jsx` requires a `shopifyRef` (a Shopify order number) on Klarna/Clearpay because today the BNPL transaction is processed in Shopify and the ref is recorded back here.
- A separate "Export BNPL" button in `WalkInsView.jsx` produces a Shopify-ref-tagged report.

**Brief (§5.6):**

- Klarna and Clearpay run as a virtual contactless tap on the S700.
- No Shopify involvement at all (`§5.6.5: "No Shopify-invoice route"`).
- `lng_payments.method = 'card_terminal'`, `payment_journey = 'klarna' | 'clearpay'`.
- Receipt says "Visa contactless" — the helper UI explicitly tells the receptionist to expect that.

**The change is intentional and material.** The Checkpoint approach is being replaced because:

- Shopify-routed BNPL leaves a custom Shopify order behind that has nothing to do with our normal e-commerce funnel.
- Reconciliation is split across two surfaces (Shopify dashboard + Checkpoint).
- Customer-facing experience is worse (email link → Shopify checkout → BNPL flow → manual desk reconciliation).

**Risk:** the migration must not surface old `payments_klarna` / `payments_clearpay` rows as `payment_journey = 'klarna'` rows in `lng_payments` without re-tagging them as **historical Shopify-routed** so reporting does not double-count. Concretely: backfill rows from these tables get `payment_journey = 'klarna_legacy_shopify'` (or similar — tighten in Phase 4 cutover plan).

---

## 3. Auth model in Checkpoint

| Aspect | Today |
|---|---|
| Sign-in | Supabase Auth, email + password, optional MFA |
| Role storage | `user_metadata.role` on the JWT |
| Permission table | `role_permissions` (normalised) |
| Fallback | `ROLE_DEFAULTS` in `src/lib/permissions.js` |
| Roles defined | `super-admin`, `admin`, `light-admin`, `laboratory`, `dental-technician`, `customer-services` |

Lounge runs on **Meridian's** Supabase, which uses `accounts.member_type` + `location_members.lab_role` / `practice_role`, not `user_metadata.role`. **The Checkpoint role taxonomy does not transfer**. Lounge introduces `receptionist` on the Meridian side (see `00b §6`).

For staff who are receptionists in Lounge **and** lab technicians in Checkpoint: their Lounge access flows from their Meridian `lab_role`, their Checkpoint access flows from their Checkpoint `user_metadata.role`. The two are independent. This is the correct outcome — a receptionist-only person should not need a Checkpoint user.

---

## 4. Other integrations Appointments touches

| Service | Evidence | Confirmed status |
|---|---|---|
| **Shopify** | `payments_card.shopify_order_ref`, `payments_klarna.shopify_order_ref`, `payments_clearpay.shopify_order_ref` populated. `process-checkout` edge function. | **Live.** BNPL leg of this flow is being replaced (§2 above); regular card flow is untouched. |
| **Calendly** | `sync-calendly`, `get-calendly` edge functions; `app_settings.calendly_token` stored as JSON-quoted string. | **Live.** See `03-calendly-audit.md`. |
| **DPD** | `book-dpd-shipment` edge function. | **Live.** Used by `LabCheckOutModal` for shipped walk-ins. |
| **ShipTheory** | `create-shiptheory-shipment` edge function. | **Live.** Multi-carrier fallback. |
| **Resend** | API used by `create-user`, `send-customer-email`, `remote-check-in` edge functions. | **Live.** Available for Lounge receipts/notifications via reuse. |
| **Respond.io** | Sidebar drill-down config; not appointment-related. | **Live in Checkpoint** but **not** an Appointments dependency. SMS/WhatsApp confirmations are not currently wired through Respond for walk-ins. |
| **Twilio** | Zero grep hits across `src/`, edge functions, migrations. | **Not integrated.** |
| **Make.com** | Zero grep hits. | **Not integrated.** |
| **Zendesk** | Sidebar; not appointment-related. | **Live in Checkpoint** but unrelated. |

---

## 5. Nav-item classification

Per §2.5, classify every Checkpoint nav item I have not been explicitly told about.

### Suspected related (cross-link or move)

| Nav | Verdict |
|---|---|
| Appointments group (`calendly-report`, `walk-ins`, `walk-ins-settings`, `walk-ins-reports`, `my-jobs`) | **Moves to Lounge** — already known. |
| Lab group (`lab/scan`, lab queues) | **Stays in Checkpoint** — see `00c-lab-scanner.md`. Cross-link from Lounge. |
| Dispatch Logs (`shipping-queue`, `materials-dispatch`) | **Cross-link.** Lounge owns the *decision* (collected vs shipped) on a walk-in; Checkpoint owns the *queue* of pending shipments. Whether that queue should also exist in Lounge is a v1.5 question. Confirm with user. |

### Possibly related (review individually)

| Nav | Verdict |
|---|---|
| Catalogues (`catalogue`, `piranha-catalogue`) | `lwo_catalogue` (walk-in pricing, used by EPOS) is **separate** from the e-commerce catalogue. Lounge owns the EPOS line-item catalogue; Checkpoint catalogues stay where they are. **No move, no cross-link.** |
| Search/Customer Services (`customer-service`) | Searches Meridian orders, not Lounge visits. **No relation.** |

### Confirmed unrelated

| Nav | Justification |
|---|---|
| Home | Generic dashboard. |
| Sessions | Scan session logs (lab-internal). |
| Inbox / Notifications / Messages | Internal staff comms. |
| Reports / Admin Reports / Analytics | Order-side metrics. |
| Team | Staff directory, rotas. |
| Admin | Org settings. |

---

## 6. Tables not in `APPOINTMENTS-AND-WALKINS.md` but maybe relevant

From the 45-migration sweep, the only walk-in-axis additions absent from the doc are the three in §1 above (`walk_in_settings`, `walk_ins.job_box`, `walk_in_dispatch`). All other walk-in-named migrations match the existing notes.

`20260413_01_slot_customer_email.sql` and `20260413_02_slot_customer_phone.sql` are **Meridian order-timeslot** changes, not appointment changes. Confirmed unrelated.

---

## 7. Things the brief might not have anticipated

- **Receptionist also handles dispatch decisions** at handover (collect/ship). §1.1 above. Adds a slice to §10.1.
- **Shopify still gets touched** via `shopify_customer_id` resolution on identity match (`§6.1` order #2 in the brief), which means the Shopify orders webhook → `patients` flow remains active in Meridian. Lounge respects this — no change.
- **Email provider for receipts** — Resend is already wired up in Checkpoint; reusable. Confirm in Phase 0 final pass that the API key is portable.
- **SMS provider for receipts** — none today. The brief mentions "the existing SMS provider (Respond.io? Twilio? confirm in Phase 0)" — Twilio is not integrated, Respond.io is not used for transactional SMS. **There is no current SMS receipt path.** Lounge needs a fresh integration; Twilio is the obvious candidate. Flag for v1.5 decision.
- **Printed receipts** — no printer is paired today. The brief defers to v1.5 unless Phase 0 reveals one is operational. **Phase 0 confirms: no printer.** Defer.

---

## 8. Things specifically NOT a problem

- `lng_` prefix collision in Checkpoint — zero hits.
- Stripe Terminal collision in Checkpoint — zero hits (see `04-stripe-terminal-state.md`).
- Conflicting LWO ref formats — Checkpoint uses `LWO-YYYYMMDD-NNNN`. The brief's `lng_lwo_sequences` produces `LWO-YYYY-MM-NNN`. **These differ.** Flag in `00-discovery.md` risk register; we will use the Checkpoint format to avoid breaking historical data, and update the brief's text accordingly when user confirms.

---

*End of 00d.*
