# Slice — Before & after / Marketing photo uploads (RLS fix)

**Status:** Built, type-checked + linted, unit tests green. Ready for shadow + Meridian apply.
**Phase:** Cross-cutting (patient files)
**Migrations (this slice):** `20260907000001_lng_marketing_file_labels_seed.sql`

Uploading an **after** photo failed for every non-admin staff member with:

```
Could not upload: new row violates row-level security policy for table "file_labels"
```

The error named the wrong table. `PhotoGallery` hardcodes three label keys
(`before_photo`, `after_photo`, `marketing_content`) and resolved them through
`getOrCreateLabel`, which **inserted a row into `public.file_labels`** whenever
its lookup came back empty. `file_labels` is Meridian's catalogue table, writes
need `is_admin()`, and Lounge staff are not Meridian admins, so the insert was
refused. Of the three keys, only `after_photo` was missing from the catalogue
(see 5.1), so before and marketing photos uploaded fine and the card looked
half-broken rather than dead. The runtime-create fallback turned a missing-seed
problem into an RLS error that named the wrong cause.

Two further bugs came out of it:

- `after_photo` was missing from `LABELS_RENDERED_ELSEWHERE`, because that list
  mirrored the labels that existed and this one never did. The patient files
  grid would have grown a stray "After photo" slot the moment the label landed.
- Suppressing a key from the slot list does not suppress its **files**.
  `buildCards` buckets any file whose label has no slot into a dynamic
  `other_<key>` card, and the patient profile hands the same unfiltered array
  to `BeforeAfterGallery`, `MarketingGallery` **and** the grid. Every
  before/after photo would have rendered twice on the profile. `before_photo`
  and `marketing_content` already exist, so this one has been **live in
  production**, not latent (see 5.2).

**Touched files:**
- `supabase/migrations/20260907000001_lng_marketing_file_labels_seed.sql` — seeds the three labels, `scope = 'patient_file'`, `active = true`, guarded on `where not exists`
- `src/lib/queries/patientFiles.ts` — `getOrCreateLabel` replaced by read-only `getLabelId`; a `42501` on `patient_files` is translated into the scan-cleanup lock message (see 5.3) (checks its own read error, names a missing label, treats a duplicate key as critical, logs all three to `lng_system_failures`); a refused `patient_files` insert now removes the uploaded object from `case-files` and logs the path; the `patient_events` write no longer fails silently
- `src/components/PatientFilesGrid/cards.ts` — new. `deriveSlotDefs` / `buildCards` / `filesForGrid` extracted out of the component so the rules are unit testable. Adds `LABELS_OWNED_BY_GALLERIES` (all three keys) and skips those files in `buildCards`
- `src/components/PatientFilesGrid/PatientFilesGrid.tsx` — imports the extracted model; `useAccountId` logs its RPC error instead of discarding it
- `src/routes/PatientProfile.tsx` — `PatientFilesPanel` counts and renders `filesForGrid(files)`, so the header count matches the cards on screen
- `src/components/index.ts` — exports `filesForGrid`
- `src/components/PhotoGallery/PhotoGallery.tsx` — the `auth_account_id` RPC error is logged instead of discarded (upload still proceeds; `uploaded_by` is nullable)
- `src/components/PatientFilesGrid/cards.test.ts` — new, 10 tests
- `src/lib/queries/patientFiles.test.ts` — new, 15 tests
- `tests/patient-photos.spec.ts` — route-gating smoke

---

## 1. User story

> As a receptionist mid-visit, I tap **Add before** on the Before & after card,
> pick or take a photo, and it appears on the tile. At collection I add the
> after photo the same way. Both show on the patient's profile afterwards, once
> each, and in the Marketing content gallery when that is where I put them.

---

## 2. The model (why the labels belong in a migration)

`file_labels` is catalogue data: a fixed list of what kinds of file a patient
can have. Catalogue data is seeded by migration, applied with the migration
role, and read by the app. Nothing about a receptionist tapping "Add before"
should create a new *category* of file.

