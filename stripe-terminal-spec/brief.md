# Lounge × Stripe Terminal — Setup Brief

## Project

Build in-person card payment functionality into **Lounge** (our appointments app) using a Stripe Terminal **Stripe Reader S700**, so staff can take chip, PIN, and contactless payments at the Venneir Motherwell lab counter, with appointments automatically marked paid in Lounge.

## Hardware (already on site)

- **Stripe Reader S700** — countertop smart reader with screen, chip slot, PIN pad, contactless/NFC, Apple Pay, Google Pay
- **S700/S710 Dock** — charges and presents the reader
- **S700/S710 Hub** — provides wired ethernet port for the reader
- **CAT6 ethernet cable** — Hub to lab router

## Stripe account context

- Use the **new, direct Stripe account** that was created specifically for Lounge Terminal
- Do **not** use the legacy HubSpot-administered Stripe account for any part of this build (it has restricted API access and is platform-controlled)
- All secrets, webhooks, Location objects, and reader registrations live on the new direct account

## Architecture (server-driven)

```
Staff opens appointment in Lounge
  → clicks "Take card payment"
  → Lounge calls terminal-start-payment edge function
  → edge function creates PaymentIntent and instructs S700 via Stripe API
  → customer taps/inserts card on S700
  → S700 reports result to Stripe
  → Stripe sends webhook to terminal-webhook edge function
  → webhook updates lng_terminal_payments row
  → Lounge UI updates via Supabase realtime
  → appointment is marked paid
```

Reader and tablet never communicate directly. Both talk independently to Stripe's cloud API. If the tablet's WiFi drops, the payment still completes on the reader.

## Database

### Table: `lng_terminal_payments`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `appointment_id` | uuid | FK to Lounge appointments table |
| `amount_pence` | int | Always store in pence, never pounds |
| `currency` | text | Default `'gbp'` |
| `stripe_payment_intent_id` | text | Unique, indexed |
| `stripe_reader_id` | text | Which physical reader processed it |
| `status` | text | `'pending'` \| `'processing'` \| `'succeeded'` \| `'failed'` \| `'cancelled'` |
| `failure_reason` | text | Nullable, populated on failure |
| `created_at` | timestamptz | Default `now()` |
| `succeeded_at` | timestamptz | Nullable, set when webhook confirms success |
| `cancelled_at` | timestamptz | Nullable |
| `metadata` | jsonb | For staff notes, related order IDs, etc. |

Indexes: `appointment_id`, `stripe_payment_intent_id` (unique), `status`.

### Table: `lng_terminal_readers`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `stripe_reader_id` | text | Unique, indexed |
| `display_name` | text | e.g. "Motherwell Counter" |
| `location_name` | text | e.g. "Venneir Lab — Motherwell" |
| `stripe_location_id` | text | Stripe Location object ID |
| `is_active` | bool | Default `true` |
| `created_at` | timestamptz | Default `now()` |

Allows multiple readers in future without code changes.

### Appointment paid status

Do **not** add a `paid_at` column directly to appointments and overwrite it. Instead, derive paid status:

- An appointment is paid if it has at least one `lng_terminal_payments` row with `status = 'succeeded'`
- Use a Postgres view or a simple join in Lounge's appointment query
- This keeps the payment record as the source of truth, supports refunds, and audits cleanly

## Edge functions (Supabase)

All three live in `/supabase/functions/`. All use the new direct Stripe account's secret key.

### 1. `terminal-start-payment`

**Purpose**: Initiate a payment on the reader.

**Method**: POST

**Auth**: Requires authenticated Lounge user (staff)

**Request body**:
```json
{
  "appointment_id": "uuid",
  "amount_pence": 40000,
  "reader_id": "uuid"
}
```

