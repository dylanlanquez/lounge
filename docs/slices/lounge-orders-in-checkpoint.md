# Lounge orders in Checkpoint

**Status:** planned, awaiting build sign-off
**Requested by:** UK team + Customer Services, Sep 2026
**Decision:** federate via direct RLS-gated reads. No mirror, no cross-app secret, no new edge functions. Full order record. Checkpoint is the destination surface.

**Revision note:** an earlier draft of this slice proposed a pair of new edge
functions bridged by `CROSS_APP_SECRET`. That was over-built. Checkpoint
already holds a live client pointed at the Lounge project
(`src/lib/loungeSupabase.js`), and Customer Services agents already have Lounge
logins, so the correct mechanism is a real Lounge session plus RLS. The edge
function layer, the shared secret and the bundle contract are all dropped.

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
second implementation of that arithmetic will drift from it. Checkpoint reads
the view; it never recomputes money.

Mirroring also puts a second copy of patient PII across a project boundary,
widening the DSAR and retention surface that `docs/02-data-protection.md §8`
has to answer for, with no offsetting benefit: a mirrored walk-in still needs
new search plumbing in Checkpoint, so the mirror adds sync cost without
removing any work.

The existing `shipping_queue` cross-post stays as a mirror, correctly. It is a
write-once terminal work queue, not a record of truth.

---

## 2. Mechanism: the channel already exists

`src/lib/loungeSupabase.js` in Checkpoint is a second Supabase client pointed
at the Lounge project, already in production use by
`src/components/PatientAppointments/PatientAppointmentsCard.jsx` and the
in-ScanView appointment booker. Nothing new is needed to reach Lounge.

Today that client is **anon-only and session-less** (`persistSession: false`,
`storageKey: 'lounge-anon'`), which is right for what it does now: the
widget-facing surface that the public embed also reads, granted deliberately
by the `lng_widget_*` migrations.

That anon path cannot carry orders, and must not be made to. `lng_payments`
has exactly two policies, both `TO authenticated`
(`20260428000017_lng_rls_policies.sql:221`): `is_admin()`, or
`auth_is_receptionist()` scoped to `auth_location_id()`. `lng_carts` and
`lng_cart_items` have the same shape. The anon role has no policy on any of
them, so RLS denies it outright.

**Granting anon SELECT on the order tables is the one move to refuse.** That
key ships in the public booking embed on venneir.com and
denture-services.co.uk, so it would publish every customer's payment record,
card last-4 and refund history to anyone who views source.

The answer is a real Lounge session, not a wider anon grant.

---

## 3. Auth model

CS agents already have Lounge logins. A Lounge login means three rows on the
`npuvhxakffxqoszytkxw` project: an `auth.users` row, an `accounts` row
(`accounts.auth_user_id = auth.uid()`, shared with Meridian), and an
`lng_staff_members` row FK'd to `accounts.id` with
`is_customer_service = true`.

So the flow is simply:

1. The staff member signs in to Lounge **once** from inside Checkpoint. The
   session persists; `autoRefreshToken` keeps it alive.
2. Checkpoint queries the Lounge order tables directly through
   `loungeSupabase`, as that authenticated user.
3. Lounge RLS decides what they can see. No secret, no proxy, no service role
   anywhere in the path.

### Changes to `loungeSupabase.js`

`persistSession` flips to `true` and `autoRefreshToken` to `true`, under a new
`storageKey` (`lounge-staff`). The existing anon client stays as-is under
`lounge-anon` for the booker and availability reads, which must keep working
for staff who have no Lounge account. Two clients, two purposes.

### The sign-in surface

A "Connect your Lounge account" panel on the order page, shown when no Lounge
session is held. Email and password against Lounge, then the TOTP challenge
when the account has `require_2fa` set. One-time per browser; re-prompted on
session expiry with the order the agent was trying to open preserved.

### 2FA, and why the new policies require aal2

Lounge enforces 2FA **client-side only**: `src/App.tsx:174` checks
`account.require_2fa && mfa.aal !== 'aal2'` and blocks the UI. RLS does not
look at AAL. So a plain password sign-in from Checkpoint yields an `aal1`
session that Lounge's own interface would refuse, while RLS would happily
serve payment data to it.

That would make the bar for reading card and refund data from Checkpoint
**lower** than from Lounge itself. The new CS policies therefore require
`aal2` at the data layer:

```
(auth.jwt() ->> 'aal') = 'aal2'
```

