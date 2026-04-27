# 06. Patient identity reconciliation

**Status:** Draft, awaiting sign-off
**Covers:** Phase 0.6
**Date:** 27 Apr 2026
**Related:**
- `01-architecture-decision.md` (especially ADR-001)
- `00b-meridian-schema-delta.md` (canonical `patients` shape)
- Meridian `PATIENTS.md` (entry-point matching logic from existing flows)

---

## 1. Goals

A walk-in or a Calendly booking must resolve to **at most one** `patients` row in Meridian, scoped to the correct `location_id`. Identity work must:

- Reuse existing patient data without overwriting it (the fill-blanks rule).
- Stamp `lwo_ref` whenever a Lounge interaction first touches the patient.
- Write `patient_events` rows so the Meridian patient timeline surfaces the Lounge event.
- Never create duplicates.
- Surface ambiguity to the receptionist when matching is uncertain.

---

## 2. The matching priority order

Per brief §6.1, applied in **strict order, first match wins.** Each step runs as a separate query; once a step matches, lower-priority steps are skipped.

```
1. lwo_ref               exact match
2. shopify_customer_id   exact match
3. email + location_id   case-insensitive (rely on patients_lowercase_email trigger)
4. phone                 looser match (last 9 digits, normalised)
5. name + DOB            fallback, never trusted alone
```

### 2.1 Why `lwo_ref` first

If a patient already has an `lwo_ref` stamped, they have already been seen by Lounge or Checkpoint. That ref is a hard ID. Trust it.

### 2.2 Why `shopify_customer_id` second

A Shopify customer ID is a hard ID from the e-commerce side (set by `shopify-orders-webhook`). If we have it on the inbound (e.g. patient gives the email they used to order online and our `patients` row has it stored), it's a hard match.

### 2.3 Why email + location_id third

Per `patients_email_per_location_unique` (PATIENTS.md §3, migration `20260423_01:88`), email is per-location-unique. A new walk-in at Glasgow whose email matches an existing Glasgow patient is the same person. Same email at London is a different patient row.

### 2.4 Why phone is looser, and not a primary key

`patients.phone` is free-text — no normalisation today. A walk-in might give `0 7700 900 000` when the stored row has `+44 7700 900000`. A safe match strategy:

```
fn normalisePhone(raw):
  digitsOnly = strip non-digits
  if len(digitsOnly) >= 10: return last 10 digits
  else: return digitsOnly
```

Then match where `normalisePhone(patients.phone) = normalisePhone(walkin.phone)` AND `patients.location_id = walkin.location_id`. If multiple matches, **escalate to the receptionist** — do not auto-pick.

### 2.5 Why name + DOB is fallback only

Two siblings can share an address; a pair of patients can have the same first+last name; a patient might give a different DOB than what's stored. Name+DOB is suggestive, never decisive. If matching reaches this step:

- Show the receptionist a **disambiguation modal** with up to 3 candidate rows ("Did you mean Sarah Henderson, MP-00041, last seen 12 Mar?").
- Receptionist confirms or picks "None of these — create new."

---

## 3. The fill-blanks merge rule

Per brief §6.2 and existing Meridian flows.

**When matching finds an existing patient:** only fill blanks. Never overwrite a non-null value.

```sql
-- Pseudocode for the merge step
UPDATE public.patients SET
  email             = COALESCE(email,             :email),
  phone             = COALESCE(phone,             :phone),
  date_of_birth     = COALESCE(date_of_birth,     :dob),
  address           = COALESCE(address,           :address),
  shopify_customer_id = COALESCE(shopify_customer_id, :shopify_customer_id),
  lwo_contact_id    = COALESCE(lwo_contact_id,    :lwo_contact_id),
  -- portal_ship_* fields fill-blanks the same way
  registered_at     = COALESCE(registered_at,     now())
WHERE id = :patient_id;
```

### 3.1 Edits go through "Edit patient", not through ingestion

The brief is explicit: deliberate field changes go through a "edit patient" UI with a confirmation modal. That UI:

1. Loads the current values.
2. Shows side-by-side proposed changes.
3. On confirm, writes the update AND inserts a `patient_events` row capturing **before** and **after**:
   ```json
   {
     "patient_id": "...",
     "event_type": "patient_field_edited",
     "actor_account_id": "...",
     "payload": {
       "fields": [
         { "name": "phone", "before": "07700 900 000", "after": "+447700900000" }
       ]
     }
   }
   ```

