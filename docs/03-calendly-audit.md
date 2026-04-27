# 03. Calendly integration audit

**Audit date:** 27 Apr 2026
**Source:** `~/Desktop/lounge-app/calendly-api-docs/CALENDLY-API.md`, `~/Desktop/lounge-app/current-checkpoint-research/APPOINTMENTS-AND-WALKINS.md`, `~/Desktop/checkpoint-app/supabase/functions/sync-calendly/`, `.../get-calendly/`, `~/Desktop/checkpoint-app/src/components/CalendlyWidget.jsx`, `.../CalendlyReportsView.jsx`
**Headline:** Today's integration is **pull-only with a personal access token**, no webhooks, no rotation, no realtime. The brief's Option A (Calendly stays as the booking surface) is achievable but requires us to add Calendly webhooks for the freshness guarantee in §4.4.

---

## 1. Account and event types

The Calendly account, scheduling URLs, event types, and staff host mapping are not enumerable from the codebase alone — they live in the Calendly account configuration. Code reads them at runtime via `/users/me`, `/event_types`, `/scheduled_events`. To produce a snapshot we need a one-shot `GET /event_types?user=<URI>&active=true&count=100` against the live token; that is a Phase 1 settings-page task.

**Action item for user:** confirm which Calendly user owns the integration (the personal access token is bound to one user) and whether their event types map cleanly to a single Venneir lab location. Multi-location support requires either a per-user PAT or moving to OAuth org-scope (see §6).

---

## 2. OAuth and tokens

### Today

- **Type:** Personal Access Token (PAT). Single-account scope.
- **Storage:** `public.app_settings (key='calendly_token', value='"pat_xxxx"')` — a JSON-encoded string with literal wrapping quotes. All three consumers strip the quotes.
- **Owner:** the Calendly user whose API was used at install time. Not documented in the codebase.
- **Refresh:** none required for PATs. They do not expire on a clock; they revoke on:
  - Login email change
  - Password change
  - Login method change
  - Manual revocation
- **Rotation UI:** **none**. To rotate the PAT today you run SQL:
  ```sql
  UPDATE app_settings SET value = '"pat_new"' WHERE key = 'calendly_token';
  ```
- **Discovery on revocation:** **silent failure**. Bookings stop appearing; nothing alerts.

### Three consumers

1. `CalendlyWidget` — calls `https://api.calendly.com` **directly from the browser** (the PAT is fetched into the page and used as a Bearer header). This means the token is visible in browser dev tools.
2. `sync-calendly` edge function — server-side; reads from `app_settings` and walks the Calendly API to upsert into `calendly_bookings` / `calendly_invitees`.
3. `get-calendly` edge function — server-side; live read with no DB write.

### Brief implication

Lounge starts on the same PAT for Phase 1 (cheapest path). Two upgrades for v1.5:

- **Move the browser-side widget call into a Lounge edge function.** Same shape as `get-calendly`. Removes browser exposure of the PAT.
- **Add a Lounge admin "Calendly token" card** with a "test connection" button (`GET /users/me`) and an "update token" form. Eliminates SQL-by-hand rotation.

---

## 3. Webhooks

**Today: none.** No `webhook_subscriptions` calls anywhere in Checkpoint. `calendly_bookings` is populated by **manual or first-load triggered** sync only.

This is the largest gap vs the brief's §4.4 freshness guarantee. To meet **"a booking made 10 seconds ago is visible"** we must add webhooks.

### What we will subscribe to

Per `CALENDLY-API.md §8`:

- `invitee.created` — fires when a new invitee schedules.
- `invitee.canceled` — fires on cancellation. The payload's `rescheduled` field is `true` for reschedules (Calendly fires `invitee.canceled` on the original event, then `invitee.created` on the new one).
- `routing_form_submission.created` — only if Phase 1 reveals routing forms in use (org-scope only).

### Subscription scope

`user`-scope is enough for Phase 1 (we have one Calendly user). When Venneir adds a second location with its own Calendly user, switch to `organization`-scope (requires owner/admin role in the Calendly org).

### Plan tier

Per `CALENDLY-API.md §9`, webhooks require **Standard plan or higher**. Confirm Venneir's Calendly plan tier before relying on this.

### Signing

Generate a signing key on our side, register it with the subscription, verify HMAC-SHA256 over `<t>.<raw_body>` against `Calendly-Webhook-Signature` on every delivery. Reject deliveries older than 3 minutes (replay protection). This is the same pattern as the Stripe webhook signature verification — both edge functions will share a verification helper.

### Idempotency

Per the brief §4.3:

- Each webhook delivery has a unique ID. We store the raw payload keyed on it in `lng_calendly_bookings` (separate from `lng_appointments` — the appointments table is the cleaned/normalised view, the bookings table is the raw payload sink).
- Duplicate delivery → no-op.

