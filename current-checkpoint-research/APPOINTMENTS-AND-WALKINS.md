# Appointments and walk-ins in Checkpoint

How Calendly bookings, pre-booked appointments, and walk-ins flow through the codebase end to end. Compiled 27 Apr 2026.

This is the operational companion to `CALENDLY-API.md` (which covers the upstream Calendly API surface). That doc tells you what Calendly offers; this doc tells you what Checkpoint actually does with it.

Every claim cites a file and (where useful) a line number so you can verify against the live code. The repo is `/Users/dylan/Desktop/checkpoint-app`.

---

## 1. TL;DR

Checkpoint has three appointment-shaped things that all flow into the same lifecycle:

| Source | How it enters | Linked via | Becomes |
|---|---|---|---|
| Calendly online booking | `sync-calendly` edge function pulls from the Calendly API on demand | `walk_ins.booking_id` = `calendly_bookings.event_uri` (string match, no FK) | A `walk_ins` row when staff explicitly checks the customer in |
| Pre-booked appointment from any other channel | Manual entry in the New Walk-in form | n/a | A `walk_ins` row with `arrival_type = 'pre_booked'` and `scheduled_for` set |
| True walk-in (customer turns up at the door) | Manual entry in the New Walk-in form | n/a | A `walk_ins` row with `arrival_type = 'walk_in'` and no `scheduled_for` |

A `walk_ins` row is the canonical record of any in-person service interaction. The check-in form, the LWO ticket, the till, the lab scan stage, and the checkout all key off it.

**Critical design fact**: a Calendly booking does NOT auto-create a `walk_ins` row. The two are linked only when staff explicitly check the customer in via a form that carries the Calendly URI as a query param or as user-clicked metadata. Until that happens, the Calendly booking sits in `calendly_bookings` and the corresponding walk-in does not exist.

---

## 2. Architecture diagram

```
                       ┌────────────────────────┐
                       │   api.calendly.com     │
                       └───────────┬────────────┘
                                   │
                                   │ Bearer <PAT> (from app_settings.calendly_token)
                                   │
       ┌───────────────────────────┴───────────────────────────┐
       │                                                       │
       ▼                                                       ▼
┌───────────────────────┐                       ┌──────────────────────────┐
│ sync-calendly         │                       │ get-calendly             │
│ (writes to DB)        │                       │ (live read, no DB write) │
└──────────┬────────────┘                       └────────────┬─────────────┘
           │                                                 │
           │ upsert                                          │
           ▼                                                 │
┌─────────────────────────────────────┐                      │
│ calendly_bookings (event row)       │                      │
│ calendly_invitees (cascade FK)      │                      │
└──────────┬──────────────────────────┘                      │
           │                                                 │
           │ string-match on event_uri                       │
           ▼                                                 │
┌─────────────────────────────────────────────────────────────┴────────────┐
│ FRONTEND                                                                 │
│                                                                          │
│   CalendlyWidget (home tile)        │  reads bookings live via get-calendly
│   CalendlyReportsView (full view)   │  reads calendly_bookings + invitees from DB
│   WalkInsView (walk-in queue)       │  reads walk_ins from DB
│                                                                          │
│              user clicks "check in" / opens /walk-ins/.../check-in?booking=URI
│                                                                          │
│   WalkInCheckInPage  ──── createWalkIn(record { booking_id, ... })       │
│                                                                          │
│   WalkInTillPage     ──── recordWalkInPayment(...)  (Postgres RPC)       │
│                                                                          │
│   LabScanPage / MyJobsPage ──── markTechStarted / markTechComplete       │
└──────────┬───────────────────────────────────────────────────────────────┘
           │
           │ INSERT / UPDATE
           ▼
┌──────────────────────────────────────────────────────────────────┐
│ walk_ins                  (one row per service interaction)      │
│ walk_in_line_items        (basket; trigger keeps estimated_total)│
│ payments_cash / _card / _split / _klarna / _clearpay             │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Database schema

### 3a. `calendly_bookings`

Defined in `supabase/migrations/20260410_calendly_bookings.sql`.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `event_uri` | `text NOT NULL UNIQUE` | Full Calendly URI, e.g. `https://api.calendly.com/scheduled_events/<uuid>`. Used by everything as the natural key. |
| `event_name` | `text` | |
| `event_type_uri` | `text` | |
| `event_type_name` | `text` | |
| `event_type_kind` | `text` | `'solo'` or `'group'` |
| `event_type_color` | `text` | Hex from Calendly, used for UI dot colour |
| `status` | `text DEFAULT 'active'` | `'active'`, `'canceled'`, or `'rescheduled'`. The third value is set client-side by the sync function when a cancel is paired with an invitee.rescheduled flag (see §4a phase 3). |
| `start_time` | `timestamptz NOT NULL` | |
| `end_time` | `timestamptz NOT NULL` | |
| `duration_minutes` | `int` | Computed at sync time (`end_time - start_time` in minutes). |
| `location_type` | `text` | `'physical'`, `'google_conference'`, `'zoom_conference'`, etc. |
| `location_detail` | `text` | Address or join URL detail. |
| `join_url` | `text` | Video conference join URL. |
| `invitees_active` | `int DEFAULT 0` | Active attendee count from Calendly. |
| `invitees_limit` | `int DEFAULT 1` | Max attendees the event type allows. |
| `created_at` | `timestamptz DEFAULT now()` | |
| `synced_at` | `timestamptz DEFAULT now()` | Stamped on every upsert. |