**Logic**:
1. Validate inputs (amount > 0, appointment exists, reader exists and is_active)
2. Look up `stripe_reader_id` from `lng_terminal_readers`
3. Create Stripe PaymentIntent:
   - `amount`: amount_pence
   - `currency`: 'gbp'
   - `payment_method_types`: ['card_present']
   - `capture_method`: 'automatic'
   - `metadata`: { appointment_id, lounge_payment_id }
   - **Idempotency-Key header**: a hash of (appointment_id + amount_pence + current minute) to prevent double-charge if user spam-clicks
4. Insert row into `lng_terminal_payments` with status `'processing'`
5. Call `POST /v1/terminal/readers/{stripe_reader_id}/process_payment_intent` with the PaymentIntent ID
6. Return `{ lounge_payment_id, payment_intent_id, status: 'processing' }` to client

**Errors to handle**:
- Reader offline → return clear error, do not insert payment row
- Reader busy with another payment → return error
- Invalid amount → 400

### 2. `terminal-webhook`

**Purpose**: Receive Stripe events and update payment status.

**Method**: POST

**Auth**: **Stripe signature verification only** (no Supabase auth header — Stripe calls this directly)

**Events subscribed to**:
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.canceled`
- `payment_intent.requires_action` (rare for in-person but possible with SCA)

**Logic**:
1. **Verify signature** using `Stripe-Signature` header and `STRIPE_WEBHOOK_SECRET` env var. If invalid, return 400 immediately. **This is non-negotiable** — without verification, anyone can POST fake success events.
2. Parse event type
3. Find `lng_terminal_payments` row by `stripe_payment_intent_id` (NOT by metadata — payment intent ID is the canonical link)
4. Update status field, populate `succeeded_at` / `failure_reason` / `cancelled_at` as appropriate
5. Return 200 to Stripe quickly (within 3 seconds — do any heavy work async)

### 3. `terminal-cancel-payment`

**Purpose**: Cancel an in-progress payment when customer changes mind or staff aborts.

**Method**: POST

**Auth**: Requires authenticated Lounge user

**Request body**:
```json
{
  "lounge_payment_id": "uuid"
}
```

**Logic**:
1. Look up `lng_terminal_payments` row, get `stripe_reader_id`
2. Call `POST /v1/terminal/readers/{stripe_reader_id}/cancel_action`
3. Update local row status to `'cancelled'` immediately (don't wait for webhook — webhook will confirm later)
4. Return success

## Environment variables (Supabase edge function secrets)

- `STRIPE_SECRET_KEY` — from new direct account, live or test depending on environment
- `STRIPE_WEBHOOK_SECRET` — generated when registering webhook endpoint in Stripe Dashboard
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — for DB writes inside edge functions

**Critical**: Stripe secret key must never be exposed to the browser. All Stripe API calls happen server-side in edge functions only.

## UI requirements (functionality only)

### Trigger

A "Take card payment" action on each appointment in Lounge. Disabled if appointment is already paid.

### Modal flow

A payment modal opens with these states:

1. **Confirm**: Shows appointment summary, amount, reader being used. "Start payment" / "Cancel" buttons.
2. **Waiting on reader**: After "Start payment" is clicked. Shows "Customer to tap or insert card on the reader". Cancel button available (calls `terminal-cancel-payment`).
3. **Succeeded**: Shows success state with payment intent ID for reference. "Done" button closes modal.
4. **Failed**: Shows failure reason from Stripe. "Try again" returns to Confirm state. "Close" exits.
5. **Cancelled**: Shows cancelled state. "Close" exits.

### Realtime updates

Modal subscribes to its own `lng_terminal_payments` row via Supabase realtime. State transitions happen automatically when the webhook updates the row. **No polling.**

### Multiple readers

If `lng_terminal_readers` has more than one active reader, modal shows a reader selector before starting. Default to the most recently used reader for that staff member.

### Reader status indicator

Somewhere in Lounge's main UI (header or settings), show whether the configured reader is online and ready. Use Stripe's `GET /v1/terminal/readers/{id}` endpoint, cached for 30 seconds. Helps staff know if reader is unreachable before they try to take payment.

## Stripe configuration steps (Dashboard)

Done once during setup:

1. **Activate Terminal**: Dashboard → More → Terminal → request activation. Wait for approval (1–3 business days).
2. **Create Location**: Dashboard → Terminal → Locations → "Venneir Lab — Motherwell" with full unit address. Capture the `tml_xxx` Location ID.
3. **Register S700**: Power on reader in dock with ethernet connected. It will display a 3-word pairing code. Dashboard → Terminal → Readers → Register reader → enter code → assign to Motherwell Location. Capture the `tmr_xxx` reader ID.
4. **Insert into `lng_terminal_readers`** with display_name "Motherwell Counter".
5. **Register webhook endpoint**: Dashboard → Developers → Webhooks → Add endpoint → URL is `https://[supabase-project].supabase.co/functions/v1/terminal-webhook`. Subscribe to the four `payment_intent.*` events listed above. Capture the `whsec_xxx` signing secret.
6. **Add secrets** to Supabase: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.