This is deliberately stricter than the existing receptionist policies, which
inherit only the client-side gate. It is enforced where it cannot be bypassed,
and it means the Checkpoint sign-in flow must complete the TOTP step for any
CS account with `require_2fa`. Accounts without `require_2fa` are unaffected.

---

## 4. Scope lock

### Lounge repo

- **New migration** `YYYYMMDD_NN_lng_customer_service_order_read.sql`:
  - `auth_is_customer_service()` helper, mirroring `auth_is_receptionist()`
    (`20260428000004`) but joining `lng_staff_members` on
    `is_customer_service = true` and `status = 'active'`.
  - CS SELECT policies on `lng_visits`, `lng_carts`, `lng_cart_items`,
    `lng_cart_item_upgrades`, `lng_cart_discounts`, `lng_payments`,
    `lng_payment_refunds`, `lng_walk_ins`, `lng_appointments`.
  - Each policy is `TO authenticated`, requires `auth_is_customer_service()`
    **and** `aal2`, and is **cross-location** (no `auth_location_id()` filter).
    CS serves every clinic, which is exactly why the receptionist policies
    cannot be reused.
  - SELECT only. No INSERT, UPDATE or DELETE for this role on any table.
  - Verify `lng_visit_paid_status` is readable under the new policies. Views
    run with the definer's rights by default, so confirm rather than assume.
- **Modify** `supabase/functions/book-lng-shipment/index.ts` for the
  `order_name` fix, see §6.

Migration ritual per `CLAUDE.md`: read the latest filename in
`~/Desktop/meridian-app/supabase/migrations/` first, then shadow
(`vkgghplhykavklevfhkz`) before Meridian, via the session pooler.

### Checkpoint repo

- **Modify** `src/lib/loungeSupabase.js` to add the session-holding staff client.
- **New** `src/components/LoungeOrderView.jsx`, the read-only order page.
- **New** `src/lib/loungeOrderQueries.js`, the reads against `loungeSupabase`.
- **New** `src/lib/printLoungeLwo.js`, LWO reprint ported from Lounge's `printLwo.ts`.
- **Modify** `src/lib/useGlobalSearch.js` to add the `lounge_order` source and result kind.
- **Modify** `src/components/SidebarSearch.jsx` to render and route the new result kind.
- **Modify** `src/pages/Dashboard.jsx` for a `PATH_TO_VIEW` entry plus a branch
  in the `activeView` switch (~line 2530), gated on a new `lounge_orders`
  permission.

### Explicit exclusions

- **Do not grant anon any policy on the order tables.** See §2.
- **Do not touch `ScanView.jsx`.** It is order-centric: every panel hangs off a
  Shopify `order` object. A Lounge walk-in has no Shopify order and cannot
  mount inside it. The file is over 10,000 lines and is not the right home.
- **Do not add a service role key for the Lounge project to Checkpoint.** It
  would bypass all RLS on the whole Meridian and Lounge project, not just
  orders. The whole point of this design is that RLS stays in the path.
- Do not touch `order_arch_slots`, `check_ins`, `check_outs`, or the SLA
  engine. A Lounge order is not a lab order and must not enter the lab SLA
  pipeline.
- Do not change the existing receptionist or admin policies.
- Do not write to Lounge from Checkpoint. This surface is read-only in v1.
- No new Lounge tables.

---

## 5. Checkpoint UI

A new left-nav destination under Dispatch, and a standalone page at
`/lounge-order/:ref`. Read-only throughout: no editable field, no save button.

Sections, top to bottom:

1. **Header.** Patient name, LAP ref, date, status pill, JB ref when set. Two
   actions: Print LWO, Print shipping label. The label button is present only
   when the visit carries `label_data`.
2. **Items.** The cart as the customer bought it, with arch, shade, thickness
   and upgrades. Prices right-aligned.
3. **Payment.** Amount due, paid and balance, all read from
   `lng_visit_paid_status`. Each payment with method, card brand and last-4,
   who took it and when. Refunds beneath, with reason and approver.
4. **Dispatch.** Tracking number linked to `track.dpdlocal.co.uk` via
   `parcel_code`, dispatched by and when, and the address as it was at
   dispatch. Hidden entirely for collected orders rather than shown empty.
5. **Origin notice.** One line: "This order was taken in Lounge. It is shown
   here read only." Plain full stop, no dashes, per the UI text rule.