**Indexes:** `idx_calendly_bookings_start (start_time)`, `idx_calendly_bookings_type (event_type_name)`.

**RLS:** none. The table is staff-only and lives behind the auth gate at the application layer.

### 3b. `calendly_invitees`

Same migration.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `event_uri` | `text NOT NULL` | FK → `calendly_bookings(event_uri)` ON DELETE CASCADE |
| `invitee_uri` | `text UNIQUE` | Calendly's invitee URI |
| `name`, `email`, `timezone`, `status` | `text` | |
| `is_no_show` | `boolean DEFAULT false` | |
| `is_rescheduled` | `boolean DEFAULT false` | Drives the rescheduled-status detection in §4a. |
| `questions_and_answers` | `jsonb DEFAULT '[]'::jsonb` | Custom Q&A from the booking page. |
| `created_at` | `timestamptz DEFAULT now()` | |

**Indexes:** `idx_calendly_invitees_event (event_uri)`.

### 3c. `walk_ins`

Defined in `supabase/migrations/20260411_01_walk_ins.sql`.

This is the central record. It serves three personas in one shape:
- A walked-in customer with no prior booking
- A pre-booked customer from a non-Calendly source (phone, email, manager-arranged)
- A Calendly booking that has been checked in

Distinguished by the `arrival_type` enum and the optional `booking_id` link.

**Identity / linkage**

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `lwo_ref` | `text NOT NULL UNIQUE` | Format `LWO-YYYYMMDD-NNNN`, generated by the `generate_lwo_ref()` PL/pgSQL function in the same migration. The trigger fires on insert when `lwo_ref` is null. |
| `booking_id` | `text` | Calendly `event_uri` when this walk-in is linked to a Calendly booking. Null otherwise. **Soft link**, no FK constraint. |
| `arrival_type` | `text DEFAULT 'walk_in'` | `'walk_in'` or `'pre_booked'`. |
| `scheduled_for` | `timestamptz` | Set when `arrival_type = 'pre_booked'`. Null for true walk-ins. |
| `status` | `text DEFAULT 'checked_in'` | Lifecycle: `'scheduled'`, `'checked_in'`, `'lwo_raised'`, `'in_lab'`, `'ready'`, `'complete'`, `'cancelled'`. |

**Service shape**

| Column | Type | Notes |
|---|---|---|
| `service_type` | `text NOT NULL` | `'denture_repair'`, `'same_day_appliance'`, `'click_in_veneers'`. Drives form, waiver text, and pricing rules. |
| `appliance_type` | `text` | `'retainer'`, `'night_guard'`, `'day_guard'`, `'whitening_tray'`, `'whitening_kit'`. |
| `arch` | `text` | `'upper'`, `'lower'`, `'both'`. |
| `repair_notes` | `text` | Legacy free-text. Superseded by `walk_in_line_items` but retained for history. `parseRepairNotes()` in `lib/walkins.js` reads this when no line items exist. |

**Customer**

`first_name`, `last_name`, `dob`, `gender`, `address`, `city`, `postcode`, `email`, `phone`, `referral_source`, `referral_detail`.

**Waiver**

`waiver_type`, `waiver_signed_at`, `waiver_signature_svg`, `waiver_staff_id` (FK `auth.users`).

**LWO timestamps**

`lwo_generated_at`, `lwo_printed_at`.

**Payment denormalisation** (filled by `record_walk_in_payment()`, see §3d)

`payment_amount`, `payment_method`, `payment_card_ref`, `payment_cash_amount`, `payment_card_amount`, `payment_taken_at`, `payment_staff_id`, `payment_notes`, `had_discount`.

**Tech / lab**

`tech_scan_started_at`, `tech_scan_started_by`, `tech_scan_completed_at`, `tech_scan_completed_by`.

**Basket and lock**