The old code inverted that. It treated a missing category as something to
create on demand, from the client, against a table another product owns. Even
had the privilege existed it would have been wrong: the row it wrote carried no
`scope`, so `usePatientFileLabels` (which filters `scope = 'patient_file'`)
could not see it, and the label it created came from a hardcoded display-name
map rather than the catalogue.

`getLabelId` is read-only. A key that is not in `file_labels` is now a
deployment gap, and it says so instead of blaming RLS.

---

## 3. Smoke test (plain English)

Run **after** the migration is on Meridian.

1. Open an in-progress visit. The **Before & after** card shows two dashed
   tiles, **Add before** and **Add after**. The **Marketing content** card
   shows one, **Add photo**.
2. Tap **Add before**, pick an image. The tile fills with the photo. No error
   toast. Do the same for **Add after** and for **Add photo**.
3. Sign in as a **plain staff member**, not an admin, and repeat step 2. This
   is the case that was broken, so it is the case that matters.
4. Open that patient's profile. The **Before & after** gallery shows both
   photos, before first. The **Marketing content** gallery shows the third.
5. On the same profile, scroll to **Patient files**. There is **no** "Before
   photo", "After photo" or "Marketing content" card, and the header count in
   the collapsed title does **not** include those three photos.
6. Open **Marketing > Content**. The appointment appears with its photos
   grouped before, after, marketing.
7. Check `lng_system_failures` for source `patient_files.getLabelId`. A row
   there means a label key the app uses is still missing from the catalogue.
8. Lock path, if you can arrange it: have someone else open a scan cleanup on
   that patient's production case in Meridian, then try to add a photo. The
   error should read "Another team member is part way through a scan cleanup for
   this patient", not a Postgres policy name. Nothing should be left behind in
   `case-files`.

Automated: `tests/patient-photos.spec.ts` confirms `/visit/:id` and
`/patient/:id` are gated behind staff sign-in. The upload itself needs an
authenticated session and bucket write access, so it is the manual smoke above.

---

## 4. Verification done

- `tsc -p tsconfig.app.json --noEmit` clean.
- `eslint` clean on every touched and new file.
- `src/components/PatientFilesGrid/cards.test.ts` 10/10, `src/lib/queries/patientFiles.test.ts` 15/15.
- Unit suite: no new failures against the pre-change baseline.
- Playwright route-gating smoke **not run**: the browsers are not installed on
  this dev box (`npx playwright install`), and the pre-existing
  `tests/quick-sale.spec.ts` fails identically for the same reason, so this
  is an environment gap and not a spec failure. Run it before merge.
- Migration **not yet applied**. Shadow first, per `docs/runbooks/migration-workflow.md`.

---

## 5. Notes / follow-ups
Read against Meridian (project `npuvhxakffxqoszytkxw`) on 7 Sep 2026.

### 5.1 What was actually missing

Only **one** of the three labels. `file_labels` holds 34 rows, 18 at
`scope = 'patient_file'` (sort_order 10 to 900) and 16 at `scope = 'delivery'`
(1010 to 1999). Of the keys the galleries use:

| key | present | scope | sort_order |
|---|---|---|---|
| `before_photo` | yes | `patient_file` | 900 |
| `marketing_content` | yes | `patient_file` | 900 |
| `after_photo` | **no** | | |

So "Add before" and "Add photo" worked. **"Add after" was the only broken
one**, because `after_photo` is the only key `getOrCreateLabel` had to create,
and creating it needs `is_admin()`:

| table | policy | cmd | predicate |
|---|---|---|---|
| `file_labels` | `file_labels_select` | SELECT | `auth.uid() IS NOT NULL` |
| `file_labels` | `file_labels_admin` | ALL | `is_admin()` |
| `patient_events` | `patient_events_insert` | INSERT | `auth.uid() IS NOT NULL` |

Reading the catalogue was never blocked, so the swallowed read error was not
what fired here. The row was simply absent. It fails for every non-admin, not
for one account: an admin pressing "Add after" would have succeeded and created
the row as a side effect, and nobody ever had.

