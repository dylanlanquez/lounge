# Lounge orders in Checkpoint

**Status:** planned, awaiting build sign-off
**Requested by:** UK team + Customer Services, Sep 2026
**Decision:** federate (read live from Lounge), do not mirror. Full order record. Checkpoint is the destination surface.

---

## 1. Context

A walk-in customer pays in Lounge, receives their product, then contacts
Customer Services with a problem. CS works in Checkpoint and cannot see the
order, because the order lives in Lounge on the Meridian Supabase project
(`npuvhxakffxqoszytkxw`) and Checkpoint runs on its own project
(`emonsrrhflmwfsuupibj`). The UK team hits the same wall when they need to
reprint an LWO or a shipping label.

### What is already true (verified, Sep 2026)

Three of the four premises in the original request needed correcting.

| Claim | Reality |
|---|---|
| "The order isn't in Checkpoint at all" | Partly false. `book-lng-shipment/index.ts:267` already inserts a `shipping_queue` row into Checkpoint for every **shipped** visit, carrying `order_name`, `customer_name`, `postcode`, `dispatched_products`, `label_data`, `tracking_number`. Collected visits never reach Checkpoint. |
| "We can't print a shipping label" | False for shipped visits. `book-lng-shipment` books DPD through Checkpoint's `book-dpd-shipment` proxy (Checkpoint holds the DPD IP allowlist), stores ZPL on `lng_visits.label_data`, and writes it to `shipping_queue.label_data` where `ShippingQueueView` can reprint it. True only for collected visits, which have no label by definition. |
| "We can't print an LWO" | False at the clinic. `src/lib/printLwo.ts` is a direct port of Checkpoint's `printWalkInLwo`: same 4.13in thermal layout, same printer, same barcode. What Checkpoint cannot do is **reprint**, because its reprint paths key off `order_arch_slots` and Shopify orders. |
| "CS can't see the order" | True, and structural. `src/lib/useGlobalSearch.js` fans out across eight sources and every one resolves to a Shopify order row. A Lounge walk-in has no Shopify order, so it is unfindable by construction. Checkpoint also has no walk-in UI left after cutover; only `ShippingQueueView` survives. |

### Why federate rather than mirror

A Lounge order keeps changing after the sale: refunds
(`lng_payment_refunds`), discounts (`lng_cart_discounts`), soft-deleted cart
lines (`lng_cart_items_soft_delete`), balance write-offs
(`lng_balance_writeoffs`), fulfilment method changes. A mirror needs
change-data-capture across roughly ten tables with no foreign key and no
shared transaction, so drift is a matter of when, not if.

The money calculation is the clearest argument. `lng_visit_paid_status` has
taken five corrective migrations, the most recent (`20260519000010`) fixing a
double-subtraction that rendered a £199 cart as £398 after a full refund. Any
second implementation of that arithmetic in a mirror or in a new edge function
will drift from it. The bundle reads the view; it never recomputes money.

Mirroring also puts a second copy of patient PII across a project boundary,
widening the DSAR and retention surface that `docs/02-data-protection.md §8`
has to answer for, with no offsetting benefit: a mirrored walk-in still needs
new search plumbing in Checkpoint, so the mirror adds sync cost without
removing any work.

The codebase has already chosen federation for the Checkpoint to Meridian
direction (`meridian-patient-bundle`, `meridian-cases-for-order`,
`meridian-lab-queue`, `meridian-file-signed-url`). This is the same pattern
pointed at the same project.

The existing `shipping_queue` cross-post stays as a mirror, correctly. It is a
write-once terminal work queue, not a record of truth.

---

## 2. Scope lock

### Lounge repo

- **New** `supabase/functions/lng-order-bundle/index.ts`, the inbound cross-app endpoint.
- **New** `supabase/config.toml` entry for it with `verify_jwt = false` (secret checked manually).
- **Modify** `supabase/functions/book-lng-shipment/index.ts` for the `order_name` fix, see §7.

### Checkpoint repo

- **New** `supabase/functions/lounge-order-bundle/index.ts`, the proxy, mirroring `meridian-patient-bundle`.
- **New** `src/components/LoungeOrderView.jsx`, the read-only order page.
- **New** `src/lib/printLoungeLwo.js`, LWO reprint ported from Lounge's `printLwo.ts`.
- **Modify** `src/lib/useGlobalSearch.js` to add the `lounge_order` source and result kind.
- **Modify** `src/components/SidebarSearch.jsx` to render and route the new result kind.
- **Modify** `src/pages/Dashboard.jsx` for a `PATH_TO_VIEW` entry plus a branch in the `activeView` switch (~line 2530), gated on a new `lounge_orders` permission.