| Column | Type | Notes |
|---|---|---|
| `estimated_total` | `numeric(10,2)` | Denormalised sum of `walk_in_line_items.line_total`. Kept current by trigger. |
| `items_locked_at` | `timestamptz` | Stamped by `record_walk_in_payment()`. While set, `walk_in_line_items` writes are blocked by trigger. |

**Meta**

`created_by` (FK `auth.users`), `created_at`, `updated_at`, `completed_at`.

**Indexes:** `walk_ins_status_idx`, `walk_ins_created_at_idx`, `walk_ins_booking_id_idx`, `walk_ins_scheduled_for_idx`, `walk_ins_lwo_ref_idx`.

**Triggers:**
- `walk_ins_updated_at` . touches `updated_at` on every UPDATE.
- `generate_lwo_ref()` . fires BEFORE INSERT to populate `lwo_ref` if the caller didn't supply one.

**RLS** (lines 114-124 of the migration):
- `walk_ins_read`: SELECT for any authenticated user.
- `walk_ins_insert`: INSERT for any authenticated user.
- `walk_ins_update`: UPDATE for any authenticated user.

(The model is "any signed-in staff member can act on any walk-in"; granular gating happens through the permission-check helpers in `usePermissions()` rather than RLS.)

### 3d. `walk_in_line_items` and `record_walk_in_payment()`

Defined in `supabase/migrations/20260412_02_walk_in_line_items.sql`.

```sql
walk_in_line_items (
  id                       uuid PK,
  walk_in_id               uuid FK walk_ins ON DELETE CASCADE,
  catalogue_id             uuid FK lwo_catalogue ON DELETE SET NULL,
  catalogue_code           text,
  -- frozen snapshots, immutable once inserted:
  name_snapshot            text NOT NULL,
  description_snapshot     text,
  unit_price_snapshot      numeric(10,2) NOT NULL,
  unit_label_snapshot      text,
  -- attributes selected at check-in:
  service_type             text,
  product_key              text,
  repair_variant           text,
  arch                     text,
  shade                    text,
  qty                      int DEFAULT 1 CHECK (qty > 0),
  line_total               numeric(10,2) GENERATED ALWAYS AS (unit_price_snapshot * qty) STORED,
  sort_order               int DEFAULT 0,
  created_at               timestamptz DEFAULT now()
)
```

**Key behaviours:**

1. **Frozen snapshots.** When a line item is inserted from the catalogue, the price/label are captured as `*_snapshot` columns. Subsequent catalogue changes never re-price an old basket.

2. **`line_total` is generated**, not user-set.

3. **`walk_in_line_items_total_sync` trigger** runs AFTER INSERT/UPDATE/DELETE and re-aggregates `walk_ins.estimated_total = SUM(line_total)` for the parent walk-in.

4. **`walk_in_line_items_lock_guard` trigger** runs BEFORE INSERT/UPDATE/DELETE. If `walk_ins.items_locked_at IS NOT NULL`, it raises an exception. This is what stops basket edits after payment.

**The `record_walk_in_payment()` PL/pgSQL function** (same migration, lines 111-208):

```
record_walk_in_payment(
  p_walk_in_id            uuid,
  p_method                text,             -- 'cash' | 'card' | 'split' | 'klarna' | 'clearpay'
  p_amount                numeric,
  p_taken_by              uuid,             -- staff auth.users.id
  p_lwo_ref               text,
  p_notes                 text,
  p_shopify_ref           text,
  p_cash_amount           numeric,          -- only for 'split'
  p_card_amount           numeric,          -- only for 'split'
  p_discount_type         text,
  p_discount_value        numeric,
  p_discount_amount       numeric,
  p_discount_reason       text,
  p_discount_authorised_by uuid,
  p_original_amount       numeric
) returns jsonb
```

Procedure:
1. `SELECT … FOR UPDATE` on the walk-in row to take a row-level lock.
2. If `items_locked_at IS NOT NULL`, raise an exception ("payment already recorded"). This is the **idempotency guard against double-payment**.
3. INSERT into the matching `payments_*` table for the chosen method.
4. UPDATE the walk-in's denormalised payment columns + set `items_locked_at = now()`.
5. Return `{ payment_id, locked_at }`.

The lock-guard trigger on `walk_in_line_items` then prevents any further edits to the basket. The walk-in is locked for billing purposes from this point forward.

### 3e. Per-method payment tables

`payments_cash`, `payments_card`, `payments_split`, `payments_klarna`, `payments_clearpay`. Same shape (FK to `walk_ins`, FK to `auth.users` on `taken_by`, `amount`, `taken_at`, plus per-method extras like `card_ref` or split breakdowns). `record_walk_in_payment()` picks the right one based on `p_method`.

