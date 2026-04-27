# 00c. Lab Scanner audit

**Audit date:** 27 Apr 2026
**Source:** `~/Desktop/checkpoint-app/`
**Recommendation:** Lab Scanner stays in Checkpoint. Lounge deep-links into it.

---

## 1. Where it lives

| Surface | Path |
|---|---|
| Component | `src/components/walkins/LabScanPage.jsx` |
| Route | `/lab/scan` (defined in `src/App.jsx:276`) |
| Sidebar entry-point | full-screen button in the `lab` group, `src/pages/Dashboard.jsx:1627` |
| Permission gate | `appointments_scanner` (resolved via `usePermissions()` from `src/lib/PermissionsContext.js`) |
| Library helpers | `getWalkInByLwoRef`, `logLwoScan`, `markTechStarted`, `markTechComplete`, `getStaffUsers` — all from `src/lib/walkins.js` |
| Scanner library | `html5-qrcode` (`package.json:29`) — accepts camera scan or manual text |
| Validator | Strict regex match on `LWO-YYYYMMDD-NNNN` (`LabScanPage.jsx:144`) |

---

## 2. What it does, in plain English

A bench technician (or whoever holds the scanner) opens the page. They scan a printed LWO barcode taped to a job, or they type the LWO ref. The page resolves the walk-in via `getWalkInByLwoRef`, then records:

- A row into `lwo_scans` with the staff user ID, the scan stage, and free-text notes.
- A status flip on `walk_ins`, depending on stage:
  - `markTechStarted` stamps `tech_scan_started_at` + `tech_scan_started_by`.
  - `markTechComplete` stamps `tech_scan_completed_at` + `tech_scan_completed_by`.

There is no "in lab" or "ready" state managed by the scanner directly; those are derived from the timestamp pair plus other workflow surfaces (`MyJobsPage`, `LabCheckOutModal`).

---

## 3. Tables touched

| Table | R/W | Purpose |
|---|---|---|
| `walk_ins` | R | Resolve the LWO ref → walk-in row (one row by `lwo_ref` exact match). |
| `walk_ins` | W | Stamp `tech_scan_started_at`/`_by`, `tech_scan_completed_at`/`_by`. |
| `lwo_scans` | W | Audit trail — one row per scan event with `walk_in_id`, `lwo_ref`, `scanned_by`, `scan_stage`, `scan_notes`. |
| `auth.users` (read-through staff) | R | Staff dropdown for "scanned by". |

No edge functions are called. All writes are client-side via Supabase JS SDK using RLS-permitted INSERT/UPDATE.

---

## 4. Cross-links to Appointments / Walk-ins

| Direction | Behaviour |
|---|---|
| Walk-in → scanner | Check-in (`WalkInCheckInPage`) does **not** trigger an automatic scan prompt. Tech picks up the LWO from the print queue and scans on their own initiative. |
| Scanner → walk-in row | A successful scan stamps `tech_scan_started_at` / `_completed_at` on `walk_ins`, which is what other surfaces read to badge "tech complete". |
| Scanner → calendar / bookings view | `CalendlyReportsView` and `MyJobsPage` both badge "tech complete" by reading the `tech_scan_completed_at IS NOT NULL` flag on the linked walk-in (`APPOINTMENTS-AND-WALKINS.md:442`). |
| Lab Scanner UI surfacing scanned items | None currently. The scanner is fire-and-forget; once stamped, the next surface (collected/shipped checkout in `LabCheckOutModal`) acts on the timestamp directly. |

---

## 5. Recommendation: stays in Checkpoint

### Why

1. **Tightly coupled to lab/tech workflow.** The scanner is part of a cluster: `LabScanPage`, `MyJobsPage`, `LabCheckOutModal`, lab dispatch. These all live downstream of payment and are about getting work physically out the door.
2. **No identity work.** It does not match patients, take payment, or manage check-in. Identity is fully resolved before scanning starts.
3. **Lounge's Galaxy Tab is not a tech tool.** Lounge is reception-side. Putting Lab Scanner on the receptionist tablet would split workflow across two devices.
4. **Permission gate already separates roles.** `appointments_scanner` is on `laboratory` and `dental-technician` roles. Lounge introduces `receptionist`, which would not have the scanner permission anyway.

### How Lounge integrates without owning Lab Scanner

- Lounge's appointment / visit detail view shows a **read-only** badge: "Tech started" / "Tech complete" / "Ready for handover", populated from cross-product reads (Lounge's `lng_visits.id` keyed on the same patient + walk-in pair).
- For v1, that badge is derived by a Lounge edge function that queries Checkpoint's `walk_ins.tech_scan_*_at` columns — Lounge has read access on Checkpoint's project via service-role from the edge function only.
  - **OR** — the cleaner long-term path — once walk-ins migrate to `lng_walk_ins` / `lng_visits` in Phase 4 cutover, the scanner stays in Checkpoint but reads from Meridian's `lng_*` tables (Checkpoint gets read access for the scanner's needs). This keeps the data plane on one project and Checkpoint becomes the lab-tools-only frontend.
- A "View in Lab Scanner" deep-link button on the visit detail screen opens the Checkpoint app at `/lab/scan?lwo=<ref>` (Checkpoint must accept that query param — small change).

### What we **do not** do

- Move `LabScanPage` to Lounge. Reception-side staff don't scan.
- Replicate `lwo_scans` into a `lng_lab_scans` table. The scanner stays where the bench is.
- Tear out the `tech_scan_*` columns from `walk_ins`. They migrate as-is into `lng_walk_ins` (or `lng_visits`) when the cutover happens.

---

## 6. Open questions to resolve

1. After cutover, does Checkpoint's Lab Scanner read from Lounge's `lng_walk_ins`/`lng_visits` (cross-project read), or do we keep `walk_ins` as a Checkpoint-side mirror? Decision in Phase 4 cutover plan.
2. Does Lounge's visit detail need to **start** a scan? E.g., receptionist hands the patient over and presses "Send to lab queue" which writes a placeholder scan row to skip the bench-side step. Probably not — the bench needs the physical job in front of them — but worth confirming.
3. Permissions: does the receptionist see the "View in Lab Scanner" deep-link, or only admins? Lean: deep-link visible to all roles; the page itself remains gated.

---

*End of 00c. Verify any function name or column reference against the live source before relying on it for production code.*