This is the **only** path that overwrites existing patient values. Identity-resolution from a walk-in or a Calendly booking never overwrites.

---

## 4. First-time walk-in flow

```
Receptionist taps "New walk-in" on the home screen
   ↓
Enters phone OR scans an existing LWO barcode OR types name
   ↓
Lounge runs identity-resolution against patients (location-scoped via auth_location_id())
   ↓
                ┌───────────── lwo_ref / shopify_customer_id / email match ─────────────┐
                ↓                                                                       ↓
         Match found                                                              No match
                ↓                                                                       ↓
   "Confirm: this is Sarah H. (MP-00041)"                                  "No match — create new patient"
                ↓                                                                       ↓
   Receptionist confirms                                                    Receptionist enters first/last/dob/email/phone
                ↓                                                                       ↓
   Stamp lwo_ref if not present                                             INSERT patients (trigger stamps internal_ref MP-NNNNN)
                ↓                                                                       ↓
   Optionally fill-blanks any new info she's been given                     Stamp lwo_ref via generate_lwo_ref()
                ↓                                                                       ↓
   INSERT lng_walk_ins                                                      INSERT lng_walk_ins
                ↓                                                                       ↓
   INSERT lng_visits (arrival_type='walk_in', walk_in_id=...)               INSERT lng_visits (arrival_type='walk_in', walk_in_id=...)
                ↓                                                                       ↓
   INSERT patient_events (event_type='walk_in_arrived', payload={...})      INSERT patient_events (event_type='patient_created' AND 'walk_in_arrived')
                ↓                                                                       ↓
                              Visit is open. Cart-building (EPOS) begins.
```

### 4.1 Phone-first search

Default search field on the New Walk-in screen is **phone number**. Two reasons:

1. Patients give phone more reliably than email at the desk.
2. Searching last-9-digits across `patients.phone` is fast (index hint on the Phase 1 slice 4 migration).

Receptionist can switch to email or name search via a SegmentedControl above the input.

### 4.2 The "phone match returned multiple" disambiguation

If §2.4's looser phone match returns >1 row, show a sheet listing the candidates with name, DOB (year only), email (masked: `s***@example.com`), and last-seen date. Receptionist picks one or chooses "None of these — create new." Never auto-pick on a phone-only match.

### 4.3 LWO ref stamping

When matching finds an existing patient with `lwo_ref IS NULL`, stamp it now via `generate_lwo_ref()`. The trigger will refuse to overwrite a non-null `lwo_ref` (we add a guard in the function — see §5.4).

---

## 5. `generate_lwo_ref()` SQL spec

### 5.1 Format decision

Two options:

- **Brief §6.5:** `LWO-YYYY-MM-NNN` — monotonic per month.
- **Checkpoint today:** `LWO-YYYYMMDD-NNNN` — monotonic per day. Confirmed in `APPOINTMENTS-AND-WALKINS.md §3c:144`.

**Decision: adopt the Checkpoint format.** Reasoning:

1. Every existing `walk_ins.lwo_ref` follows the per-day format. Backfilling on Phase 4 cutover preserves them as-is, no re-numbering.
2. Per-day counts are easier for the receptionist to read on a printed ticket — `LWO-20260427-0003` says "third walk-in today" at a glance.
3. The brief's `LWO-YYYY-MM-NNN` is a smaller monthly counter (3 digits) — at higher volumes (>999/month) it overflows. Per-day with 4 digits gives 9999/day headroom.

If Dylan disagrees, this is a one-line revision: change the format string in the function and the seed in `lng_lwo_sequences`. Flagged as O4 in `00 §6`.

### 5.2 Backing table

```sql
CREATE TABLE public.lng_lwo_sequences (
  id              int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  year            int NOT NULL,
  month           int NOT NULL,
  day             int NOT NULL,
  next_value      int NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.lng_lwo_sequences (id, year, month, day, next_value)
  VALUES (1, EXTRACT(YEAR FROM now())::int, EXTRACT(MONTH FROM now())::int, EXTRACT(DAY FROM now())::int, 1);
```

Single-row counter, same `CHECK (id = 1)` pattern as Meridian's `patient_sequences`.

### 5.3 Function body