Styling: inline styles only, tokens from `src/lib/loungeTheme.js` (`LNG`),
Lucide icons only, single accent from the admin theme.

States, all explicit: loading; loaded; no Lounge session (the connect panel);
session expired; ref not found; and RLS denial. An RLS denial returns zero rows
rather than an error, so it must be distinguished from "not found" by checking
session presence first, and it renders as "Your Lounge account does not have
access to orders" rather than a misleading empty state. No `value || 'default'`
anywhere in the assembly, per the no-silent-fallbacks rule.

### Search

`useGlobalSearch.js` gains a ninth source. Every existing source resolves to a
Shopify order row, so the hook needs a second result kind rather than another
Shopify bucket:

- Skip the Lounge lookup entirely when the query matches `ORDER_NAME_RE` or
  `REF_RE`, which are Shopify and lab shapes.
- Skip it when no Lounge session is held, rather than firing a query that RLS
  will empty.
- Run it for free text, postcodes, LAP refs and tracking numbers.
- Return `{ kind: 'lounge_order', ref, customer_name, total_price, created_at,
  status, match_field, match_value }`.
- `SidebarSearch.jsx` renders these under a "Lounge" group heading with a
  distinct match chip, and routes to `/lounge-order/:ref` rather than the order
  loader.

The 150ms debounce, `AbortController` and `reqId` staleness guards apply
unchanged. If the added cross-project round trip proves slow, the fix is a
400ms debounce on the Lounge bucket alone, not a mirror.

---

## 6. The `order_name` fix

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

## 7. Data protection

- No new copy of personal data is created, and nothing from Lounge is persisted
  on the Checkpoint side, including in `localStorage`. The only thing stored is
  the Supabase session token under `lounge-staff`.
- Access is gated twice: the `lounge_orders` permission in Checkpoint controls
  whether the page and search source exist for that user, and Lounge RLS
  controls what the data layer will actually return. The second is the one that
  matters; the first is UI tidiness.
- Because the reads run as the individual staff member rather than as a service
  role, Lounge's own audit trail attributes them correctly. This is a real
  advantage over the edge function design, where every read would have appeared
  as the same service identity.
- The recipients section of `docs/02-data-protection.md §2` needs a line:
  Checkpoint staff (UK team, Customer Services) are recipients of Lounge order
  data for after-sales support. Lawful basis Article 6(1)(f), legitimate
  interest in servicing a purchase the customer made.
- Each order view writes a `patient_events` row (`event_type =
  'order_viewed_checkpoint'`) so a DSAR can answer who looked at the record and
  when. Patient-axis event, so `patient_events` is correct, not `lng_event_log`.
  This needs a CS INSERT policy on `patient_events` scoped to that event type
  only; check `20260518000013_lng_patient_events_staff_select.sql` first, which
  already widened the SELECT side for CS-only accounts.
- Retention is unchanged: the record lives only in Lounge and inherits the
  periods documented in §6 of the data protection doc.

---

## 8. Implementation steps

Each step is independently verifiable.

1. Read the latest Meridian migration filename. Write the CS RLS migration.
   Apply to shadow via the session pooler and verify there, per
   `docs/runbooks/migration-workflow.md`.
2. On shadow, prove the policies with three sessions: a CS account at aal2 sees
   orders across every location; the same account at aal1 sees nothing; a
   Meridian-only account with no `lng_staff_members` row sees nothing. Confirm
   `lng_visit_paid_status` returns rows for the CS session.
3. Apply to Meridian. Re-run the same three checks against production.
4. Add the session-holding client to `loungeSupabase.js`. Verify the existing
   anon booker still works unchanged for a staff member with no Lounge account.
5. Build the connect panel. Verify a full sign-in including TOTP on an account
   with `require_2fa`, and that the session survives a page reload.
6. Build `LoungeOrderView.jsx` against a real ref. Verify all six states from
   §5, including a collected order with no dispatch section.
7. Cross-check the money block against what Lounge's own VisitDetail shows for
   the same visit. They must agree to the penny, including on a visit with a
   partial refund.
8. Port `printLoungeLwo.js`. Print one from each app for the same visit and
   compare the two slips physically.
9. Wire label reprint from the stored ZPL, reusing `ShippingQueueView`'s 4x4
   print CSS per `LABEL-PRINT-REFERENCE.md`. Confirm the 28-digit barcode is
   not cropped and scans.