### Explicit exclusions

- **Do not touch `ScanView.jsx`.** It is order-centric: every panel hangs off a
  Shopify `order` object. A Lounge walk-in has no Shopify order and cannot mount
  inside it. The file is over 10,000 lines and is not the right home for this.
- Do not touch `order_arch_slots`, `check_ins`, `check_outs`, or the SLA engine.
  A Lounge order is not a lab order and must not enter the lab SLA pipeline.
- Do not write to Lounge from Checkpoint. This surface is read-only in v1.
- Do not change existing `shipping_queue` cross-post behaviour beyond the `order_name` fix.
- No new Lounge tables. No `lng_` migration is needed for the read path.

---

## 3. Data flow

```
Checkpoint browser (staff, CS or UK team)
   |  anon key Bearer JWT (module-level EDGE_HEADERS)
   v
Checkpoint edge fn  lounge-order-bundle        (project emonsrrhflmwfsuupibj)
   |  verifies the CALLER's JWT + accounts row   <- see §5, this is the important bit
   |  then Bearer CROSS_APP_SECRET
   v
Lounge edge fn      lng-order-bundle            (project npuvhxakffxqoszytkxw)
   |  verify_jwt = false, secret compared manually
   |  service role reads:
   |    lng_visits, lng_walk_ins, lng_appointments,
   |    lng_carts, lng_cart_items, lng_cart_item_upgrades,
   |    lng_cart_discounts, lng_payments, lng_payment_refunds,
   |    lng_visit_paid_status  (money, never recomputed),
   |    patients, accounts
   v
one JSON order bundle, read-only
```

Search takes the same path with a `q` lookup instead of a ref, returning
lightweight rows only (ref, name, date, total, status) with no line items.

---

## 4. The bundle contract

Shaped to answer the two questions CS and the UK team actually ask: "what did
this person buy and what did they pay" and "print it again".

```
{
  ok: true,
  order: {
    ref, kind: 'walk_in' | 'appointment', status,
    opened_at, closed_at, location_name, jb_ref,
    fulfilment_method, service_label, receptionist_name
  },
  patient: {
    internal_ref, first_name, last_name, email, phone,
    date_of_birth, address
  },
  items: [ { qty, name, arch, shade, thickness, category,
             unit_pence, line_total_pence, upgrades: [...] } ],
  money: {
    subtotal_pence, discount_pence, amount_due_pence,
    amount_paid_pence, balance_pence, currency: 'GBP'
  },
  payments: [ { method, journey, amount_pence, status,
                card_brand, last4, taken_at, taken_by } ],
  refunds:  [ { amount_pence, reason_category, status, refunded_at, approved_by } ],
  dispatch: {
    dispatched_at, dispatched_by, tracking_number, parcel_code,
    dispatch_ref, shipping_address, label_data
  } | null,
  lwo: { /* the exact PrintableLwoItem[] + header printLwo.ts already takes */ }
}
```

Rules:

- `money` comes from `lng_visit_paid_status`. The function selects the view; it
  does not sum payments itself.
- Every field is either present with a real value or explicitly `null`. No
  `value || 'default'` anywhere in the assembly, per the no-silent-fallbacks
  rule. A missing patient row is an error response, not an empty name.
- `label_data` is passed through so Checkpoint can reprint without a DPD call.
- Storage URLs are signed on demand if files are ever added to this bundle.
  None are in v1.

---

## 5. Auth model, and a finding worth fixing

`meridian-patient-bundle` performs **no caller authentication**. It is not
listed in Checkpoint's `supabase/config.toml`, so it takes the gateway default
`verify_jwt = true`, which the **public anon key satisfies**. The anon key ships
in the client bundle. Anyone holding it can POST an email address and receive
that patient's profile and file list.

That posture is already live for patient files. It must not be extended to a
full order record carrying payment methods, card last-4, refunds and staff names.

**The new proxy copies `checkpoint-jb-check` instead**, which gets this right
(`supabase/functions/checkpoint-jb-check/index.ts`): it calls
`auth.getUser(userJwt)` on the presented token and then requires a matching
`accounts` row before doing any cross-project work. Concretely:

1. Checkpoint's `lounge-order-bundle` verifies the caller's JWT is a real
   session, resolves the staff row, and checks the `lounge_orders` permission.
   Anon-key-only callers are rejected with 401.
2. Only then does it attach `CROSS_APP_SECRET` and call Lounge.
3. Lounge's `lng-order-bundle` runs `verify_jwt = false` and compares the bearer
   to `CROSS_APP_SECRET`, following `piranha-customer-orders`: 401 on missing,
   403 on mismatch. It trusts the proxy for staff identity and never accepts a
   browser call directly.

