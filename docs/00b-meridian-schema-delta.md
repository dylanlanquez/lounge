# 00b. Meridian schema delta vs PATIENTS.md

**Audit date:** 27 Apr 2026
**Source:** `~/Desktop/meridian-app/supabase/migrations/` (45+ migration files), `~/Desktop/meridian-app/src/`, `~/Desktop/meridian-app/PATIENTS.md`
**Outcome:** PATIENTS.md is materially correct. Drift is cosmetic only. The receptionist role does not exist yet and must be added before Phase 1.

---

## 1. Summary

| Item | Status |
|---|---|
| `public.patients` columns (31) | All present, sourced from migrations |
| `public.patients` indexes (7) | All present |
| `public.patients` triggers (3) | All present |
| Helpers (`is_admin`, `auth_account_id`, `auth_location_id`, `generate_patient_reference`, `touch_updated_at`) | All present |
| Patient-axis tables (`patient_files`, `patient_pinned_versions`, `patient_events`, `file_labels`, `customer_notes`, `customer_preview_presets`, `customer_push_tokens`, `smile_designs`) | All present |
| Storage buckets (`case-files` private, `briefings` public) | Both present |
| Edge functions referenced (`shopify-orders-webhook`, `checkpoint-walkin-identities`, `portal-page`) | All present |
| `lng_` namespace collisions | **Zero.** Safe to claim. |

---

## 2. Column verification (sourced)

| Column | Source migration |
|---|---|
| `id`, `account_id`, `first_name`, `last_name`, `date_of_birth`, `email`, `phone`, `notes`, `created_at`, `updated_at` | `20260411_10_meridian_cases.sql` |
| `address`, `allergies`, `communication_preferences`, `shopify_customer_id` | `20260411_11` |
| `location_id` | `20260413_01` |
| `sex`, `lwo_contact_id`, `referred_by`, `insurance`, `registered_at`, `internal_ref` | `20260419_04` |
| `portal_ship_name`, `portal_ship_line1`, `portal_ship_line2`, `portal_ship_city`, `portal_ship_postcode`, `portal_ship_country_code`, `portal_ship_updated_at`, `portal_access` | `20260420_02` |
| `portal_ship_company`, `portal_ship_province` | `20260421_03` |
| `avatar_data` | `20260421_04` |
| `lwo_ref` | `20260422_03` |

---

## 3. Index verification

| Index in PATIENTS.md | In migrations | Notes |
|---|---|---|
| `patients_account_idx` | ✓ `20260411_10:172` | Legacy; new code reads `location_id`. |
| `patients_location_idx` | ✓ `20260413_01:213` | Live scope. |
| `patients_name_search_idx` | ✓ `20260411_10:173` | Lowercased last/first. |
| `patients_shopify_customer_id_unique` | ✓ `20260411_11:104-105` | Partial unique. |
| `patients_lwo_ref_unique` | ✓ `20260422_03:21-23` | Partial unique. |
| `patients_internal_ref_unique` | ✓ `20260419_04:115` | Hard unique. |
| `patients_email_per_location_ci` | ⚠ Named `patients_email_per_location_unique` in migration `20260423_01:88-90`. Functionally identical (uses `lower(email)` and `location_id`). | **Cosmetic drift only.** |

---

## 4. Trigger verification

| Trigger | Source | Notes |
|---|---|---|
| `patients_set_internal_ref_trg` | `20260419_04:127-145` | BEFORE INSERT, calls `generate_patient_reference()`; backfills `registered_at`. |
| `patients_lowercase_email` | `20260423_01:95-113` | BEFORE INSERT/UPDATE; lowercases, trims, converts empty string to null. |
| `patients_set_updated_at` | `20260411_10:175-178` | BEFORE UPDATE; calls shared `touch_updated_at()`. |

---

## 5. Helper functions

| Helper | Source | Behaviour |
|---|---|---|
| `generate_patient_reference()` | `20260419_04:56-73`, redefined `20260422_02` for `MP-` prefix | Reads `patient_sequences` (single-row `id=1`), atomically increments, returns `MP-NNNNN`. |
| `is_admin()` | `20260411_10`, redefined `20260413_03:27-39` | `accounts.member_type = 'admin' AND status = 'active'` against `auth.uid()`. |
| `auth_account_id()` | `20260411_10:469-479` | Returns `accounts.id` for `auth.uid()`. |
| `auth_location_id()` | `20260413_01:17-27` | Returns the denormalised `accounts.location_id` for `auth.uid()`. |
| `touch_updated_at()` | `20260411_08:112-117` | Shared trigger function. Reused on every `*_set_updated_at` trigger across the schema. |

---

## 6. Auth and roles (per §2.8)

### User table

`public.accounts` is the canonical user record. Linked to Supabase Auth via `auth_user_id` (nullable, `ON DELETE SET NULL`).

Key columns:

- `login_email` — globally unique per `20260422_18`.
- `account_type` enum: `internal | cad | lab | dental_practice | dentist | admin`.
- `internal_sub_type` enum (when `account_type = 'internal'`): `lab_staff | customer_service`.
- `member_type` enum (defined `20260413_01`): `admin | cad_team_member | practice_team_member | lab_team_member | independent_dentist`.
- `location_id` — denormalised from `location_members`, kept in sync by trigger `sync_account_location_id()` (`20260413_01:231-250`).
- `status` — active / inactive.

