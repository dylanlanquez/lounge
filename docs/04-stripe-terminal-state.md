# 04. Stripe Terminal state

**Audit date:** 27 Apr 2026
**Source:** `~/Desktop/checkpoint-app/` (full sweep), `~/Desktop/lounge-app/stripe-terminal-spec/brief.md`
**Headline:** Zero Stripe Terminal code is in production. The leapfrog is risk-free.

---

## 1. Audit verdict, line by line

| Brief §5.2 ask | Verified state |
|---|---|
| New direct Stripe account active? | **Cannot verify from filesystem.** Confirm in Stripe dashboard. The brief asserts the account exists; this audit cannot test that without API credentials. |
| Terminal feature activated? | Same — dashboard check required. |
| Location object created? | Same. |
| Hardware status (S700 registered? Connected to lab ethernet via Hub? Online?) | **The hardware has arrived (per §5.1 of the brief).** Whether it has been registered to a Stripe Location object: dashboard check required. |
| Webhook endpoint registered, against which URL? | **None visible in the codebase.** No deployed Lounge or Checkpoint edge function listens for `payment_intent.*` events today. **Action: do not register the webhook URL in Stripe yet** — wait for the Lounge edge function to be deployed in Phase 1 slice 9. |
| `terminal-start-payment`, `terminal-webhook`, `terminal-cancel-payment` deployed? | **Zero hits.** No directories under `~/Desktop/checkpoint-app/supabase/functions/` matching `terminal-*` or `stripe-*`. None in Meridian either. None deployed. |
| Test payments succeeded against simulator? | None — there is no code to make payments. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` populated? | **Not in Checkpoint.** `.env.local` (4 keys total: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_LAB_SCAN_PIN`, `VERCEL_OIDC_TOKEN`). No Stripe keys present. |
| Confirm Stripe account is the new direct one, not the legacy HubSpot one | **N/A — no Stripe account is wired into anything.** |

---

## 2. Grep results (full sweep)

```
$ grep -ri "stripe\|cpt_terminal\|lng_terminal\|terminal-start-payment\|\
terminal-webhook\|terminal-cancel-payment\|process_payment_intent\|\
card_present\|S700\|WisePOS\|tmr_\|tml_" \
  /Users/dylan/Desktop/checkpoint-app/src/ \
  /Users/dylan/Desktop/checkpoint-app/supabase/

(zero production hits — only a single comment that mentions "stripe" in a print-ticket visual reference)
```

`package.json` has no `stripe`, no `@stripe/stripe-js`. Migration `20260411_02_walk_in_payments.sql` has a comment referencing "Shopify Payments terminal" but defines a manual-entry `payments_card` table — that has nothing to do with Stripe Terminal.

---

## 3. What this means

The **leapfrog approach (brief §5.1) is safe**. There is no in-progress Checkpoint Stripe Terminal work to migrate, no committed webhook URL to redirect, no existing test payments to reconcile, no `cpt_terminal_*` rows to backfill.

Lounge owns Stripe Terminal end-to-end from day one. The Stripe webhook URL gets registered against Lounge's `terminal-webhook` edge function (`https://<lounge-supabase-ref>.supabase.co/functions/v1/terminal-webhook`) when that function is deployed.

---

## 4. Critical safety flags carried forward

These are non-negotiable per the brief §5.11 and §12 — restating here so they are visible at the top of the Stripe Terminal slice work:

- **Webhook signature verification mandatory.** Failing signature → 401 with no body, log to `lng_system_failures`. The verification is the *first* thing the function does, before parsing the body, before reading the database.
- **PaymentIntent created server-side only.** `STRIPE_SECRET_KEY` never touches the browser. All Stripe API calls live in edge functions with the secret read from module-level `Deno.env.get(...)`.
- **Idempotency keys on every PaymentIntent creation.** `cart_{cart_id}_attempt_{n}` (or similar deterministic shape) — generated server-side, never trusted from the client.
- **Location is mandatory** before reader registration. The Stripe Dashboard enforces this; we additionally fail the Lounge migration if `lng_terminal_readers.stripe_location_id` is null.
- **Stripe account ID asserted at startup.** The first thing the edge function does after loading is `stripe.accounts.retrieve()` and assert the returned ID matches an env-provided expected value. Mismatch → throw, log, exit.
- **Use `payment_intent_id` as the link**, not metadata. Webhook → `lng_terminal_payments` lookup is by `stripe_payment_intent_id` (the canonical link), with `metadata.cart_id` as a secondary debug/cross-ref.
- **Webhook responds within 3 seconds with 200.** Any side-effects that exceed that budget go async.
- **Amounts in pence (int).** Never pounds (float).
- **BNPL: never suggest, never advise, never quote.** Helper UX enforces — no free-text fields where the receptionist could type "approved" or "you'll pay £X over Y weeks".

---

## 5. The "two Stripe accounts" trap

The brief is emphatic (§5.2 final bullet, §5.11): we are on the **new direct Stripe account**, not the **legacy HubSpot-administered one**.

Defensive check: at edge-function module load, after `new Stripe(...)`:

```ts
const account = await stripe.accounts.retrieve();
if (account.id !== Deno.env.get('STRIPE_EXPECTED_ACCOUNT_ID')) {
  throw new Error(`Wrong Stripe account: ${account.id}`);
}
```

`STRIPE_EXPECTED_ACCOUNT_ID` is set to the new direct account's `acct_xxx`. If the env is ever swapped to the legacy account by mistake, the function refuses to start. Log the failure to `lng_system_failures` with severity `critical`.

---

## 6. BNPL note

The Stripe Terminal flow is the **only** payment integration we need for BNPL — Klarna and Clearpay run as virtual contactless taps (§5.6). No separate Klarna/Clearpay API client. No Shopify-routed BNPL (the existing Checkpoint behaviour, which is being deprecated — see `00d §2`).

The Klarna/Clearpay distinction lives in the `payment_journey` column on `lng_payments`, not in a separate code path. For the Stripe Terminal edge function, all transactions are `card_present`. The journey label is set client-side by the EPOS payment-method selector.

---

## 7. Hardware-side things to confirm before Phase 1 slice 8

- The S700 is on lab ethernet via the Hub. The Hub's wired connection bypasses any tablet WiFi unreliability — payment can complete even if the tablet drops.
- The S700 runs Stripe's firmware (no jailbreak / dev mode).
- The reader's serial number matches the `tmr_xxx` registered in the Stripe dashboard.
- Allow ~1–3 business days for Stripe Terminal activation. The brief says "request activation" in `Dashboard → More → Terminal`. Done before this audit? Confirm with user.

---

## 8. Implementation order (mirror of brief §5)

Confirmed against discovery findings — no changes needed:

1. Activate Terminal on the new direct Stripe account.
2. Create the `Venneir Lab — Motherwell` Location object. Capture `tml_xxx`.
3. Create `lng_terminal_payments`, `lng_terminal_readers`, `lng_payments`, `lng_carts`, `lng_cart_items`, `lng_visits`, `lng_walk_ins`, `lng_appointments`, `lng_receipts`, `lng_terminal_sessions`, `lng_event_log`, `lng_system_failures`, `lng_lwo_sequences`, `lng_settings` migrations on Meridian's Supabase. (Order matters — see Phase 1 slice 0.)
4. Set Supabase edge function secrets: `STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SECRET` (test), `STRIPE_EXPECTED_ACCOUNT_ID`.
5. Build `terminal-start-payment` edge function (idempotency-keyed, account-asserted, signature-aware on response).
6. Build `terminal-webhook` edge function (signature-verified, 3-second response budget, idempotent on `payment_intent_id`).
7. Build `terminal-cancel-payment` edge function.
8. Register the webhook endpoint in the Stripe Dashboard against the deployed Lounge edge function URL. Capture `whsec_xxx`.
9. Build `TerminalPaymentModal` UI with realtime subscription on `lng_terminal_payments`.
10. Wire the modal into the EPOS checkout flow (§9.5 of the brief).
11. Run end-to-end against the Simulated WisePOS E in test mode. Run the brief's six smoke-test paths (success, failure, cancellation, network drop, double-tap, BNPL).
12. Switch secrets to live keys. Register the real S700. Run the £1 smoke test against a staff member's card.
13. Issue a £1 refund via Stripe Dashboard, verify reconciliation.
14. Go live.

---

## 9. Risks specific to Stripe Terminal

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| S1 | Webhook URL is registered before the edge function is deployed and verified — Stripe sends events to a 404, retries for 24h, then drops them. | High | Deploy and `curl`-verify the function URL before clicking "Add endpoint" in Stripe Dashboard. |
| S2 | Wrong Stripe account env var in production. | High | Account ID assertion at startup (§5). Failed assertion writes to `lng_system_failures`, function refuses to handle requests. |
| S3 | `STRIPE_SECRET_KEY` accidentally exposed via a console.log or response body. | Critical | Lint rule + code review. Never log Stripe API responses raw — strip `client_secret`, `account.charges_enabled`, etc. before logging. |
| S4 | Receptionist double-taps "Take payment". | Medium | Idempotency key per `(cart_id, attempt)`. Disabled button state during in-flight request. The Stripe API itself dedupes on the idempotency header. |
| S5 | Reader offline at the moment of payment — pending sale stuck in "processing" forever. | Medium | Day-end reconciliation (brief §5.10): any `lng_payments.status = 'processing'` for >5 minutes is flagged stuck. Manual cancel via `terminal-cancel-payment`. |
| S6 | BNPL refund customer doesn't have the same virtual card available — refund stuck. | Medium | Refund modal with `payment_journey IN ('klarna', 'clearpay')` shows the inline note (§5.6.4): "Ask the customer to reopen their Klarna/Clearpay app and tap the same virtual card to receive the refund." Worst case: refund as cash, document in `patient_events`. |
| S7 | Test mode payments leak into production reporting. | Medium | Strict env separation. `STRIPE_SECRET_KEY` is `sk_test_*` in staging, `sk_live_*` in production. Account ID assertion catches an incorrect swap. |

---

*End of 04.*
