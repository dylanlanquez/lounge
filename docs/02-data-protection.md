# 02. Data protection

**Status:** Draft, awaiting sign-off
**Covers:** Phase 0.7
**Date:** 27 Apr 2026
**Related:**
- `00-discovery.md` (R12, R13, R16, R17 in the risk register)
- `06-patient-identity.md` (audit trail shape)
- `01-architecture-decision.md` (storage architecture)

> **This is a working framework, not a legal opinion.** Sections marked **[legal review required]** must be confirmed with a qualified UK data protection adviser before go-live. The intent here is to capture every concrete control we will implement so the legal review is targeted.

---

## 1. Regulatory framing

Lounge processes personal data and special-category health data of UK individuals. Applicable law:

- **UK GDPR** (the retained UK form of EU GDPR following Brexit, as amended by the Data Protection, Privacy and Electronic Communications (Amendments etc) (EU Exit) Regulations 2019).
- **Data Protection Act 2018** (DPA 2018), specifically Part 2 for general processing and Schedule 1 for the Article 9(2)(h) special-category condition.
- **PECR** — Privacy and Electronic Communications Regulations — applies to receipts sent by SMS / email when those are marketing-shaped. Transactional receipts are out of scope but the line is fine.

Roles:

- **Controller:** Venneir Limited.
- **Processors:** Supabase (data hosting), Vercel (frontend hosting), Stripe (payments — also a controller for PCI scope), Calendly (booking — also a controller), Resend (email transit), the SMS provider when chosen.
- **Joint controllers:** none today. If Lounge ever shares patient data with a third-party CAD partner outside Venneir, that becomes a joint-controller analysis. **[legal review required if scope expands.]**

Lawful bases:

- **Article 6(1)(b)** — performance of a contract — for the dental services the patient is receiving.
- **Article 9(2)(h)** — processing necessary for the provision of health care, by or under the responsibility of a health professional — for the special-category health data.
- **Article 6(1)(f)** — legitimate interests — for security, fraud prevention, audit logging.