Failures are loud: unreachable Lounge or a non-200 from it writes a
`system_logs` row on the Checkpoint side (as `meridian-patient-bundle` does)
and a `lng_system_failures` row on the Lounge side, and the panel renders an
amber notice carrying the ticket id rather than an empty state.

`CROSS_APP_SECRET` already exists on Checkpoint's edge env. It must be added to
Lounge's.

---

## 6. Checkpoint UI

A new left-nav destination under Dispatch, and a standalone page at
`/lounge-order/:ref`. Read-only throughout: no editable field, no save button.

Sections, top to bottom:

1. **Header.** Patient name, LAP ref, date, status pill, JB ref when set. Two
   actions: Print LWO, Print shipping label. The label button is present only
   when `dispatch.label_data` is non-null.
2. **Items.** The cart as the customer bought it, with arch, shade, thickness
   and upgrades. Prices right-aligned.
3. **Payment.** Amount due, paid, balance. Each payment with method, card brand
   and last-4, who took it and when. Refunds listed beneath with reason and
   approver.
4. **Dispatch.** Tracking number linked to `track.dpdlocal.co.uk` via
   `parcel_code`, dispatched by and when, and the address as it was at dispatch.
   Hidden entirely for collected orders rather than shown empty.
5. **Origin notice.** One line: "This order was taken in Lounge. It is shown
   here read only." Plain full stop, no dashes, per the UI text rule.

Styling: inline styles only, tokens from `src/lib/loungeTheme.js` (`LNG`),
Lucide icons only, single accent from the admin theme. Loading, error and
not-found states are all explicit; the amber failure notice carries the
`system_logs` ticket id.

### Search

`useGlobalSearch.js` gains a ninth source. Every existing source resolves to a
Shopify order row, so the hook needs a second result kind rather than another
Shopify bucket:

- Skip the Lounge lookup entirely when the query matches `ORDER_NAME_RE` or
  `REF_RE`, which are Shopify and lab shapes.
- Run it for free text, postcodes, LAP refs and tracking numbers.
- Return `{ kind: 'lounge_order', ref, customer_name, total_price, created_at,
  status, match_field, match_value }`.
- `SidebarSearch.jsx` renders these under a "Lounge" group heading with a
  distinct match chip, and routes to `/lounge-order/:ref` rather than the order
  loader.

The 150ms debounce, `AbortController` and `reqId` staleness guards apply
unchanged. One added cross-project round trip per keystroke burst is acceptable
at that debounce; if it proves slow, the fix is a 400ms debounce on the Lounge
bucket alone, not a mirror.

---

## 7. The `order_name` fix

`book-lng-shipment/index.ts` currently writes:

```
const orderName = lwoRef ? `LWO-${lwoRef}` : dispatch_ref;
```

`patients.lwo_ref` is a **patient**-level immutable reference (guarded by
`patients_guard_lwo_ref`), not a per-order one. Every order that patient ever
places lands in `shipping_queue` under the same `order_name`, so the moment
someone returns a second time the reference is ambiguous, which is exactly the
lookup CS will attempt.

The per-order reference is the LAP ref on `lng_appointments` / `lng_walk_ins`.
Change `order_name` to the LAP ref and keep the patient ref out of the order
identity. Historical rows are left alone; search resolves them by tracking
number and postcode as it does today.

---

## 8. Data protection

- No new copy of personal data is created. This is the reason to prefer
  federation, and it should stay true: nothing from the bundle is persisted on
  the Checkpoint side, including in `localStorage`.
- The recipients section of `docs/02-data-protection.md §2` needs a line:
  Checkpoint staff (UK team, Customer Services) are recipients of Lounge order
  data for after-sales support. Lawful basis Article 6(1)(f), legitimate
  interest in servicing a purchase the customer made.
- Access is gated on the new `lounge_orders` permission, not granted to all
  Checkpoint staff by default.
- Each bundle fetch writes a `patient_events` row on the Lounge side
  (`event_type = 'order_viewed_checkpoint'`) so a DSAR can answer who looked at
  the record and when. Patient-axis event, so `patient_events` is correct here,
  not `lng_event_log`.
- Retention is unchanged: the record lives only in Lounge and inherits the
  periods already documented in §6 of the data protection doc.

---

## 9. Implementation steps

Each step is independently verifiable.

1. Add `CROSS_APP_SECRET` to Lounge's edge env. Confirm it matches Checkpoint's.
2. Write `lng-order-bundle` on Lounge. Add the `config.toml` entry with
   `verify_jwt = false`. Deploy and `curl` it: no bearer gives 401, wrong secret
   gives 403, correct secret with a known LAP ref returns a bundle.