### Location-scoped roles (`location_members`)

Two role enums per location:

- `practice_role`: `dentist | practice_admin | practice_staff | practice_viewer`
- `lab_role`: `lab_admin | lab_manager | lab_technician | cad_designer`

Plus boolean override flags: `can_submit_cases`, `view_cases_only`, `can_approve_cad`, `access_invoices`, `messaging_access`.

### Sign-in flow

- Supabase Auth, email + password (HS256 JWT).
- Magic link is available (Supabase native) but not configured.
- The portal uses a separate Shopify App Proxy + signed session cookie (15-minute TTL).

### **The receptionist role does not exist yet.**

There is no `receptionist` role anywhere in the enums. To add one before Phase 1, the safest shape is:

1. Add `receptionist` to `lab_role` enum (the Motherwell lab is a `lab` location). Migration template:
   ```sql
   ALTER TYPE lab_role_enum ADD VALUE 'receptionist';
   ```
2. Decide which boolean override flags receptionists carry:
   - `messaging_access`: **true** (they need to read/write patient comms).
   - `can_submit_cases`: **false** (they don't submit CAD cases).
   - `view_cases_only`: **false**.
   - `can_approve_cad`: **false**.
   - `access_invoices`: **true** (for refunds and reconciliation).
3. RLS policies on `lng_*` tables key off `auth_location_id()` for visibility, plus a new helper `auth_is_receptionist()` for action gating.

Confirm in Phase 1 plan; do not migrate yet.

---

## 7. `lng_` namespace check

```
$ grep -ri "lng_" /Users/dylan/Desktop/meridian-app/
(zero results in .sql, .ts, .tsx, .js, .jsx)
```

The namespace is clean. We can introduce `lng_appointments`, `lng_walk_ins`, `lng_visits`, etc. without collision.

---

## 8. Helpers we will reuse, not reinvent

- **`touch_updated_at()`** — every `lng_*` table with `updated_at` reuses this trigger function.
- **Avatar resolver** — `~/Desktop/meridian-app/src/lib/avatarPresets.js`. Same data shape (`null`, `preset:<cat>:<seed>`, `logo:<url>`, `data:image/...`) on Lounge tablets.
- **`fileNaming.js`** — `resolveStoragePath()` reads templates from `mrd_app_settings`. Lounge consent forms and intake photos go into the same `case-files` bucket using the same template engine.
- **`patient_events`** — Lounge writes patient-axis events here (`event_type = 'visit_arrived'`, `'payment_taken'`, etc.). Inline insert is the established pattern. No central helper today; we should add `record_patient_event()` early as a thin wrapper for type-safety, but that is a polish task, not a blocker.
- **`generate_patient_reference()`** — model `generate_lwo_ref()` on this. Same `lng_lwo_sequences` pattern with single `id = 1` row.

---

## 9. Migration numbering convention to adopt

Pattern: `YYYYMMDD_NN_snake_case_description.sql`, where `_NN` is a 2-digit sequential counter per day. Example: `20260427_16` is the 16th migration shipped on 27 Apr 2026.

10 most recent migrations on the project (showing pace of change — verify drift before any production deploy):

```
20260427_16_meridian_search_patient_rollup.sql
20260427_15_reconcile_new_events_and_resweep.sql
20260427_14_kit_lifecycle_pending_review.sql
20260427_13_staff_upload_resolves_kit.sql
20260427_12_production_archive_reconcile.sql
20260427_11_pause_reason_key.sql
20260427_10_move_rename_pin_and_reversion.sql
20260427_09_move_auto_promote_source.sql
20260427_08_customer_label_descriptions_v2.sql
20260427_07_customer_label_descriptions.sql
```

Lounge migrations sit alongside these in `~/Desktop/lounge-app/supabase/migrations/`. Coordinate filenames so we do not collide with Meridian on the same day.

---

## 10. Risks raised by this audit

| # | Risk | Severity | Action |
|---|---|---|---|
| M1 | `accounts.account_id ON DELETE CASCADE` on `patients` (PATIENTS.md §10.8) — a hard-deleted staff row cascades patient deletes. | High | Soft-delete only; we never hard-delete in production. Document in `02-data-protection.md` and in onboarding. |
| M2 | `patients.email` is per-location unique, not global. A query that joins across locations on email will produce false matches. | Medium | All Lounge identity-resolution code (per §6.1 of the brief) must scope by `location_id`. Add automated test. |
| M3 | Receptionist role missing — Phase 1 is blocked until added. | Medium | Add migration in Phase 1 slice 1 (Receptionist sign-in), not retroactively. |
| M4 | Index name drift `_ci` vs `_unique` is cosmetic but anyone grepping by name will miss it. | Low | Update PATIENTS.md inline. Ask user. |
| M5 | Project ships fast — 16 migrations on 27 Apr 2026 alone. Lounge migrations must always rebase against latest before push. | High | Migration coordination ritual: read latest Meridian migration timestamp before adding any Lounge migration. |

---

*End of 00b. Verify any column or function reference against the latest migration before relying on it for production code.*