---

## 4. Edge functions

### 4a. `sync-calendly`

`supabase/functions/sync-calendly/index.ts`. Manually triggered. Writes to `calendly_bookings` and `calendly_invitees`.

**Auth:** reads `app_settings.calendly_token` (a JSON-encoded personal access token, e.g. `"pat_xxx"`). Strips wrapping quotes if present.

**Time window:** 2 years backward to 90 days forward, walked in 90-day chunks (line 75).

**Per chunk (lines 78-156):**

**Phase 1 . fetch and upsert events.** For both `status=active` and `status=canceled`:
```
GET https://api.calendly.com/scheduled_events
  ?user=<URI>
  &min_start_time=<chunk_start_iso>
  &max_start_time=<chunk_end_iso>
  &status=<status>
  &count=100
  &sort=start_time:asc
```
Pagination via `next_page_token`, max 50 pages (line 184). Each event is upserted into `calendly_bookings` keyed on `event_uri` (line 89). `duration_minutes` is computed locally.

**Phase 2 . fetch invitees in batches of 5 concurrent requests** (line 111). For each event:
```
GET https://api.calendly.com/scheduled_events/{uuid}/invitees?count=100
```
Each invitee is upserted into `calendly_invitees` keyed on `invitee_uri` (line 123).

**Phase 3 . rescheduled detection** (lines 137-147). If the booking status is `'canceled'` AND any invitee has `rescheduled = true`, the booking's `status` in `calendly_bookings` is overwritten to `'rescheduled'`. This is purely Checkpoint-side: Calendly's API itself only knows `active` and `canceled`.

**Error handling:** every chunk runs inside its own try/catch. A failed chunk logs and continues. Invitee fetches use `Promise.allSettled` so a per-event 404 (e.g. when an event was deleted between the events call and the invitees call) doesn't fail the batch.

**Response:** `{ success: true, events: <N>, invitees: <M> }` with HTTP 200.

### 4b. `get-calendly`

`supabase/functions/get-calendly/index.ts`. Live read. Does NOT write to the DB.

**Body (POST, all optional):**
```
{
  "min_start_time":     "<ISO>",       // default: now
  "max_start_time":     "<ISO>",       // default: now + 60 days
  "include_all":        boolean,        // include canceled too; default false (active only)
  "include_invitees":   boolean         // attach invitees to each event
}
```

**Flow:**
1. Read token from `app_settings.calendly_token` (lines 72-82).
2. `GET /users/me` → user URI.
3. `fetchEventsByStatus('active')` and optionally `fetchEventsByStatus('canceled')`, paginated via `page_token`.
4. `GET /event_types?user=<URI>&active=true&count=100`.
5. If `include_invitees`: batch-fetch invitees 5 at a time via `Promise.allSettled`.
6. Enrich events with event-type metadata and invitee arrays.
7. Return `{ collection: [...], event_types: { <uri>: <meta> } }`.

This is the function the `CalendlyWidget` and the live preview parts of `CalendlyReportsView` call. It's the right surface to use when you want fresh data without committing to a DB write.

### 4c. There are no other appointment edge functions

All walk-in writes happen client-side via the Supabase JS SDK. The only appointment-related server logic is the two Calendly bridges plus the `record_walk_in_payment()` PL/pgSQL function.

---

## 5. The `lib/walkins.js` API surface

`src/lib/walkins.js` is the single client-side library every walk-in surface imports from. It's the one place to look when you're trying to find which call modifies what. Functional groups:

### 5a. Settings

| Export | Reads/writes | Purpose |
|---|---|---|
| `loadWalkInSetting(key)` | `walk_in_settings` table | Single setting fetch (catalogue version, default service type, etc.). |

### 5b. CRUD

| Export | Reads/writes | Purpose |
|---|---|---|
| `createWalkIn(record)` | INSERT `walk_ins` | LWO ref auto-generated by trigger. Returns the inserted row. |
| `getWalkIn(id)` | SELECT `walk_ins` | By UUID. |
| `getWalkInByLwoRef(lwoRef)` | SELECT `walk_ins` | By LWO reference. |
| `getWalkInByBookingId(bookingId)` | SELECT `walk_ins` | **By Calendly event_uri.** Returns `{id, status}` or null. Used to test whether a Calendly booking already has a checked-in walk-in. (`lib/walkins.js:189-196`) |
| `updateWalkIn(id, updates)` | UPDATE `walk_ins` | Generic patch. Returns the updated row. |
| `listWalkIns({ startDate, endDate, status, serviceType, search })` | SELECT `walk_ins` | List + filter. `search` ilike-matches `first_name`, `last_name`, `lwo_ref`. (`lib/walkins.js:213-230`) |