```sql
CREATE OR REPLACE FUNCTION public.generate_lwo_ref() RETURNS text
  LANGUAGE plpgsql AS $$
DECLARE
  v_year  int := EXTRACT(YEAR  FROM now())::int;
  v_month int := EXTRACT(MONTH FROM now())::int;
  v_day   int := EXTRACT(DAY   FROM now())::int;
  v_n     int;
BEGIN
  -- Atomic increment with day-rollover. Lock the row first.
  UPDATE public.lng_lwo_sequences
     SET (year, month, day, next_value, updated_at) =
         (CASE WHEN year = v_year AND month = v_month AND day = v_day THEN year  ELSE v_year  END,
          CASE WHEN year = v_year AND month = v_month AND day = v_day THEN month ELSE v_month END,
          CASE WHEN year = v_year AND month = v_month AND day = v_day THEN day   ELSE v_day   END,
          CASE WHEN year = v_year AND month = v_month AND day = v_day THEN next_value + 1 ELSE 2 END,
          now())
   WHERE id = 1
   RETURNING (CASE WHEN year = v_year AND month = v_month AND day = v_day THEN next_value - 1 ELSE 1 END)
     INTO v_n;

  RETURN format('LWO-%s%s%s-%s',
    lpad(v_year::text, 4, '0'),
    lpad(v_month::text, 2, '0'),
    lpad(v_day::text, 2, '0'),
    lpad(v_n::text, 4, '0'));
END;
$$;
```

### 5.4 Stamping trigger on `patients`

The brief §6.3 says walk-in flow stamps `lwo_ref` on the patient row when first matched. To enforce "stamp once, never overwrite":

```sql
CREATE OR REPLACE FUNCTION public.patients_guard_lwo_ref() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.lwo_ref IS NOT NULL AND NEW.lwo_ref IS DISTINCT FROM OLD.lwo_ref THEN
    RAISE EXCEPTION 'patients.lwo_ref is immutable once set (was %, attempted %)', OLD.lwo_ref, NEW.lwo_ref;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER patients_guard_lwo_ref
  BEFORE UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.patients_guard_lwo_ref();
```

This guard belongs in Phase 1 slice 0 alongside `generate_lwo_ref()`.

### 5.5 Where the function is called

- The receptionist sign-in flow's "stamp lwo_ref on the matched patient" — Lounge frontend.
- The Calendly webhook's identity-resolution branch (`calendly-webhook` edge function).
- The walk-in creation flow inside `terminal-start-payment`'s upstream call chain.

In all cases, the call site is:

```sql
UPDATE public.patients
   SET lwo_ref = generate_lwo_ref()
 WHERE id = :patient_id
   AND lwo_ref IS NULL;
```

The `WHERE lwo_ref IS NULL` clause makes the call idempotent under a race; the guard trigger is the safety net.

---

## 6. First-time Calendly booking flow

```
Patient books on calendly.com
   ↓
Calendly fires invitee.created webhook
   ↓
calendly-webhook edge function receives
   ↓
Verify HMAC-SHA256 (CALENDLY_WEBHOOK_SIGNING_KEY); reject if t > 3 min
   ↓
Insert raw payload into lng_calendly_bookings (idempotency key on delivery_id; duplicate → 200, no-op)
   ↓
Resolve location_id from payload (event_type → mapped Calendly event-type → location_members → locations.id)
   ↓
Run identity-resolution against patients (priority order, scoped to location_id)
   ↓
   ┌── Match ──────────────────────────────────────────────────── ─┐  ┌── No match ────────────────────────┐
   │                                                                │  │                                    │
   │ Fill-blanks merge (email, phone, name if blank)                │  │ INSERT new patients row            │
   │ Do NOT stamp lwo_ref yet (see §6.1)                            │  │ (trigger stamps internal_ref)      │
   │                                                                │  │ Do NOT stamp lwo_ref yet           │
   └────────────────────────┬───────────────────────────────────────┘  └────────────────┬───────────────────┘
                            ↓                                                            ↓
                            └────── INSERT lng_appointments (calendly_event_uri, calendly_invitee_uri,
                                    patient_id, source='calendly', start_at, end_at, status='booked')
                            ↓
                            INSERT patient_events (event_type='appointment_booked', payload={...})
                            ↓
                            UPDATE lng_calendly_bookings SET appointment_id=..., processed_at=now()
                            ↓
                            Return 200 to Calendly
```

### 6.1 Why not stamp `lwo_ref` on booking