## Testing strategy

### Phase 1: Simulated reader (no hardware)

Stripe provides a Simulated WisePOS E in test mode. Behaves like a real reader, fires real webhooks, accepts test cards.

1. Use test mode keys in edge function secrets
2. Create a test mode Location and Simulated reader
3. Build entire flow end-to-end against simulator
4. Test all paths: success, failure (use test card `4000 0000 0000 0002` for declined), cancellation, network drop

### Phase 2: Real hardware

1. Switch edge function secrets to live keys
2. Update `lng_terminal_readers` to the live reader ID
3. £1 smoke test on a real card belonging to a staff member
4. Verify appointment marked paid in Lounge
5. Issue a £1 refund via Stripe Dashboard to verify refund flow works
6. Go live

## Build order

1. Activate Terminal on the new Stripe account
2. Create Location object
3. Create `lng_terminal_payments` and `lng_terminal_readers` tables
4. Set Supabase edge function secrets (test mode first)
5. Build `terminal-start-payment` edge function
6. Build `terminal-webhook` edge function with signature verification
7. Build `terminal-cancel-payment` edge function
8. Register webhook endpoint in Stripe Dashboard
9. Build payment modal UI with realtime subscription
10. Wire modal trigger into appointments UI
11. Test full flow against Simulated WisePOS E
12. Register real S700, switch to live keys, smoke test
13. Go live

## Critical flags

- **Webhook signature verification is mandatory.** Without `STRIPE_WEBHOOK_SECRET` verification on every webhook call, anyone can POST a fake `payment_intent.succeeded` event and mark appointments paid for free.
- **PaymentIntent must be created server-side only.** Stripe secret key never reaches the browser. All sensitive operations happen in edge functions.
- **Idempotency keys** on PaymentIntent creation prevent double-charges from retries or rapid clicks.
- **Location is mandatory** before a reader can be registered. Don't skip step 2 of Stripe configuration.
- **Use payment_intent_id as the link**, not metadata. Webhook lookups must find the local row by `stripe_payment_intent_id`, not by parsing metadata.
- **Webhook must respond within 3 seconds** with a 200. Stripe will retry on timeout, which causes duplicate processing if not idempotent.
- **Always store amounts in pence (int)**, never pounds (float). Floating point and money never mix.
- **Two Stripe accounts exist**: legacy HubSpot-administered account (untouched, do not use) and the new direct account (use this for everything Terminal-related).

## Out of scope (for v1)

- Refunds initiated from within Lounge (use Stripe Dashboard for now)
- Partial payments / split tender
- Tipping
- Saved cards / future billing (SetupIntent flow)
- Multi-currency (GBP only)
- Cairo / second-location readers (architecture supports it, just not configured)

## Future considerations

- Refund button in Lounge that calls a `terminal-refund` edge function
- Daily reconciliation job that compares Lounge appointment paid totals to Stripe balance transactions
- Email/SMS receipt to customer using existing Lounge customer contact details
- Multiple readers per location with auto-routing based on staff member