### 5c. Date / scheduled queries

| Export | Purpose |
|---|---|
| `getWalkInsForDate(date)` | All walk-ins in a single calendar day. |
| `getScheduledWalkIns(startDate, endDate)` | `arrival_type='pre_booked'` only, in the window. |
| `getWalkInCountsByDate(startDate, endDate)` | Per-day counts for calendar visualisations. |

### 5d. Line items / basket

| Export | Purpose |
|---|---|
| `loadLwoCatalogue({ activeOnly })` | The pricing catalogue (`lwo_catalogue` table). |
| `getWalkInLineItems(walkInId)` | Items for one walk-in. |
| `replaceWalkInLineItems(walkInId, items)` | Atomic replacement. Used by the check-in form save path. |
| `resolveCatalogueItem(lineItem, catalogue)` | Match a line item back to its catalogue entry. |
| `importLegacyLineItems(walkIn, catalogue)` | Parse `walk_ins.repair_notes` (legacy free-text) into structured line items. |
| `computeLineItemTotals(lineItems)` | Client-side sum helper. |
| `sumLineItemsTotal(lineItems)` | Total. |

### 5e. Payment

`recordWalkInPayment({ walkInId, lwoRef, method, amount, takenBy, notes, shopifyRef, cashAmount, cardAmount, discount })` (`lib/walkins.js:586-611`).

Calls `supabase.rpc('record_walk_in_payment', params)`. Discount object expanded into the underlying parameters. Returns `{ payment_id, locked_at }`.

| Export | Purpose |
|---|---|
| `getPaymentForWalkIn(walkInId, method)` | Fetch the payment record for a specific method. |
| `getPaymentSummary(startDate, endDate)` | Union across all five `payments_*` tables for reports. |
| `getUnverifiedPayments()` | Admin reconciliation list. |

### 5f. Tech / lab

| Export | Purpose |
|---|---|
| `markTechStarted(walkInId, userId)` | Stamps `tech_scan_started_at` + `tech_scan_started_by`. |
| `markTechComplete(walkInId, userId)` | Stamps the corresponding `_completed_*` fields. |
| `getScansForWalkIn(walkInId)` | Returns scan logs (`lwo_scans` table). |
| `logLwoScan({ walkInId, lwoRef, scannedBy, scanStage, scanNotes })` | Insert a new scan event. |
| `getMyJobs(techUserId)` | Technician's pending list. |
| `getUnmatchedTechScans(startDate, endDate)` | QA report: scans with no matching walk-in. |

### 5g. Checkout

| Export | Purpose |
|---|---|
| `checkoutCollected(walkInId, staffName, notes)` | Sets `status='complete'`, stamps `completed_at`. |
| `checkoutShipped(walkInId, walkIn, address, staffName)` | Same plus a shipping snapshot. |

### 5h. Helpers / printing

`parseRepairNotes()`, `groupItemsByCategory()`, `getWaiverSections()`, `buildCompletedFormHtml()`, `printWalkInLwo()`, `printWalkInForm()`, `getStaffUsers()`, `getManagerUsers()`. Pure rendering / parsing utilities . no DB writes.

---

## 6. Frontend components

### 6a. `CalendlyWidget` (`src/components/CalendlyWidget.jsx`)

A home-screen tile showing upcoming bookings.

- **Data path**: live, hits the Calendly REST API directly from the browser (the token is fetched from `app_settings.calendly_token` and used with a `Bearer` header). It does NOT go through the `get-calendly` edge function. The widget reaches `GET /users/me`, `/scheduled_events?...&status=active`, and `/event_types?...&active=true` from the browser.
- **State**: `loading`, `error`, `events`, `eventTypes`, `expanded` (which event-type group is open).
- **Stats row**: today, this week, total upcoming.
- **Render**: a list of event-type groups, each collapsible, with the next event highlighted.
- **No DB writes**, no realtime . refresh on a manual button click.

### 6b. `CalendlyReportsView` (`src/components/CalendlyReportsView.jsx`)

The full Appointments → Bookings & Reports surface. Mounted at `/calendly-report`.

- **Data path**: reads `calendly_bookings` and `calendly_invitees` from the DB (so it depends on `sync-calendly` having been run recently).
- **`fetchAllData()`** (around line 280) does three queries in sequence:
  1. `SELECT * FROM calendly_bookings`.
  2. `SELECT * FROM calendly_invitees`.
  3. `SELECT id, booking_id, status, payment_taken_at, tech_scan_completed_at FROM walk_ins WHERE booking_id IS NOT NULL` (the walk-in cache, keyed by `booking_id` so the UI can show "checked in", "paid", "tech complete" badges next to a booking).