A booking that never becomes a visit (cancellation, no-show) doesn't represent a Lounge interaction. Stamping `lwo_ref` at booking would mean every cancelled Calendly booking burns an LWO number and pollutes the timeline. We stamp `lwo_ref` only when the patient **actually arrives** — i.e., when the booking → visit transition happens via "Mark as arrived".

### 6.2 The booking → arrival flip

When the receptionist marks an appointment as arrived:

```
1. UPDATE lng_appointments SET status='arrived'
2. INSERT lng_visits (arrival_type='scheduled', appointment_id=...)
3. UPDATE patients SET lwo_ref = generate_lwo_ref() WHERE id=:patient_id AND lwo_ref IS NULL
4. INSERT patient_events (event_type='visit_arrived', payload={visit_id, lwo_ref, source='calendly'})
```

### 6.3 Reschedule and cancel handling

Per ADR-002 (Option A), reschedule and cancel happen on Calendly's side. The webhook receives:

- `invitee.canceled` with `rescheduled = false` → `lng_appointments.status = 'cancelled'`, write `patient_events`.
- `invitee.canceled` with `rescheduled = true` → `lng_appointments.status = 'rescheduled'`, write `patient_events`. The matching `invitee.created` for the new event will arrive separately and we link them via `lng_appointments.reschedule_to_id`.

For `rescheduled` linkage we match on `payload.scheduled_event` URI of the cancelled invitee against the new event's URI when the create webhook arrives. If they arrive out of order, we fix-up on the second one.

---

## 7. Where files live (consent forms, intake photos)

Per brief §6.6, files use the existing `patient_files` table and `case-files` storage bucket. **No new tables.** We add new `file_labels` rows for Lounge-specific labels.

### 7.1 New label rows

```sql
INSERT INTO public.file_labels (id, key, display_name, sort_order, scope, created_at)
VALUES
  (gen_random_uuid(), 'consent_form_v1',     'Consent Form (v1)',          800, 'patient', now()),
  (gen_random_uuid(), 'intake_photo_arrival', 'Intake Photo (on arrival)',  810, 'patient', now()),
  (gen_random_uuid(), 'intake_photo_other',   'Intake Photo (other)',       811, 'patient', now()),
  (gen_random_uuid(), 'signed_receipt',       'Signed receipt (cash)',      900, 'patient', now());
```

