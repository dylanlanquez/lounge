# Slice — Cart-aware suggestion carousel + per-product suggestion admin

**Status:** Built, shadow-verified, awaiting production rollout
**Phase:** Cross-cutting (catalogue picker)
**Migrations (this slice):** `20260611000006_lng_catalogue_suggestions.sql`

The catalogue picker's "Suggested for this booking" section used to show a
fixed, intake-derived list and rendered the same `ProductRow` accordion as
the grouped lists below. That caused a bug (tapping a suggested item also
expanded its duplicate row in the list and scrolled the sheet to it) and
gave no admin control. This slice:

1. Drives suggestions from the **basket** — admin-configured companions for
   each item in the basket, or every active row when the basket is empty.
2. Renders suggestions as a **swipable card carousel** with an inline
   configurator that opens beneath the cards (no jump to the list, no
   duplicate expansion).
3. Adds a per-product **Suggested companions** editor in Admin (Products +
   Services), mirroring the per-product Upgrades editor.

**Touched files:**
- `supabase/migrations/20260611000006_lng_catalogue_suggestions.sql` — self-referential `trigger -> suggested` table (RLS off + default DML grants, mirroring `lng_catalogue_upgrades`)
- `src/lib/queries/suggestions.ts` — `useAllSuggestions` / `useSuggestionsForCatalogue`, `addSuggestion`/`removeSuggestion`/`reorderSuggestions`, and the pure `resolveCartSuggestions` resolver
- `src/lib/queries/suggestions.test.ts` — resolver unit tests (empty basket, ordering, dedupe, exclude-in-basket, drop-inactive)
- `src/components/CataloguePicker/CataloguePicker.tsx` — extracted `LineConfigurator`; new `SuggestionSection` / `SuggestionCarousel` / `SuggestionCard` / `SuggestionConfigurator`; independent `activeSuggestedId` state; dropped the dead intake-matching helpers
- `src/routes/VisitDetail.tsx`, `src/routes/Arrival.tsx` — pass `cartCatalogueIds` (cart lines / staged items) into the picker
- `src/routes/Admin.tsx` — `SuggestedCompanionsEditor` inside `CatalogueRowEditor`

---

## 1. User story

> As an admin, I decide which products the picker suggests alongside each
> item. When a receptionist has a retainer in the basket, I want the picker
> to offer a retainer case and cleaning tablets. As a receptionist, the
> suggestions are big swipable cards; tapping a simple product adds it
> straight to the bag, tapping one with options opens a configurator right
> under the cards. Nothing scrolls away and nothing double-opens.

---

## 2. The model

- `lng_catalogue_suggestions(trigger_catalogue_id, suggested_catalogue_id, sort_order)` — both FKs to `lwo_catalogue`, `ON DELETE CASCADE`.
- A `no_self` check stops a product suggesting itself; a unique `(trigger, suggested)` pair makes re-adding an upsert, not a duplicate.
- The picker resolves the live basket against the rules (`resolveCartSuggestions`):
  - **Empty basket** → every active catalogue row (the brief's "show them all").
  - **Non-empty** → the union of each basket item's companions, walked in basket order then per-trigger `sort_order`, deduped, with basket items and inactive/missing rows filtered out. Empty union → the carousel is hidden (the grouped lists below still let staff browse).
- Access mirrors `lng_catalogue_upgrades`: RLS off, Supabase default privileges grant anon/authenticated full DML (admin writes directly, same as the upgrades editor beside it).

---

## 3. Smoke test (plain English)

1. Admin → **Products** (or **Services**), edit a product, scroll to **Suggested companions**. Tap **Add companion**, pick a product from the dropdown — it appears in the list. Add a second; reorder with the up/down arrows; remove one with the trash icon.
2. On a visit, open the picker with an **empty** basket → the "Suggested for this booking" row shows every active product as swipable cards; the row swipes with edge fades hinting more.
3. Add the trigger product to the bag, reopen the picker → the carousel now shows only that product's configured companions, and the trigger product itself is not offered.
4. Tap a **simple** suggested card (no arch/shade/upgrades/qty) → it adds straight to the bag, toast "Added to bag", picker closes.
5. Tap a **configurable** suggested card → a configurator slides open **beneath the cards** (not in the list below); the sheet does **not** scroll away, and the duplicate row further down does **not** expand. Set options, **Add to bag**.
6. Open a row in the grouped list below → any open suggestion configurator closes (one configurator at a time across the sheet), and vice versa.
7. Same flow works in the arrival wizard (suggestions driven by staged items, before a cart exists).
8. Deactivate a suggested companion in Admin → it drops out of the carousel but stays listed (greyed, "Inactive") in the editor.

---

## 4. Shadow verification done

- Migration applies cleanly. `relrowsecurity = f`; anon + authenticated have full DML (matches `lng_catalogue_upgrades`).
- Constraints present: `pkey`, `pair_uniq`, `no_self`, both FKs. A self-referential insert is rejected by `no_self`.
- `resolveCartSuggestions` unit tests pass (7 cases): empty-basket passthrough, per-trigger sort order, exclude-in-basket, dedupe across triggers, drop-inactive, basket-order precedence, empty-when-unconfigured.
- `tsc -b --noEmit` clean; no new lint problems in touched files; existing `catalogueMatch` tests still pass.

---

## 5. Production rollout (pending approval)

1. `psql "$LNG_MERIDIAN_DB_URL" -f supabase/migrations/20260611000006_lng_catalogue_suggestions.sql`
2. Commit + push frontend (Vercel production deploy).

No edge-function redeploy needed — suggestions are read/written client-side via the anon/authenticated DML grants. The table is empty on first deploy, so until an admin configures companions the carousel simply shows all products when the basket is empty and hides itself when the basket has items with no companions yet.
