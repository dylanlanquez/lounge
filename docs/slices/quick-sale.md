# Slice — Quick Sale (retail products, take payment)

**Status:** Built, type-checked + linted, awaiting manual + shadow verification
**Phase:** Cross-cutting (catalogue + payments)
**Migrations (this slice):** none — the feature is data + UI only

There was no way to sell a **product on its own**. Every payment flows
through `visit_id → lng_carts → lng_payments`, and every cart/visit is born
from a clinical booking or walk-in, so a customer buying a retail product at
the counter had no path. Quick Sale adds a focused, full-screen retail flow
that reuses the **existing** payment stack (Terminal card, over-the-phone
MOTO, cash) by materialising a lightweight visit + cart, then handing off to
the existing Pay screen.

It is **invisible to clinical operations** (never on the Schedule, never on
the In-clinic board) but **visible in the financial Ledger** as a "Retail
sale".

**Touched files:**
- `src/routes/QuickSale.tsx` — new full-screen page: client-state basket, optional "Add customer", products-only picker, bag + total, "Take payment"
- `src/lib/queries/quickSale.ts` — `getOrCreateCounterSalePatient`, `createQuickSaleSale`, the `QuickSaleLine` shape, and the `'retail'` service-type discriminator
- `src/lib/queries/patients.ts` — `COUNTER_SALE_EMAIL`, `useCounterSalePatientIds` (hides the system patient from list/search), and the shared `createPatient` / `humanizePatientSaveError` helpers
- `src/routes/NewWalkIn.tsx` — refactored onto the shared `createPatient` helper (one way to create a patient)
- `src/components/CataloguePicker/CataloguePicker.tsx` — new `productsOnly` prop (hides Services, retail-only copy)
- `src/lib/queries/carts.ts` — `catalogueLineTotalPence` (shared staged-line pricing, used by the bag total)
- `src/components/BottomNav/BottomNav.tsx` — 6th "Quick sale" tab (grid 5 → 6 columns)
- `src/App.tsx` — `/quick-sale` route (RequireStaff, lazy)
- `src/routes/Pay.tsx` — `from: 'quick_sale'` entry state: "Done" returns to `/quick-sale`, and Klarna/Clearpay are suppressed
- `src/lib/queries/appointments.ts` — `formatCustomerServiceTitleLabel` renders `service_type='retail'` as "Retail sale"
- `tests/quick-sale.spec.ts` — route-gating smoke

---

## 1. User story

> As a receptionist, I tap **Quick sale**, add one or more products to the
> bag (setting any options/quantity), optionally attach a customer, and tap
> **Take payment**. I pay by card, over the phone, or cash on the same screen
> I already use. The sale shows in the Ledger as a "Retail sale" and never
> clutters the Schedule or the In-clinic board.

---

## 2. The model (why it needs no migration)

A Quick Sale materialises the standard FK chain, but tuned so it stays out of
clinical surfaces:

- **Counter Sale patient** — the FK chain needs a `patient_id`. A walk-up sale
  with no named customer rings up against a shared per-location system patient
  identified by the sentinel email `counter-sale@lounge.internal`. The existing
  per-location email unique index makes "one Counter Sale row per location" a
  database guarantee, so `getOrCreateCounterSalePatient` is idempotent and
  race-safe with **no new column or settings row**. `useCounterSalePatientIds`
  filters it out of the Patients list and search.
- **Walk-in row** (`service_type='retail'`) — satisfies the `lng_visits`
  one-origin constraint and is what surfaces the sale in the Ledger
  (`lng_ledger` unions the walk-in arm). `service_type='retail'` is the
  discriminator the Ledger label reads.
- **Visit** — created `status='complete'`, `fulfilment_method='in_person'`,
  with **no `lng_appointments` marker**. No marker → off the Schedule.
  `status='complete'` (never `arrived`) → off the In-clinic board and its count
  badge. Pay does not gate on visit status, so the payment screen works as-is.
- **Cart + lines** — written by the existing `addCatalogueItemsToCart`, so the
  receipt math is identical to a clinical cart.

The basket is held in **client state** until "Take payment", so an abandoned
basket writes **zero** rows.

---

## 3. Smoke test (plain English)

1. The floating bottom nav shows a 6th **Quick sale** tab. Tap it → full-screen
   Quick Sale page, "The bag is empty" with an **Add products** button.
2. Tap **Add products** → the picker opens titled **Choose a product**. Only
   **products** are listed (no Services group). Add a simple product, then add
   a configurable one (arch/shade/upgrade) → both land in the bag with the
   right subtitle and price; the total updates.
3. Use the qty stepper and the trash icon on a bag line → quantities and the
   total update; removing the last line returns the empty state.
4. Tap **Add customer** → a sheet opens with patient search. Pick an existing
   patient → the customer card shows their name and "Sale will be saved to this
   record". Tap **Remove** → back to "Walk-up customer". (Searching never shows
   "Counter Sale".)
5. Tap **Take payment** → the existing Pay screen. It shows **Card / Over the
   phone / Cash only** — no Klarna, no Clearpay. Take a **cash** payment → the
   success screen. Tap **Done** → returns to a **fresh** Quick Sale page.
6. Open the **Ledger** → the sale appears as **"Retail sale"**, paid.
7. Open the **Schedule** and the **In-clinic** board → the sale is on **neither**,
   and the In-clinic count badge did not tick up.
8. Repeat with **Add customer** attached → the sale lands on that patient's
   record and their email prefills the receipt.

Automated: `tests/quick-sale.spec.ts` confirms `/quick-sale` is gated behind
staff sign-in (full pay flow needs an authed session + Stripe test mode, so it
is the manual smoke above).

---

## 4. Verification done

- `tsc -b --noEmit` clean.
- `eslint` clean on every touched + new file (the repo's pre-existing
  `react-hooks/rules-of-hooks` and `no-useless-escape` findings in Pay.tsx /
  patients.ts / NewWalkIn.tsx are unchanged — verified identical against the
  stashed baseline).
- Unit suite: no new failures (the 9 pre-existing failures in
  `emailTemplates` / `reports` / `SnippetEditor` are unchanged against the
  stashed baseline; `NewWalkIn.test.ts` 16/16 green after the `createPatient`
  refactor).
- Playwright route-gating smoke passes.

---

## 5. Notes / follow-ups

- **BNPL** is deliberately suppressed on Quick Sale (CLAUDE.md: "BNPL: never
  suggest"). The Pay screen hides Klarna/Clearpay when `from==='quick_sale'`.
- **Atomicity:** `createQuickSaleSale` mirrors the arrival wizard's non-atomic
  insert sequence (supabase-js has no client transaction). The failure window
  is tiny; an interrupted sale leaves a recoverable open cart on a completed
  visit. A future hardening could move the sequence into a single Postgres RPC.
- **Receipts** for an anonymous (Counter Sale) customer: the Pay receipt picker
  already supports "No receipt" and a typed recipient; attaching a real customer
  prefills theirs.