(The `scope` column may not exist today; if it doesn't, we omit it. Confirm in the Phase 1 slice 15 migration write-up.)

### 7.2 Storage paths

The existing `fileNaming.js` template engine (Meridian, `src/lib/fileNaming.js`) handles path generation. Lounge consent forms slot into the **scan-side** template (`patient_file_naming_template`):

```
patient_{patient_name}/{label}_v{version}_{uid}.{ext}
```

Example: `patient_sarah-henderson/consent_form_v1_v1_a3f9b2c8.pdf`

### 7.3 Signed URLs

Lounge mints signed URLs server-side, never stores them. Pattern (from PATIENTS.md §5.3):

```ts
const { data: { signedUrl } } = await supabase.storage
  .from('case-files')
  .createSignedUrl(file.file_url, 3600);  // 1 hour TTL
```

For consent forms displayed on the tablet at signing time, TTL is 5 minutes (signed inside the same edge function call as the consent submission).

### 7.4 The "active per label" constraint

PATIENTS.md §4 (`patient_files_one_active_per_label` partial unique index) enforces one active row per `(patient_id, label_id) WHERE status = 'active' AND is_delivery = false`. Lounge respects this:

- A new consent form upload sets `status = 'active'`. The previous active version (if any) is updated to `status = 'archived'` in the same transaction.
- Intake photos: there can be many. To allow many, use `intake_photo_other` for additional photos beyond the canonical "arrival" photo. (Or add `is_delivery = false` exemption — but that bends the constraint's intent. The label-per-photo approach is cleaner.)

---

## 8. `patient_events` shape for Lounge events

Per ADR-001 §1.5, patient-axis events go to Meridian's `patient_events`. Lounge writes:

| `event_type` | When | Payload |
|---|---|---|
| `patient_created` | New row inserted by Lounge ingestion | `{ source: 'walk_in' \| 'calendly', location_id }` |
| `walk_in_arrived` | Walk-in checked in | `{ visit_id, walk_in_id, lwo_ref }` |
| `appointment_booked` | Calendly webhook resolves to a patient | `{ appointment_id, source: 'calendly', start_at }` |
| `visit_arrived` | Booking flips to arrived (visit created) | `{ visit_id, appointment_id, lwo_ref }` |
| `consent_signed` | Patient signs a consent form on the tablet | `{ visit_id, file_id, label: 'consent_form_v1' }` |
| `payment_succeeded` | Stripe Terminal webhook fires success | `{ payment_id, amount_pence, payment_journey }` |
| `payment_failed` | Same, failure | `{ payment_id, failure_reason }` |
| `payment_cancelled` | Same, cancel | `{ payment_id }` |
| `refund_issued` | Refund completed | `{ refund_id, original_payment_id, amount_pence }` |
| `visit_closed` | Receptionist closes visit | `{ visit_id, paid_status, dispatch_method }` |
| `patient_field_edited` | Edit patient UI confirmed | `{ fields: [{ name, before, after }] }` |

`actor_account_id` is the receptionist's `accounts.id` (resolved from the JWT). `notes` is reserved for free-text annotations from a future "add note" UI; not used in v1.

### 8.1 Lounge-internal events go to `lng_event_log`, not here

Examples: terminal disconnected, receptionist signed in, idle lock triggered, calendly webhook signature failed, day-end reconciliation completed. These are operational, not patient-axis. They do **not** appear in the Meridian patient timeline.

---

## 9. Worked example — Sarah H. walks in

Per brief §6.7 smoke test.

### Pre-state

`patients` row exists (created 3 months ago via `shopify-orders-webhook` after a Shopify whitening kit purchase):

```
id:                    p_42
internal_ref:          MP-00041
location_id:           glasgow
first_name:            Sarah
last_name:             Henderson
email:                 sarah@example.com
phone:                 07700 900 000
shopify_customer_id:   shopify_cust_123
lwo_ref:               NULL              ← never been to a walk-in
```

### The walk

1. Sarah arrives at Glasgow. Receptionist taps "New walk-in" on the tablet.
2. Receptionist enters phone `0 7700 900 000`. Lounge normalises to `7700900000`.
3. Identity resolution runs:
   - Step 1 (lwo_ref): NULL on inbound → skipped.
   - Step 2 (shopify_customer_id): not provided → skipped.
   - Step 3 (email): not provided → skipped.
   - Step 4 (phone): match `last-10-digits = 7700900000` AND `location_id = glasgow` → **MATCHES p_42.**
4. Confirmation modal: "Sarah Henderson, MP-00041, last seen via Shopify order 12 Mar 2026?"
5. Receptionist taps "Yes, that's her."
6. Lounge:
   - `UPDATE patients SET lwo_ref = generate_lwo_ref() WHERE id = p_42 AND lwo_ref IS NULL;`
     → returns `LWO-20260427-0001` (assuming first walk-in of the day).
   - `INSERT lng_walk_ins (...)` → returns `wi_99`.
   - `INSERT lng_visits (arrival_type='walk_in', walk_in_id=wi_99, patient_id=p_42, ...)` → returns `vi_77`.
   - `INSERT patient_events (event_type='walk_in_arrived', payload={visit_id: 'vi_77', walk_in_id: 'wi_99', lwo_ref: 'LWO-20260427-0001'})`.
7. Visit opens. EPOS cart-building screen renders.

### Post-state

```
patients.lwo_ref       = 'LWO-20260427-0001'   ← stamped this visit
patient_events         contains 1 new row
lng_visits             contains 1 new row, status='in_progress'
lng_walk_ins           contains 1 new row
patients.email         = 'sarah@example.com'   ← unchanged (receptionist didn't enter one)
```

In Meridian admin, Sarah's patient timeline now shows **"walked in at Glasgow, 27 Apr 2026"** — exactly what brief §6.7 asks for.

---

## 10. Open questions to user

| # | Question |
|---|---|
| O4 | LWO format: per-day `LWO-YYYYMMDD-NNNN` (recommendation, preserves Checkpoint's existing refs) or per-month `LWO-YYYY-MM-NNN` (brief §6.5)? |
| O11 | Phone normalisation aggressiveness — last-10-digits is the recommendation. Override? |
| O12 | Disambiguation modal threshold — show when phone match returns >1 row. Should we also show on email match >1 (theoretically impossible per the unique index, but defensive coding)? Recommendation: yes, defensive. |

---

*End of 06.*
