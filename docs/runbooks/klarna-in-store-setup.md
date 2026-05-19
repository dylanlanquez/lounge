# Klarna In-Store API — setup runbook

Native Klarna in-store payment via Klarna's own API (Dynamic QR + payment link). Replaces the prior virtual-Visa-via-Stripe-Terminal flow for Klarna; Clearpay is still on that path.

## Architecture

```
Pay.tsx → KlarnaInStoreModal
            ↓
       klarna-create-session  ──→  Klarna POST /payments/v1/sessions
       (edge function)             POST {distribution.result_url}
            ↓
       lng_payments row (method='klarna', status='processing')
       lng_klarna_sessions row (status='awaiting_customer', qr_code_url set)
            ↓
       Modal shows QR + payment link, customer scans
            ↓
       Klarna webhook → klarna-webhook (edge function)
            ↓
       Cross-verify with result_url, flip session.status='captured'
       Flip payment.status='succeeded'
            ↓
       Modal realtime channel detects update, onSucceeded fires
```

Refunds route through `klarna-refund` (POST `/ordermanagement/v1/orders/{id}/refunds`) when the parent payment's `method='klarna'`; otherwise stay on Stripe (`terminal-refund`).

## Required environment variables

Set on the **Supabase edge function secrets** (not Vercel; the edge functions need them at runtime). Use the Supabase dashboard → Edge Functions → Secrets, or the CLI:

```bash
npx supabase secrets set \
  --project-ref npuvhxakffxqoszytkxw \
  KLARNA_API_USERNAME=<merchant UID> \
  KLARNA_API_PASSWORD=<API password> \
  KLARNA_API_BASE_URL=https://api.klarna.com \
  LOUNGE_PUBLIC_BASE_URL=https://lounge.venneir.com
```

| Variable | Purpose | Notes |
| --- | --- | --- |
| `KLARNA_API_USERNAME` | Merchant UID (the `e408...` half) | Issued by Klarna; lives in the Merchant Portal under API credentials |
| `KLARNA_API_PASSWORD` | Secret API key (the `klarna_live_api_...` half) | Used as HTTP Basic password. **Never commit or paste into chat.** Rotate if exposed. |
| `KLARNA_API_BASE_URL` | Defaults to `https://api.klarna.com` | EU production. Playground for test: `https://api.playground.klarna.com`. Strip trailing slash. |
| `LOUNGE_PUBLIC_BASE_URL` | Defaults to `https://lounge.venneir.com` | Used today only in documentation comments; the webhook URL is built from `SUPABASE_URL` so Klarna calls the edge function directly. |

## Klarna Merchant Portal configuration

1. Issue API credentials for store `K1061874`.
2. Confirm the merchant account is configured for **GBP** currency and **GB** purchase country.
3. No webhook configuration needed on Klarna's side — the callback URL is supplied per-session in the `distribution.callback_urls.status_update` field of the create-session payload.

## Edge functions deployed

| Function | JWT verify? | Purpose |
| --- | --- | --- |
| `klarna-create-session` | Yes (staff JWT) | Creates the Klarna session, retrieves the QR, returns to the till. |
| `klarna-webhook` | **No** (public, token-bound) | Klarna posts status updates here. The `?token=` query param is the trust anchor; it's matched against `lng_klarna_sessions.webhook_token`. Cross-verified by re-fetching the `result_url` before any state change. |
| `klarna-cancel-session` | Yes (staff JWT) | Aborts a pending session when staff hits Cancel. |
| `klarna-refund` | Yes (staff JWT) | Issues a refund against a captured Klarna order. Two-staff sign-off (performer ≠ approver). |

## Tables

- `lng_klarna_sessions` — 1:1 child of `lng_payments` for native Klarna sessions. Stores `klarna_session_id`, `klarna_order_id`, `qr_code_url`, `payment_link_url`, raw API bodies, lifecycle status. RLS: admins + Lounge staff full access. Realtime: publication includes this table so the till QR modal updates the instant the webhook captures the order.
- `lng_payments.method` enum extended with `'klarna'`.
- `lng_payment_refunds.method` enum extended with `'klarna'`.

## Test path (playground)

To test before swapping to live credentials:

1. Set `KLARNA_API_BASE_URL=https://api.playground.klarna.com` and use the playground username + password.
2. Open a test visit on `/visit/...`, click Pay, pick Klarna.
3. Modal opens, calls `klarna-create-session`, displays the QR.
4. Scan with the Klarna app (test mode) and complete.
5. Expect: webhook fires within seconds, modal flips to "Paid £X", `lng_klarna_sessions.status='captured'`, `lng_payments.status='succeeded'`.

## Failure modes + logging

Every Klarna-side error lands on `lng_system_failures` with a `source` identifying the function (`klarna-create-session`, `klarna-webhook`, `klarna-cancel-session`, `klarna-refund`). Critical mismatches (webhook claims COMPLETED but cross-verification disagrees) are logged at severity `critical`.

## Rolling back

The migration's rollback block at the bottom of `20260519000007_lng_klarna_in_store.sql` drops the table + reverts the enum widening. The edge functions can be deleted from the Supabase dashboard or via CLI:

```bash
npx supabase functions delete klarna-create-session klarna-webhook klarna-cancel-session klarna-refund --project-ref npuvhxakffxqoszytkxw
```

Frontend changes in `Pay.tsx` + `payments.ts` + `KlarnaInStoreModal` can be reverted with a `git revert` of the implementing commit.