- **`syncCalendly()`** triggers the edge function and re-fetches. Auto-runs on first load if the bookings table is empty (lines 328-332).
- **Imports from `lib/walkins.js`**: `getWalkInByBookingId`, `createWalkIn`, `getScheduledWalkIns`, `getWalkInCountsByDate`.
- **Conversion path**: a "Create walk-in from booking" button calls `createWalkIn({...record, booking_id: <event_uri>})` which is what plants the `walk_ins.booking_id` link.
- **Rendering**: tabs / calendar / list / charts.

### 6c. `WalkInsView` (`src/components/WalkInsView.jsx`)

Walk-in queue. Mounted at `/walk-ins`.

- Lists `walk_ins` rows with status filters and search.
- "New walk-in" button opens the check-in flow.
- Click-through routes the user to either `/walk-ins/:id/check-in` or `/walk-ins/:id/till` depending on stage.
- Imports nearly the entire `lib/walkins.js` surface (listing, fetch, payment summaries, tech scans, checkout).

### 6d. `WalkInCheckInPage` (`src/components/walkins/WalkInCheckInPage.jsx`)

Multi-step check-in form. Mounted at `/walk-ins/:id/check-in`.

- **Steps**: service type → customer details → waiver signature → LWO preview.
- **Calendly link**: reads `searchParams.get('booking')` to seed `record.booking_id` (line 329). So opening `/walk-ins/new/check-in?booking=<event_uri>` from the bookings view links the walk-in to the Calendly event automatically.
- **Save**: calls `createWalkIn(record)` (line 331), then `replaceWalkInLineItems(savedWalkInId, lineItems)` for the basket.
- **No edge function involvement** . pure client → DB writes.

### 6e. `WalkInTillPage` (`src/components/walkins/WalkInTillPage.jsx`)

Payment surface. Mounted at `/walk-ins/:id/till`.

- Loads the walk-in + its line items + any existing payment.
- `RecordPaymentModal` collects method / amount / staff / discount / Shopify ref.
- Submit calls `recordWalkInPayment(...)` which triggers the PL/pgSQL function described in §3d.
- Once successful, `items_locked_at` is set and the basket becomes immutable.

### 6f. Other walk-in components

| Component | Path | Purpose |
|---|---|---|
| `LabScanPage` | `src/components/walkins/LabScanPage.jsx` | Tech scans the LWO barcode at the bench → logs to `lwo_scans` and stamps tech timestamps. |
| `MyJobsPage` | `src/components/walkins/MyJobsPage.jsx` | The technician's queue of in-flight jobs. |
| `WalkInReportsView` | `src/components/walkins/WalkInReportsView.jsx` | Visitor analytics. |
| `RecordPaymentModal` | `src/components/walkins/RecordPaymentModal.jsx` | Payment entry modal used by `WalkInTillPage`. |
| `WalkInSettingsView` | `src/components/WalkInSettingsView.jsx` | Admin config (catalogue, waiver text, default service type). Mounted at `/walk-ins-settings`. |
| `LabCheckOutModal` | `src/components/LabCheckOutModal.jsx` | Final collected/shipped checkout. |

---

## 7. Routing and permissions

### 7a. Routes

`src/App.jsx` (lines 9-10, 274-275):
```
<Route path="/walk-ins/:id/check-in" element={authWrap(<WalkInCheckInPage ... />)} />
<Route path="/walk-ins/:id/till"     element={authWrap(<WalkInTillPage ... />)} />
```

The other surfaces are mounted as views inside `Dashboard.jsx` and selected via `activeView`:

| `activeView` | Path | Component |
|---|---|---|
| `'calendly-report'` | `/calendly-report` | `CalendlyReportsView` |
| `'walk-ins'` | `/walk-ins` | `WalkInsView` |
| `'walk-ins-settings'` | `/walk-ins-settings` | `WalkInSettingsView` |
| `'walk-ins-reports'` | `/walk-ins-reports` | `WalkInReportsView` |
| `'my-jobs'` | `/my-jobs` | `MyJobsPage` |

### 7b. Sidebar grouping (`Dashboard.jsx` line 1006)

The five views are grouped under one Appointments section in the sidebar. The group only renders if the user has at least one of:

- `appointments_bookings` . Calendly bookings + reports
- `appointments_walkins` . walk-in queue
- `appointments_reports` . bookings reports tabs
- `appointments_visitor_reports` . visitor analytics
- `appointments_settings` . admin config

Permission resolution is via `usePermissions().hasPerm(<perm>)` from `src/lib/PermissionsContext.js`.

---

## 8. End-to-end lifecycle traces