This also explains why `after_photo` was missing from
`LABELS_RENDERED_ELSEWHERE`: that list mirrored the labels that existed, and
`after_photo` never did, so no stray slot ever appeared to notice.

### 5.2 The duplicate-card bug was live, not latent

`before_photo` and `marketing_content` are present and active, so any before or
marketing photo already on file (out of 6,829 `patient_files` rows) has been
rendering **twice** on the patient profile: once in its gallery, once as an
`other_*` card in the grid below, with the header count including both. Fixed
here by `LABELS_OWNED_BY_GALLERIES` plus `filesForGrid`.

### 5.3 Resolved: `can_write_patient_files_now()` is a lock, not a role gate

```sql
not exists (
  select 1
    from public.production_case_scan_cleanups c
    join public.production_cases pc on pc.id = c.production_case_id
   where pc.patient_id = p_patient_id
     and c.completed_at is null
     and c.started_by_account_id is distinct from public.auth_account_id()
)
```

Writes are allowed unless **someone else** has an unfinished scan cleanup open
on one of that patient's production cases. The account that started the cleanup
can still write; everyone else is locked out until `completed_at` is stamped.
`patient_files_update` carries the same gate, `patient_files_delete` does not.

So the ordinary case passes and Lisa's upload will work. The exception is
narrow but real, and Lounge has no view of Meridian's cleanup queue, so before
this slice it would have surfaced as a bare
`new row violates row-level security policy for table "patient_files"` with no
cause and no recourse. That is the same unhelpful shape as the original bug, one
table over.

`uploadPatientFile` now probes for the lock on any `42501` from `patient_files`
and raises:

> Another team member is part way through a scan cleanup for this patient.
> Photos cannot be added until they have finished it.

The probe reads `production_cases` (Lounge already reads that table in
`patientProfile.ts`) then `production_case_scan_cleanups`. If either read is
itself refused, or no cleanup is open, the original Postgres message is raised
unchanged rather than guessing at a cause it cannot see. The raw error always
reaches `lng_system_failures` either way, with `refusalCause` recording which
branch fired.

Note the corollary: `auth_account_id()` is evaluated **inside** the policy. A
staff session whose `accounts` row is missing or inactive resolves it to NULL,
and `started_by_account_id IS DISTINCT FROM NULL` is true for any real starter,
so such a session is locked out whenever any cleanup is open. Not worth guarding
in Lounge, but it is why the two `auth_account_id` call sites in the upload path
no longer discard their errors.

### 5.4 The shadow project is stale

`vkgghplhykavklevfhkz` has **zero rows** in `file_labels` (`reltuples = -1`,
never analyzed) and its `patient_files_insert` policy lacks the
`can_write_patient_files_now` predicate Meridian has. Per
`docs/runbooks/migration-workflow.md` every migration is verified there first,
but for anything touching patient-axis RLS or catalogue data the shadow will not
reproduce Meridian's behaviour. Worth a refresh before the next patient-axis
migration.

### 5.5 Settled, no action

- **`scope = 'patient_file'`** confirmed: it is what both sibling rows use, and
  one of the two scope values in the table. `sort_order` corrected from 901 to
  **900** to match the siblings.
- **`patient_events` insert** is `auth.uid() IS NOT NULL`, so any signed-in
  session can write the audit row. The `intake_photo_added` events were never
  being dropped, despite `20260518000013_lng_patient_events_staff_select.sql`
  describing writes as "locked to the existing writer policies". No RPC needed;
  the warning-level logging added here is defensive only.
- **`patient_files` SELECT** is effectively open to any session that can read
  the patient, as is INSERT modulo 5.3. Both are granted to `{public}` rather
  than `authenticated` and carry no staff-role gate, which is looser than the
  `auth_is_lng_staff()` model Lounge uses on its own tables. Meridian's table
  and Meridian's call; raise it, do not patch it from here.
- **Storage orphans already in the bucket.** The cleanup added here is
  forward-looking. Any object written by a previously failed insert is still in
  `case-files` with no `patient_files` row pointing at it. Worth a one-off
  reconciliation if the bucket listing is large.