3. Cross-check the returned `money` block against what Lounge's own VisitDetail
   shows for the same visit. They must agree to the penny, including on a visit
   that has a partial refund.
4. Write Checkpoint's `lounge-order-bundle` proxy with the `checkpoint-jb-check`
   auth model. Deploy and verify an anon-key-only call is rejected.
5. Add the `lounge_orders` permission and grant it to CS and the UK team.
6. Build `LoungeOrderView.jsx` against a real ref. Verify all five states:
   loading, loaded, Lounge unreachable, ref not found, and a collected order
   with no dispatch section.
7. Port `printLoungeLwo.js` from Lounge's `printLwo.ts`. Print one from each app
   for the same visit and compare the two slips physically.
8. Wire label reprint from `dispatch.label_data`, reusing `ShippingQueueView`'s
   existing 4x4 print CSS per `LABEL-PRINT-REFERENCE.md`. Confirm the 28-digit
   barcode is not cropped and scans.
9. Add the search source and the `SidebarSearch` result kind. Verify a walk-in
   is findable by surname, by postcode, by LAP ref and by tracking number, and
   that typing `VEN12345` still runs no Lounge query.
10. Fix `order_name` in `book-lng-shipment`. Ship one live dispatch and confirm
    the `shipping_queue` row carries the LAP ref.
11. Playwright E2E per the Lounge testing convention. Type-check and lint both
    repos before commit.
12. Update `docs/02-data-protection.md §2` recipients.

---

## 10. Smoke test, in plain English

A customer walked into Motherwell three weeks ago, paid £199 by card for a
denture repair, had it posted to them, and has now emailed Customer Services to
say it arrived cracked.

The CS agent types the customer's surname into Checkpoint's sidebar search. A
result appears under a Lounge heading. They click it and land on the order page.
They can see the repair that was bought, that £199 was taken on a Visa ending
4242 by Sarah at 14:32 on the day, that it was posted DPD with a tracking number
that links through to DPD, and the address it went to. They tell the customer
what they bought and when it shipped without leaving Checkpoint or phoning
Motherwell.

The UK team then opens the same page and prints the LWO so the repair can be
booked back in, and reprints the shipping label to send the replacement out.
Both slips come out of the same printer, looking the same as the ones the clinic
printed on the day.

Nobody can change anything on that page from Checkpoint. The next morning, after
Motherwell refunds the customer in Lounge, the CS agent refreshes the page and
the refund is already showing, because Checkpoint never had its own copy.

---

## 11. Done when

- A Lounge walk-in order is findable in Checkpoint search by surname, postcode,
  LAP ref and tracking number.
- The order page shows items, prices, discounts, payments with card brand and
  last-4, refunds, and dispatch, matching Lounge to the penny including after a
  partial refund.
- LWO reprints from Checkpoint and is physically identical to Lounge's.
- Shipping label reprints from stored ZPL with a scannable barcode and no DPD call.
- Collected orders render correctly with no dispatch section and no label button.
- An anon-key-only call to either edge function is rejected.
- Lounge unreachable renders an amber notice with a ticket id, and a
  `system_logs` row exists.
- Every view writes a `patient_events` row.
- Type-check and lint pass in both repos. Playwright E2E green.
- Scored 90 or above on all eight brief axes.

---

## 12. Open risks

| # | Risk | Mitigation |
|---|---|---|
| L1 | `CROSS_APP_SECRET` is a single shared secret granting full order read. A leak means full read of Lounge orders. | The caller-JWT check on the Checkpoint side means the secret alone is not enough from a browser. Rotate on any staff offboarding with edge env access. Consider per-app secrets in v1.5. |
| L2 | Lounge down makes the panel unavailable, where a mirror would still show stale data. | Accepted, and stated in the panel copy. Same posture the team already accepts for `meridian-patient-bundle`. Stale money on a refund dispute is worse than absent money. |
| L3 | Search adds a cross-project round trip per keystroke burst. | Shape-gated so Shopify and lab queries skip it. Debounce the Lounge bucket to 400ms if measured latency is poor. |
| L4 | LWO reprint drifts from Lounge's as `printLwo.ts` changes. | Same lockstep note `LWO-PRINT-REFERENCE.md` already carries for its three render paths. Add Checkpoint's port to that list. |
| L5 | `meridian-patient-bundle` remains unauthenticated. | Out of scope here, but it is a real exposure of patient data to anyone with the anon key. Raise separately. |
| L6 | A future writeback request ("let CS refund from Checkpoint"). | Explicitly out of scope. Refunds stay in Lounge where the Stripe keys and the approval ceiling triggers live. |