### 8a. Sync Calendly → display

1. Admin clicks the Sync button in `CalendlyReportsView`.
2. Frontend calls `POST /functions/v1/sync-calendly` (no body).
3. Edge function reads `app_settings.calendly_token`.
4. Walks 2yr back / 90d forward in 90d chunks (active + canceled per chunk).
5. Upserts each event into `calendly_bookings` keyed on `event_uri`.
6. Batch-fetches invitees per event (5 at a time) and upserts into `calendly_invitees`.
7. For each canceled event, checks `is_rescheduled` on its invitees; if any, flips the booking status from `'canceled'` to `'rescheduled'`.
8. Returns `{ success, events, invitees }`.
9. `CalendlyReportsView` calls `fetchAllData()` to re-pull the DB and re-renders.

### 8b. Manual walk-in creation (no Calendly link)

1. User opens `WalkInsView`, clicks New Walk-in.
2. `WalkInCheckInPage` mounts at `/walk-ins/new/check-in` (no `?booking=` param).
3. User fills service → customer → waiver → basket steps.
4. On submit, `createWalkIn(record)` runs:
   - `record.booking_id = null`
   - `record.arrival_type = 'walk_in'` by default (or `'pre_booked'` if the form set a `scheduled_for`)
   - INSERT into `walk_ins`. The `generate_lwo_ref()` trigger stamps `lwo_ref`.
5. `replaceWalkInLineItems(walkInId, lineItems)` populates the basket; the `walk_in_line_items_total_sync` trigger keeps `walk_ins.estimated_total` accurate.
6. The user is redirected to the till to take payment, or the check-in is parked at status `'lwo_raised'` for the tech to pick up.

### 8c. Calendly booking → walk-in conversion

1. The booking already exists in `calendly_bookings` (from a sync run).
2. User opens `CalendlyReportsView`, finds the booking, clicks "Create walk-in" or follows a link with `?booking=<event_uri>`.
3. `WalkInCheckInPage` opens with `record.booking_id = event_uri` pre-set (from `searchParams`).
4. The customer arrives, staff confirms / amends details, signs the waiver.
5. Save runs the same `createWalkIn(record)` path as 8b but with `booking_id` populated and `arrival_type = 'pre_booked'`.
6. From now on `getWalkInByBookingId(event_uri)` returns the walk-in, so the bookings view will badge that booking as "checked in".

### 8d. Payment

1. User clicks Take Payment in `WalkInTillPage`.
2. `RecordPaymentModal` collects method / amount / staff / discount / Shopify ref.
3. Submit calls `recordWalkInPayment({...})` which `supabase.rpc()`s `record_walk_in_payment`.
4. Postgres takes a row lock on the walk-in.
5. If `items_locked_at` is already set, the function raises an exception (idempotent guard against double-payment).
6. Otherwise: INSERT into the matching `payments_*` table, UPDATE the walk-in's denormalised payment fields, set `items_locked_at = now()`.
7. Post-payment, the `walk_in_line_items_lock_guard` trigger refuses any further INSERT/UPDATE/DELETE on the basket for this walk-in.
8. Frontend receives `{ payment_id, locked_at }` and routes to lab scan or completion.

### 8e. Lab scan and checkout

1. Tech opens `LabScanPage` or scans the LWO barcode.
2. `markTechStarted(walkInId, userId)` stamps `tech_scan_started_at` + `_started_by`.
3. After scanning, `markTechComplete(walkInId, userId)` stamps the completed pair.
4. `logLwoScan(...)` writes a row into `lwo_scans` (one per scan event for audit).
5. When ready for handover, `LabCheckOutModal` calls `checkoutCollected()` or `checkoutShipped()` which sets `status='complete'`, stamps `completed_at`, and writes any shipping snapshot.

---

## 9. Token storage and rotation

The Calendly Personal Access Token lives at `app_settings.calendly_token` as a JSON-encoded string (e.g. the value column literally contains `"pat_xxxxx"` including the quotes). All three consumers (`CalendlyWidget`, `sync-calendly`, `get-calendly`) strip the wrapping quotes if present.

**There is currently no UI to set or rotate the token.** The expected home would be a card in `AdminView`, but it isn't there yet. To set the token today you run SQL directly:

```sql
INSERT INTO app_settings (key, value) VALUES ('calendly_token', '"pat_xxx"')
ON CONFLICT (key) DO UPDATE SET value = '"pat_xxx"';
```

When the token is invalid or expired, `CalendlyWidget` shows an error with a retry button and the sync function returns 500. There is no automatic recovery and no notification . you find out by noticing bookings have stopped appearing.