### Replay and reconciliation

- **Replay job.** A button in admin: "Backfill last N hours from Calendly API" — calls `/scheduled_events` with the time range and re-runs the webhook handler logic on each row. Used after an outage.
- **Daily reconciliation.** Cron: compare `lng_appointments` against `/scheduled_events` for the next 14 days. Any drift → row in `lng_system_failures` with severity `warning`. Recommend running 03:00 UTC daily.

---

## 4. Current data flow

### End-to-end as of today

1. Patient lands on `https://calendly.com/<account>/<event-type>` (the Calendly-hosted page).
2. Patient picks a slot, fills the booking form, confirms.
3. Calendly creates the event and the invitee. **Nothing happens in Checkpoint.**
4. (Eventually) admin clicks "Sync" in `CalendlyReportsView`, or the view auto-syncs on first load with an empty bookings table.
5. `sync-calendly` walks 2 years backward / 90 days forward in 90-day chunks, paginated. Upserts into `calendly_bookings` and `calendly_invitees`.
6. **A `walk_ins` row is NOT created automatically.** The Calendly booking sits in `calendly_bookings` until staff explicitly checks the customer in via `WalkInCheckInPage` with the `?booking=<event_uri>` query param. Only at that point is the link planted (`walk_ins.booking_id = event_uri`, soft link, no FK).

### What this means for the brief

The brief's identity-resolution flow (§6.4: "A patient books on Calendly. Webhook fires. Identity resolution runs. Match → create `lng_appointments`. No match → insert new `patients` row, then `lng_appointments`") is **not what happens today**. Today, the Meridian `patients` row is only created when a Meridian case is submitted referencing the walk-in (PATIENTS.md §6b). This is an explicit Phase 3 / Phase 4 change.

Implication: when we cut over to webhook-driven creation, we will start creating `patients` rows on `invitee.created`, not on first case submission. We need to handle:

- Bookings that never become walk-ins (no-shows, cancellations) — patient row stays, just never gets a `lwo_ref` stamped.
- Bookings that resolve to an existing patient via §6.1 — fill-blanks merge, no overwrite.

---

## 5. Patient-side experience

The patient receives the booking link via:

- Direct landing on `calendly.com/...` from the Venneir website (pre-fill via URL params).
- Pre-fill not currently used in Checkpoint that I can see; the link is a bare scheduling URL.
- Email or SMS confirmation from Calendly itself (sent by Calendly, not by us).

The patient's reschedule and cancel URLs come from Calendly's own pages (`cancel_url`, `reschedule_url` on the invitee payload). Today we surface these to the receptionist via the `CalendlyReportsView` detail panel.

**Implication for Lounge Option A:** Reschedule and cancel both go via Calendly URLs. Lounge does not own these flows. The brief's Option B (Lounge becomes source of truth) would require a new edge function that calls `POST /scheduled_events/{uuid}/cancellation` from staff action; Option C replaces the entire booking surface natively.

---

## 6. Reschedule / cancel flow

| Direction | Today |
|---|---|
| Calendly → Checkpoint cancel | Webhook **not** subscribed → cancel is invisible until next manual sync. After sync, `calendly_bookings.status = 'canceled'` (and possibly `'rescheduled'` if any invitee has `is_rescheduled = true`, see §4a phase 3 of `APPOINTMENTS-AND-WALKINS.md`). |
| Calendly → Checkpoint reschedule | Same — invisible until sync. |
| Checkpoint → Calendly cancel | Not implemented. Receptionist phones the patient and the patient cancels via their own email link. |
| Checkpoint → Calendly reschedule | Not implemented. Same. |

This is workable if walk-in volume is low and no-show tolerance is acceptable. It is not workable for Phase 1 freshness goals (§4.4 smoke test). Webhooks are the fix.

---

## 7. Failure modes today

| Failure | Symptom | Fix today |
|---|---|---|
| PAT revoked (any §2 trigger) | Bookings stop appearing. Sync returns 500. Widget shows "error" with retry button. | Manual SQL update of `app_settings.calendly_token`. |
| Calendly API rate-limit (60/min on Free/Standard/Teams; 120/min on Enterprise) | 429 from the API. `sync-calendly` does **not** honour `Retry-After` automatically — it logs and continues to the next chunk. | Spread sync runs out, or upgrade to Enterprise. |
| Event deleted between events-list call and invitees call | 404 on the invitees fetch — caught by `Promise.allSettled`, logged, skipped. | None needed. |
| No-show booking | `calendly_invitees.is_no_show = true` if marked from Calendly's UI. Checkpoint does not auto-update walk-in status from this. | Manual reconciliation. |
| Double-booking | Possible — Checkpoint does not validate against `walk_ins.scheduled_for` overlap. | Manual eyes-on review. |
| Token visible to anyone with browser dev tools | (Widget calls Calendly directly from browser.) | Move widget reads through edge function (§2 future work). |