10. Add the search source and the `SidebarSearch` result kind. Verify a walk-in
    is findable by surname, postcode, LAP ref and tracking number, that typing
    `VEN12345` runs no Lounge query, and that no query fires without a session.
11. Add the `lounge_orders` permission and grant it to CS and the UK team.
12. Fix `order_name` in `book-lng-shipment`. Ship one live dispatch and confirm
    the `shipping_queue` row carries the LAP ref.
13. Playwright E2E per the Lounge testing convention. Type-check and lint both
    repos before commit.
14. Update `docs/02-data-protection.md §2` recipients.

---

## 9. Smoke test, in plain English

A customer walked into Motherwell three weeks ago, paid £199 by card for a
denture repair, had it posted to them, and has now emailed Customer Services to
say it arrived cracked.

The CS agent types the customer's surname into Checkpoint's sidebar search. A
result appears under a Lounge heading. They click it and land on the order page.
The first time they do this they are asked to sign in to Lounge, with their
existing Lounge details and their authenticator code. After that it just opens.

They can see the repair that was bought, that £199 was taken on a Visa ending
4242 by Sarah at 14:32 on the day, that it was posted DPD with a tracking
number that links through to DPD, and the address it went to. They tell the
customer what they bought and when it shipped without leaving Checkpoint or
phoning Motherwell.

The UK team then opens the same page and prints the LWO so the repair can be
booked back in, and reprints the shipping label to send the replacement out.
Both slips come out of the same printer, looking the same as the ones the clinic
printed on the day.

Nobody can change anything on that page from Checkpoint. The next morning,
after Motherwell refunds the customer in Lounge, the CS agent refreshes and the
refund is already showing, because Checkpoint never had its own copy.

A member of the lab team who has no Lounge account types the same surname and
sees no Lounge results at all.

---

## 10. Done when

- A Lounge walk-in order is findable in Checkpoint search by surname, postcode,
  LAP ref and tracking number, for a signed-in CS or UK team member.
- A staff member with no Lounge account, or holding only an aal1 session, sees
  nothing, and the existing anon booker still works for them.
- The order page shows items, prices, discounts, payments with card brand and
  last-4, refunds, and dispatch, matching Lounge to the penny including after a
  partial refund.
- LWO reprints from Checkpoint and is physically identical to Lounge's.
- Shipping label reprints from stored ZPL with a scannable barcode and no DPD
  call.
- Collected orders render with no dispatch section and no label button.
- RLS denial and not-found render as distinct, honest states.
- Every order view writes a `patient_events` row attributed to the individual
  staff member.
- The CS role holds no write policy on any `lng_` table.
- Type-check and lint pass in both repos. Playwright E2E green.
- Scored 90 or above on all eight brief axes.

---

## 11. Open risks

| # | Risk | Mitigation |
|---|---|---|
| L1 | Two logins for one person. A CS agent signs in to Checkpoint and then again to Lounge. | Once per browser, session persisted and auto-refreshed. Genuine single sign-on across two Supabase projects is a v1.5 question and should not gate this. |
| L2 | The `aal2` requirement is stricter than Lounge's own receptionist policies, so behaviour differs by role. | Deliberate, and documented in §3. The inconsistency to fix is that receptionist policies do not require it, not that these do. Worth raising as separate work. |
| L3 | A CS account is deactivated in Lounge but keeps a live session token. | `auth_is_customer_service()` requires `status = 'active'`, evaluated per query, so deactivation takes effect on the next read rather than at token expiry. |
| L4 | Search adds a cross-project round trip per keystroke burst. | Shape-gated so Shopify and lab queries skip it, and session-gated so it never fires unauthenticated. Debounce the Lounge bucket to 400ms if measured latency is poor. |
| L5 | LWO reprint drifts from Lounge's as `printLwo.ts` changes. | Same lockstep note `LWO-PRINT-REFERENCE.md` already carries for its three render paths. Add Checkpoint's port to that list. |
| L6 | `meridian-patient-bundle` has no caller authentication and is reachable with the public anon key, exposing patient profiles and file lists. | Out of scope here. Tracked separately; the fix is the `checkpoint-jb-check` auth model. Not made worse by this slice, which adds no new unauthenticated surface. |
| L7 | A future writeback request ("let CS refund from Checkpoint"). | Explicitly out of scope. Refunds stay in Lounge where the Stripe keys and the approval ceiling triggers live. The CS role holds SELECT only, so this cannot happen by accident. |