This is the highest-priority papercut to fix when this surface gets attention next: a tiny admin card that does the SET above, with a "test connection" button that pings `GET /users/me`.

---

## 10. What's NOT in the current build

Listing the gaps explicitly so they don't get re-discovered as bugs:

1. **No realtime.** None of the appointment surfaces use Supabase realtime / `postgres_changes`. All updates require a manual refresh (or for `CalendlyReportsView` you can click Sync). Two staff members operating the till + the tech bench will not see each other's updates without refreshing.

2. **No automatic walk-in creation from a Calendly booking.** A booking sits in `calendly_bookings` until staff explicitly creates a walk-in for it. This is by design (to avoid pre-creating rows for no-shows), but it does mean the conversion-rate metrics in the reports view need staff discipline.

3. **No periodic `sync-calendly` schedule.** The function only runs when a human clicks Sync, or when `CalendlyReportsView` auto-runs it on first load with an empty bookings table. There is no cron invocation in the repo. If staff don't open the reports view for a week, the bookings table is a week stale.

4. **No webhook subscription.** Checkpoint pulls from Calendly; it doesn't receive pushes. The `webhook_subscriptions` API (see `CALENDLY-API.md` §8) is not used. So a cancellation in Calendly is invisible until the next sync.

5. **No Calendly token rotation UI.** §9 above.

6. **`walk_ins.booking_id` is a TEXT column with no FK constraint.** The link to `calendly_bookings.event_uri` is by string match. A typo or a renamed event silently de-links. Indexed for performance (`walk_ins_booking_id_idx`) but not enforced for integrity.

7. **No Calendly events for routing forms.** `routing_form_submission.created` is supported by Calendly but Checkpoint doesn't sync routing form data anywhere.

8. **All walk-in writes are client-side.** No edge function mediates them. A misbehaving client can in principle write malformed data; the only guards are RLS (allows any authenticated user to write) and DB triggers / CHECK constraints. If multi-tenant isolation ever matters, this is where to start tightening.

9. **`CalendlyWidget` calls Calendly directly from the browser.** This works because the Calendly API allows browser CORS, and the token is exposed to the browser anyway via `app_settings`. But it means the token is visible to anyone with a network tab open. For a single-tenant internal app this is acceptable; for a multi-tenant product it would not be.

10. **`payments_*` are five parallel tables, not a polymorphic `payments` table with a `method` column.** Every report has to UNION across all five (`getPaymentSummary` does this). Adding a sixth method (e.g. Apple Pay) means a new table + a new branch in `record_walk_in_payment()` + a new entry in the union.

---

## 11. File reference

**Migrations:**
- `supabase/migrations/20260410_calendly_bookings.sql` . `calendly_bookings`, `calendly_invitees`
- `supabase/migrations/20260411_01_walk_ins.sql` . `walk_ins`, `generate_lwo_ref()`, RLS
- `supabase/migrations/20260412_02_walk_in_line_items.sql` . line items, lock trigger, `record_walk_in_payment()`
- (per-method payment tables live in their own migrations under the same date prefix)

**Edge functions:**
- `supabase/functions/sync-calendly/index.ts`
- `supabase/functions/get-calendly/index.ts`

**Library:**
- `src/lib/walkins.js` . single client-side walk-in API
- `src/lib/PermissionsContext.js` . `hasPerm('appointments_*')` gates

**Components (Calendly):**
- `src/components/CalendlyWidget.jsx` . home tile
- `src/components/CalendlyReportsView.jsx` . full bookings + reports surface (`/calendly-report`)

**Components (walk-ins):**
- `src/components/WalkInsView.jsx` . queue (`/walk-ins`)
- `src/components/WalkInSettingsView.jsx` . admin config (`/walk-ins-settings`)
- `src/components/walkins/WalkInCheckInPage.jsx` . check-in form (`/walk-ins/:id/check-in`)
- `src/components/walkins/WalkInTillPage.jsx` . till (`/walk-ins/:id/till`)
- `src/components/walkins/LabScanPage.jsx` . bench scan
- `src/components/walkins/MyJobsPage.jsx` . tech queue (`/my-jobs`)
- `src/components/walkins/WalkInReportsView.jsx` . visitor reports (`/walk-ins-reports`)
- `src/components/walkins/RecordPaymentModal.jsx` . payment entry modal
- `src/components/LabCheckOutModal.jsx` . collected / shipped completion

**Routing:**
- `src/App.jsx` . `:id/check-in` and `:id/till` route definitions
- `src/pages/Dashboard.jsx` . Appointments sidebar group + view-key dispatch

---

*Compiled 27 Apr 2026. Drift-prone . verify any function name or column reference against the live source before relying on it for production code.*