**Most common operational complaint per APPOINTMENTS-AND-WALKINS.md §10:** "If staff don't open the reports view for a week, the bookings table is a week stale." This is exactly the freshness problem webhooks solve.

---

## 8. Architecture decision: Option A is the right call

Per the brief §4.2:

| Option | Verdict |
|---|---|
| **A. Calendly stays as the booking surface.** | **Adopt for v1.** Webhooks added on top of the existing pull-based sync. Reschedule/cancel still happen via Calendly URLs. |
| **B. Lounge becomes source of truth, Calendly is one publisher.** | Defer to v1.5. Adds a `terminal-cancel-payment`-shaped edge function for cancel-back-to-Calendly, plus `POST /scheduled_events` for create. |
| **C. Lounge replaces Calendly.** | Out of scope for v1 and v1.5. Considerable product surface (availability rules, slot picker, public booking page, SMS/email confirmations, ICS attachments). Re-evaluate at end of v1.5. |

### Reasoning

1. The brief's preference is A → B evolution (§4.2 final paragraph).
2. Today's integration is barely-integrated (no webhooks, manual sync). Replacing with webhooks-driven A meets the freshness smoke test (§4.4) without re-implementing Calendly's product. Cost is one edge function (`calendly-webhook`) and one daily cron.
3. The Phase 0 evidence does not show high enough drift, manual re-typing, or workflow friction to justify B yet. (User notes: zero hits for "manual re-typing" or workaround language.)
4. Option C is a separate product. Keep on the long-term roadmap.

---

## 9. Implementation sketch (for Phase 1 slice 3)

### Tables (in `lng_*`, on Meridian's project)

```sql
-- Raw payload sink, keyed on Calendly's webhook delivery ID for idempotency
create table public.lng_calendly_bookings (
  id                       uuid primary key default gen_random_uuid(),
  delivery_id              text not null unique,       -- Calendly's webhook delivery ID
  event                    text not null,              -- 'invitee.created' | 'invitee.canceled' | ...
  payload                  jsonb not null,             -- raw, unmodified
  signature_verified_at    timestamptz not null default now(),
  processed_at             timestamptz,
  appointment_id           uuid references public.lng_appointments(id),
  failure_reason           text,
  created_at               timestamptz not null default now()
);

-- Cleaned, queryable view of an appointment regardless of source
create table public.lng_appointments (
  id                       uuid primary key default gen_random_uuid(),
  patient_id               uuid not null references public.patients(id),
  location_id              uuid not null references public.locations(id),
  source                   text not null check (source in ('calendly', 'native', 'manual')),
  calendly_event_uri       text,
  calendly_invitee_uri     text,
  start_at                 timestamptz not null,
  end_at                   timestamptz not null,
  staff_account_id         uuid references public.accounts(id),
  event_type_label         text,
  status                   text not null default 'booked'
                              check (status in ('booked', 'arrived', 'in_progress', 'complete',
                                                'no_show', 'cancelled', 'rescheduled')),
  cancel_reason            text,
  reschedule_to_id         uuid references public.lng_appointments(id),
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
```

(Indexes, triggers, RLS, and FK to `patient_id` follow the same pattern as Meridian's existing tables. Final shape locked in Phase 1 slice 1 plan.)

### Edge function

`calendly-webhook` — public endpoint, **no Supabase auth header required** (Calendly does not authenticate via Supabase). Verifies HMAC-SHA256 against the configured signing key, rejects deliveries with `t > 3 minutes ago`, writes raw to `lng_calendly_bookings`, then runs identity resolution (§6.1) and writes to `lng_appointments`.

### Replay button + daily cron

`calendly-backfill` (admin-only Lounge edge function) and `calendly-reconcile` (cron, 03:00 UTC) — both call `/scheduled_events` and run the same handler logic.

### Smoke test (per brief §4.4)

> "A receptionist opens the schedule on the tablet at 8am. Every Calendly booking made overnight is visible. A booking made 10 seconds ago is visible. A cancellation made 10 seconds ago is gone."

Achievable once the webhook is wired. The cancellation case relies on `invitee.canceled` firing within seconds; per Calendly's docs, deliveries are typically sub-second.

---

## 10. Open questions to confirm with user

1. Calendly plan tier — Standard or higher (required for webhooks)?
2. Calendly user owning the PAT — single-user OAuth → org-scope migration on the table?
3. Pre-fill on the booking link — currently bare URL; do we want to pass `name`, `email`, `phone` through query params to skip the form when the patient is known?
4. Routing forms — do any exist? If yes, `routing_form_submission.created` matters.
5. Multi-location — Glasgow, London, Motherwell — separate Calendly accounts or one with multiple event types? Affects scope decision.

---

*End of 03.*