Schedule 1 condition (DPA 2018) for Article 9(2)(h) processing: paragraph 2(2)(a)(i) — health professional providing care — applies if the lab and reception staff are operating under the responsibility of a registered dental professional. **[legal review required: confirm Venneir's GDC-registered staff sit appropriately in the chain.]**

Article 30 record of processing activity (RoPA): Lounge's processing must be added to Venneir's RoPA. Concretely, the entries are:

- "Walk-in and appointment management at Motherwell" — purpose, lawful basis, categories of data, recipients, retention.
- "In-person card payments at Motherwell" — purpose, lawful basis, processors (Stripe), retention.

---

## 2. DPIA addendum

### 2.1 Why a DPIA addendum is required

Per ICO guidance, a DPIA is required where processing is "likely to result in a high risk to the rights and freedoms of natural persons", and is **mandatory** where processing involves any of nine ICO-listed criteria including:

- Large-scale processing of special-category data ✓ (health data of every patient who walks in).
- New technologies or innovative use ✓ (tablet at point of service for health-data ingestion is novel for Venneir).
- Tracking individuals' location or behaviour ✓ (`patient_events` audit trail).

Whether Venneir's existing DPIA already covers tablet-based ingestion at point of service is unknown to me. **[Q: does Venneir have an existing DPIA covering Checkpoint walk-ins? If yes, does it cover tablet-based ingestion? If no, a fresh DPIA is required before go-live.]** This is risk R16 in `00-discovery.md`.

### 2.2 Scope of the addendum

The addendum (or fresh DPIA) covers Lounge specifically and replaces / supplements the Checkpoint walk-in section of any existing DPIA. Scope:

- Reception desk on a Galaxy Tab S10 FE at Motherwell (and any future location).
- Identity resolution against the existing `patients` table.
- Capture of consent forms, intake photos, payment records.
- Stripe Terminal card-present payments and BNPL hand-offs.
- Calendly inbound bookings (data already handled today; new control surface in Lounge).

### 2.3 Risks identified, with mitigations (this is the table that goes in the DPIA itself)

| # | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| DP1 | A patient at the reception desk sees another patient's record on screen. | Medium (queue at the desk) | High (special-category data) | Truncate names on home screen to first name + last initial. Auto-lock screen after 60s of inactivity. Lock when app backgrounded. Tablet pinned to landscape with privacy-screen film recommended. |
| DP2 | Tablet is left unattended and unlocked. | Medium | High | 60-second auto-lock with PIN re-entry. Lock on app background. PIN attempt rate-limit. |
| DP3 | Tablet is lost or stolen. | Low | High | Server-side device revocation (`lng_receptionist_sessions.revoked_at`). Remote wipe via Samsung Knox where available. App requires online auth to unlock from cold. |
| DP4 | Receptionist creates a duplicate patient row by accident, splitting the patient's history. | Medium | Medium | Identity-resolution priority order (`06-patient-identity.md §2`); receptionist confirms a match before creating new; phone-only ambiguity escalates to disambiguation modal. |
| DP5 | Receipt sent to the wrong recipient (typo'd email or phone). | Low | Medium | Receipt destination is **read back to the receptionist** (and ideally the patient) before sending. Audit row in `patient_events` captures channel + recipient + timestamp. Bounce/failure handling in v1.5. |
| DP6 | Card-data exposure (PCI). | Very low (S700 is SCRD) | Critical | Out-of-scope architecture: card data never touches Lounge or Supabase. SAQ-A-EP at most. See §5. |
| DP7 | Insider threat — staff exfiltrating patient data via the tablet. | Low | High | RLS scopes patient visibility to `auth_location_id()`. Receptionists cannot bulk-export. Audit log captures every read >1 row at admin level. **[v1.5: add per-action access logging beyond `patient_events`.]** |
| DP8 | Webhook payload from Calendly contains free-text from the patient (Q&A) → potentially sensitive. | Medium | Low | Stored in `lng_calendly_bookings.payload` (jsonb) — only readable by the webhook function and admins. Not surfaced in receptionist UI unless explicitly part of the appointment summary. |
| DP9 | Stripe webhook impersonation. | Very low | Critical | HMAC-SHA256 signature verification mandatory; account-ID assertion at startup. See `01 §3.5`. |
| DP10 | A staff member who has left Venneir retains app access. | Medium | High | Off-boarding checklist: deactivate `accounts.status`, revoke all `lng_receptionist_sessions`, rotate any shared PINs. Quarterly access review. |
| DP11 | A consent form is "signed" by the receptionist on the patient's behalf. | Low | High | Signature capture component requires a stylus or finger on glass; logged with timestamp + tablet device id. Periodic spot audit of signatures (visual review by admin). |
| DP12 | Patient asks for their data to be deleted (right to erasure). | Medium | Medium | DSAR / erasure runbook documented in `02-data-protection.md §8`. Stripe payments retained for 7 years per HMRC, with the personal data fields nulled. |
| DP13 | Reports → Demographics admin address heatmap exposes precise residential addresses on a screen visible to clinical leadership. | Low (admin-only access) | Medium (PII surfaced in a new context) | **Lawful basis:** Article 6(1)(f) legitimate interest — operational catchment analysis for service-area planning. **Necessity:** outward-postcode resolution is the default for all other staff (DP-safer); precise resolution is restricted to admins because higher resolution is materially more useful for capacity / service-mix decisions and the additional intrusion is minimal given the data was already lawfully collected for shipping. **Mitigations:** RLS on `lng_address_geocodes` gates SELECT to `auth_is_lng_admin() OR auth_is_super_admin()`; the `geocode-address` edge function repeats the same admin check before any cache write or Google call; cache holds only the normalised `(line1, postcode)` and lat/lng, no patient identifiers; access is on the same managed tablet/device with the same auto-lock and revocation controls (§3); the map description text is explicit that it is "Admin only". **Processor disclosure:** when an address is not in cache, `line1 + postcode + country=GB` is sent to Google Geocoding API — Google is a sub-processor; the processor list in the Lounge privacy notice must reflect this. |

### 2.4 Residual risk

After mitigations, the residual risk is **acceptable** for special-category processing under Article 9(2)(h). Highest-residual items: DP3 (lost tablet) and DP10 (off-boarding). Both can be reduced further via Samsung Knox MDM (managed device) — a v1.5 hardening item.

**[legal review required: sign-off that residual risk is acceptable, or instruct further mitigations.]**

---

## 3. Tablet-specific controls

Per brief §7.2, restated with implementation detail.

### 3.1 Screen content

- Home screen patient list shows **first name + last initial only**, never the full last name, never DOB, never address. Examples: `Sarah H.`, `Mark T.`
- Visit detail screen (one patient open) shows full name, DOB, phone — but the screen header does not. Receptionist must consciously open a record to expose detail.
- Patient avatars use Meridian's preset avatar system (no real photos visible at queue distance).

### 3.2 Auto-lock

- 60 seconds of inactivity → lock screen with PIN re-entry.
- App background (home button, app switcher) → immediate lock.
- Receptionist's session token is preserved server-side; lock-unlock is local PIN, not a fresh sign-in.
- Three failed PIN attempts → 30-second lockout. Six attempts → 5-minute lockout. Server-side rate-limit via `lng_receptionist_sessions.failed_pin_at`.

### 3.3 PIN entry UI

- 6-digit PIN.
- **Scrambled keypad option** (`lng_settings` toggle). Default off; turn on if desk visibility is poor.
- Never echo the PIN. Show dots only.

### 3.4 Server-side device revocation

`lng_receptionist_sessions` row has a `revoked_at` column. Admin sets it via `/admin/devices`. The next request from that device gets a 401 and the local app drops to a re-auth screen.

For lost-tablet emergencies, the admin clicks "Revoke all sessions for this device" → server flips `revoked_at` on every session for that `device_id`.

### 3.5 Network and at-rest encryption

- Tablet ↔ Supabase: TLS 1.2+ enforced by Supabase.
- Supabase data at rest: AES-256 (Supabase platform default — confirm in their DPA).
- `case-files` bucket: encrypted at rest. Signed URLs expire in 1 hour for backstage reads, 5 minutes for tablet-side reads (consent form preview at signing time).
- The Galaxy Tab S10 FE has device-level encryption enabled by default; no app data persists on the device beyond the locked Lounge web app cache.

### 3.6 Tablet hardening checklist (one-time, before go-live)

- [ ] Device is enrolled with Samsung Knox or equivalent MDM. [optional v1.5]
- [ ] Privacy screen film fitted.
- [ ] Single-app kiosk mode (Samsung's "Knox Kiosk" or Android's screen-pinning) — only Lounge can run.
- [ ] Auto-update: app updates immediate; OS security patches monthly.
- [ ] Bluetooth and AirDrop-style features disabled at the OS level.
- [ ] No personal Google account on the device.
- [ ] Wallpaper / lockscreen branded but not patient-data-visible.
- [ ] PIN required at OS level; biometric optional.

---

## 4. Data minimisation

Every column added to `lng_*` tables has a documented purpose. The design rule:

- **Default to NOT collecting data.** Add a column only when a smoke test or ritual cannot be completed without it.
- **Free-text fields are dangerous.** They tend to capture incidental sensitive data. We restrict them to `notes`, `description`, `failure_reason`, `repair_notes`-equivalent — and the schema documents what each is for.
- **Receipts on the tablet display only what the patient sees.** No internal codes, no staff names, no internal pricing lines beyond what was charged.

### 4.1 Per-table minimisation review

| Table | Personal data? | Why we collect | Retention |
|---|---|---|---|
| `lng_appointments` | Indirectly via `patient_id` | Operational scheduling | 6 years (HMRC 6, plus 1y buffer per ICO guidance for service-records) |
| `lng_walk_ins` | Indirectly via `patient_id` | Walk-in record | 6 years |
| `lng_visits` | Indirectly | Service-delivery record | 6 years |
| `lng_carts`, `lng_cart_items` | No PII directly | Audit of what was paid for | 6 years |
| `lng_payments` | `taken_by` (staff) only | Financial audit | 7 years (HMRC retention for accounting records) |
| `lng_terminal_payments` | None directly | Stripe-side detail link | 7 years |
| `lng_terminal_readers` | None | Hardware registry | While reader is in service + 1y |
| `lng_receipts` | `recipient` (email or phone) | Send receipt; prove sending | 6 years |
| `lng_receptionist_sessions` | `account_id`, `device_id`, IP | Audit, revocation | 13 months (rolling); aggregated counts retained longer |
| `lng_event_log` | `account_id` | Operational audit | 13 months |
| `lng_system_failures` | Stack traces only | Incident investigation | 12 months |
| `lng_calendly_bookings` | Patient name, email in raw payload | Ingestion idempotency, replay | 6 years (inherits patient retention) |
| `lng_postcode_geocodes` | No (outward postcode aggregations only) | Reports visitor-heatmap cache, all-staff visible | While outward is referenced; effectively permanent |
| `lng_address_geocodes` | Yes — normalised `line1` + `postcode` + lat/lng | Admin-only address heatmap cache for catchment analysis (DP13) | While source patient address remains valid; cleared on patient erasure (§8 runbook) |

**[legal review required: confirm these retention periods against current ICO guidance and any GDC requirements for dental records — typically 11 years for adult records and longer for under-25s, per RDC retention guidance.]**

### 4.2 Pseudonymisation and aggregation

- Reporting (per brief §10.1 #22) **does not** join on `patient_id` for headline metrics. Daily / weekly / monthly counts, payment totals, no-show rates are computed without exposing individual patient identifiers.
- Where individual rows are needed for investigation (e.g. "which patient's payment is stuck?") the request is logged in `lng_event_log` with the actor.

---

## 5. PCI-DSS posture

### 5.1 SAQ scope

- **S700 is a Stripe SCRD** (Secure Card Reader for Devices). Cardholder data never enters Lounge or Supabase. The reader sends card data directly to Stripe.
- **PaymentIntent flow** is server-driven (per `01 §3.5`). Lounge passes amounts and metadata to Stripe; the reader returns a status.
- **No card iframes on our domain.** We do not embed Stripe.js or Stripe Checkout. Klarna/Clearpay are presented via Apple Pay/Google Pay on the customer's phone, not in our web surface.

This puts Lounge at **SAQ-A** scope (the lightest), provided:

- We never store, process, or transmit cardholder data.
- We outsource all card handling to Stripe.
- Our reader and the network it sits on are managed appropriately.

If at any future point we add a Stripe Elements iframe (e.g. for an online payment surface), we move to **SAQ-A-EP**, which adds requirements around the page that contains the iframe.

**[legal/PCI review required: complete the SAQ-A questionnaire on Stripe's PCI dashboard before go-live. Confirm S700 is on a network segment that does not handle cardholder data otherwise.]**

### 5.2 BNPL and PCI

Per brief §7.5, BNPL does **not** change PCI posture. The virtual Visa is presented through the customer's wallet via NFC; we see only an EMV contactless tap. Same SAQ.

### 5.3 Stripe key hygiene

- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` live as Supabase edge function secrets. Never committed. Never in `.env.local` checked into git. Never returned in any response body. Never logged.
- `STRIPE_EXPECTED_ACCOUNT_ID` is also an env var; the value (`acct_xxx`) is not itself secret but its presence is a key safety control (`01 §3.5`).
- Rotation runbook documented in the Phase 1 admin section. Rotate annually or after any suspected exposure.

---

## 6. Audit trail

### 6.1 Patient-axis audit (`patient_events`)

Per `06-patient-identity.md §8`. Every patient-axis action (visit, payment, consent, edit) writes a row. The `actor_account_id` is the receptionist; `payload` jsonb captures enough to reconstruct.

Retention: same as the patient (6 years; longer for under-25s per RDC guidance — **[legal review]**).

### 6.2 Lounge-internal audit (`lng_event_log`)

Operational events: receptionist signed in, terminal disconnected, idle lock, admin opened a settings page, calendly webhook delivered.

Retention: 13 months rolling. Aggregated counts retained longer for capacity planning.

### 6.3 Failure audit (`lng_system_failures`)

Every unexpected condition, every catch that doesn't re-throw, every webhook signature failure.

Schema:

```
id            uuid PK
occurred_at   timestamptz NOT NULL DEFAULT now()
source        text NOT NULL                         (e.g. 'terminal-webhook', 'calendly-webhook')
severity      text NOT NULL                         ('info' | 'warning' | 'error' | 'critical')
message       text NOT NULL
context       jsonb                                 (no PII; sanitise on the way in)
user_id       uuid REFERENCES accounts(id)          (when known)
location_id   uuid REFERENCES locations(id)
resolved_at   timestamptz
resolved_by   uuid REFERENCES accounts(id)
resolution_notes text
```

Retention: 12 months. Admin reviews via `/admin/failures` daily.

### 6.4 Stripe webhook signature failures specifically

Logged with `severity = 'critical'`, `source = 'terminal-webhook'`, `context = { stripe_signature_header, ip, user_agent }`. **No body payload is logged** because the body is unverified at that point. A burst of these is an indicator of attack — the resolution playbook is to rotate `STRIPE_WEBHOOK_SECRET` and investigate.

---

## 7. Receipts and the patient communication boundary

### 7.1 Lawful basis

A transactional receipt for a payment is a contractual necessity (Article 6(1)(b)). Not marketing. PECR consent is not required for the receipt itself.

If we ever add "would you like a follow-up reminder for your next appointment?" via SMS — that is marketing-shaped under PECR and requires opt-in. **Out of scope for v1.**

### 7.2 What goes on the receipt

- Venneir trading name, address, VAT number.
- Visit reference (`LWO-YYYYMMDD-NNNN`).
- Date, time, location.
- Line items (name, quantity, unit price, line total).
- Discounts.
- Total.
- Payment method (`Card`, `Cash`, `Visa contactless`).
- For BNPL: receipt says "Visa contactless" — the helper UX explicitly tells the receptionist this is correct (`01 §3.6`).
- Last 4 digits of the card and the auth code (Stripe-supplied, when available).
- VAT breakdown if any.

### 7.3 What does NOT go on the receipt

- The patient's full DOB.
- Allergies, insurance, free-text notes from the patient record.
- Other staff names beyond the till operator's first initial.
- Internal SKU codes, internal cost prices.

### 7.4 Receipt audit

Every send writes a `patient_events` row (`event_type = 'receipt_sent'`, `payload = { channel, recipient, sent_at }`). The recipient is **not** redacted in the audit row — we need to be able to answer "did we send this person's receipt to the right address?" in an investigation. The audit row inherits patient retention.

---

## 8. Subject rights — DSAR and erasure runbook

### 8.1 Right to access (DSAR)

A patient asks: "Send me everything you have on me."

Runbook:

1. Verify identity (passport/driving licence + a known shared fact like LWO ref).
2. Run a packaged extract:
   ```sql
   -- Identity
   SELECT * FROM patients WHERE id = :patient_id;
   -- Visits
   SELECT * FROM lng_visits WHERE patient_id = :patient_id;
   SELECT * FROM lng_walk_ins WHERE id IN (SELECT walk_in_id FROM lng_visits WHERE patient_id = :patient_id);
   SELECT * FROM lng_appointments WHERE patient_id = :patient_id;
   -- Payments
   SELECT lp.*, ltp.stripe_payment_intent_id FROM lng_payments lp
     LEFT JOIN lng_terminal_payments ltp ON ltp.payment_id = lp.id
     WHERE lp.cart_id IN (SELECT id FROM lng_carts WHERE visit_id IN (SELECT id FROM lng_visits WHERE patient_id = :patient_id));
   -- Files
   SELECT * FROM patient_files WHERE patient_id = :patient_id;  -- include signed URLs valid for 7 days
   -- Audit
   SELECT * FROM patient_events WHERE patient_id = :patient_id;
   -- Receipts
   SELECT * FROM lng_receipts WHERE payment_id IN (SELECT id FROM lng_payments WHERE cart_id IN (...));
   ```
3. Package as a zip with a readme explaining each file.
4. Deliver via secure transfer (1-hour signed URL emailed to the verified address).
5. Log the DSAR completion in a separate audit (Venneir's existing DSAR log, not in `patient_events`).

Response within **1 calendar month** per UK GDPR.

### 8.2 Right to erasure ("right to be forgotten")

A patient asks: "Delete everything you have on me."

Erasure is **not absolute** — we must retain financial records for HMRC (7 years) and clinical records to meet professional obligations. The runbook:

1. Verify identity.
2. Determine the lawful retention overrides:
   - HMRC retention (7 years from the end of the financial year for accounts records).
   - GDC retention (typically 11 years for adult records; longer for under-25s — **[legal review required]**).
3. Execute a **partial erasure**:
   - Personal identifiers nulled or pseudonymised on `patients`: `first_name → 'Erased'`, `last_name → '<UUID>'`, `email → null`, `phone → null`, `portal_ship_line1 → null`, `portal_ship_line2 → null`, `portal_ship_postcode → null`, etc.
   - Free-text fields cleared.
   - `patient_files` cleared (storage objects deleted; rows updated to `status = 'erased'`).
   - `lng_payments`, `lng_terminal_payments`, `lng_receipts.recipient` retained but personal identifiers stripped where possible.
   - `lng_address_geocodes` row matching the patient's normalised `(line1, postcode)` is deleted if no other patient record references the same address. The cache is keyed only on the address, so after the patient's `portal_ship_*` fields are nulled the cache row is orphaned; the runbook removes it to honour the erasure end-to-end. (`lng_postcode_geocodes` is kept — outward postcodes aren't personal data.)
   - A `patient_events` row records the erasure for our own audit.
4. Inform the patient in writing within **1 calendar month** detailing what was erased and what was retained (and why).

Hard-delete of a `patients` row is **never** done because of the cascading FKs on production cases, payment records, etc. Always pseudonymise.

### 8.3 Right to rectification

Goes through the "Edit patient" UI (`06-patient-identity.md §3.1`). Audited.

### 8.4 Right to portability

Same as DSAR but in machine-readable JSON. Built into the same packaged extract.

### 8.5 Right to object / restrict processing

Patient asks us to stop processing for marketing — N/A in v1 (we don't market via Lounge).
Patient asks us to stop processing for service — that means they're leaving Venneir; the patient row remains for retained records but is flagged inactive.

---

## 9. Breach response

### 9.1 Definition

A personal data breach is "a breach of security leading to the accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or access to, personal data". A lost tablet is a breach. A misdirected receipt is a breach. A successful Stripe webhook impersonation that marked an appointment as paid for free is a breach (no PII exfiltrated, but it's an integrity event).

### 9.2 Notification timeline

- ICO: within **72 hours** of becoming aware, where the breach is likely to result in a risk to the rights and freedoms of natural persons.
- Affected individuals: "without undue delay" where the breach is likely to result in a high risk.

### 9.3 Runbook

1. Detect. Source: `lng_system_failures` daily review, user report, monitoring alert.
2. Contain. Revoke sessions, rotate secrets, take the affected component offline if needed.
3. Assess. What data, how many people, what risk, what exfiltration?
4. Notify ICO if 9.2 threshold met. Use the ICO's online reporting tool.
5. Notify individuals if high risk.
6. Document everything in a breach log retained for 5 years (independent of the data we're investigating).

**[legal review required: sign-off on the breach log location and the staff member designated as DPO / breach owner.]**

---

## 10. Staff training and access

### 10.1 Training

Receptionists must complete:

- Basic UK GDPR / DPA 2018 awareness (Venneir-provided).
- Lounge-specific: how to handle a DSAR, what to do on a misdirected receipt, how to recognise a phishing attempt at the desk, how to report a suspected breach.

Annual refresh; new staff before they have account access.

### 10.2 Access principle

- Least-privilege via the receptionist role (`01 §4`).
- Admin access (full visibility) is for Dylan and one named deputy. No others.
- All admin access is logged at the row level.
- Off-boarding flips `accounts.status` to `inactive` — RLS denies access immediately.

### 10.3 Shared accounts

**Forbidden.** Each receptionist has their own `accounts` row and PIN. Shared PINs, shared logins → no audit trail for who did what. The Phase 1 slice 1 (Receptionist sign-in) requires a unique PIN per account; the design rejects the "team PIN" pattern.

---

## 11. Two-minute answers (per brief §7.6 smoke test)

> "How does Lounge access patient scan files?"

Lounge reads `patient_files` rows (RLS scopes to the patient's `location_id`). The `file_url` column is a storage path, not a URL. Lounge mints a signed URL on demand via `supabase.storage.from('case-files').createSignedUrl(file.file_url, ttl)` — TTL is 5 minutes for tablet-side reads, 1 hour for backstage reads. The signed URL is single-use and never persisted. Path conventions and storage architecture: PATIENTS.md §5; Lounge file labels: `06-patient-identity.md §7`.

> "Where does cardholder data live?"

It doesn't live with us. The S700 reader sends card data directly to Stripe; Lounge never sees a PAN, never stores a CVV, never logs an EMV tag. The only cardholder-related data we hold is what Stripe gives us back after the fact: PaymentIntent ID, last 4 digits, brand, auth code. PCI scope: SAQ-A. Confirmed in `02 §5`.

---

## 12. Sign-off prerequisites

Before go-live:

- [ ] DPIA addendum (or fresh DPIA) signed off by Dylan and a qualified UK data protection adviser.
- [ ] Article 30 RoPA updated.
- [ ] Stripe SAQ-A questionnaire complete on the new direct account.
- [ ] Privacy notice (patient-facing) updated to mention Lounge and tablet-based ingestion.
- [ ] Staff trained.
- [ ] Breach response runbook circulated.
- [ ] DSAR / erasure runbook tested end-to-end against a synthetic record.

**Outstanding regulatory questions for legal:**

- Schedule 1 Article 9(2)(h) chain (does our reception staff sit appropriately under a GDC professional?).
- Retention periods per GDC guidance for under-25s.
- Existing DPIA coverage — does it touch tablet-based ingestion at point of service or not?
- Designated DPO / breach owner.

---

*End of 02. This document is the framework; the legal sign-off is what makes it the policy.*
