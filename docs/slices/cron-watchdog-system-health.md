# Slice — Cron watchdog + System health

**Status:** Shipped to production 2026-06-05 (DB engine live on Meridian; admin tab in build)
**Migration:** `20260605000001_lng_cron_watchdog.sql` (shadow-verified, applied to Meridian)
**Related:** memory `meridian-shopify-order-sync-outage`

---

## 1. Why

On ~11 May 2026 three scheduled jobs were deleted from `cron.job` during maintenance and nothing alerted anyone for 3.5 weeks:

- The external trigger driving the Shopify orders sync (`shopify_orders` froze at 12 May 09:44; patients showed "No Shopify orders").
- `lng-appointment-reminders-hourly` (email reminders silently stopped ~3 May while templates stayed enabled; SMS kept running).
- `lng_run_sync_parcel_codes` (dormant, no backlog).

The schedules lived only in the DB, with no version control and no monitoring. A stopped sweep was invisible.

## 2. What this adds

1. **Watchdog engine** (`lng_run_cron_watchdog()`, scheduled `lng-cron-watchdog` every 15 min): checks every job in `lng_cron_watchdog_expectations` for (a) existence in `cron.job` and (b) a successful run within its `max_staleness`. Opens a `critical` `lng_system_failures` row (`source = 'cron_watchdog'`) for any missing/stale job and **auto-resolves** it when the job recovers. A just-scheduled job with no run history yet reads `pending` (graced by its own staleness window) so adding a job never false-alarms.
2. **Read API** (`lng_cron_health()`): per-job status for the admin panel. SECURITY DEFINER because the `cron` schema is not client-readable. Returns no patient data.
3. **Admin > System health tab** (`src/routes/AdminSystemHealthTab.tsx`): red/green/amber row per job with last-run relative time. Failures also appear in the existing Failures tab.
4. **Dead man's switch**: each watchdog run pings `lng_settings.cron_watchdog_healthcheck_url` (healthchecks.io). If the watchdog itself stops, the external monitor alerts. Skipped silently until the URL is set.
5. **Version control**: the migration re-asserts the schedules restored on 2026-06-05 (orders sync + email reminders) so the cron setup finally lives in git.

## 3. Smoke test (plain English)

> Dylan opens Admin and taps "System health". He sees a row per background job, each with a green "Healthy" pill and "last run 4 min ago". A while later a job stops firing. Within 15 minutes its row turns amber "Stale" (or red "Missing" if it was deleted), the count reads "1 of 4 jobs need attention", and a matching failure appears in the Failures tab. Once the job is fixed and runs again, the row goes green on its own and the failure resolves itself, no manual clearing.

Proven on the shadow DB: deleting `lng-meet-attendance-sweep-5min` made the watchdog open a `missing` critical failure and the health row read `missing`; rescheduling it auto-resolved the failure on the next run (`problems: 0`).

## 4. Data model touches

| Object | Operation |
|---|---|
| `lng_cron_watchdog_expectations` (new table) | seed config, RLS-enabled, no client policies |
| `lng_system_failures` | INSERT/UPDATE `source = 'cron_watchdog'` (open + auto-resolve) |
| `lng_settings` | READ key `cron_watchdog_healthcheck_url` |
| `cron.job`, `cron.job_run_details` | READ (existence + last successful run) |
| `vault.decrypted_secrets` | READ `lng_service_role_key` (restored sweep wrappers) |

## 5. Monitored jobs (seed)

| jobname | max_staleness |
|---|---|
| `sync-shopify-orders-daily` | 30 hours |
| `lng-appointment-reminders-hourly` | 150 minutes |
| `lng-appointment-sms-reminders-hourly` | 150 minutes |
| `lng-meet-attendance-sweep-5min` | 20 minutes |

Parcel-codes sync is intentionally not seeded (left off; add a row when dispatching resumes).

## 6. Tests

- **Unit** (`src/lib/cronHealthFormat.test.ts`, 9 tests, passing): status→tone mapping, alarm classification, relative+absolute last-run formatting across every bucket.
- **DB adversarial** (shadow, manual, passing): delete a job → `missing` + critical failure; restore → auto-resolve.
- **Type-check + lint**: pass (one pre-existing unrelated warning in Admin.tsx).
- **Playwright (follow-up):** a full authenticated admin-tab E2E needs an admin sign-in fixture that the repo does not yet have (`tests/foundation.spec.ts` is unauthenticated only). Tracked as a gap, not done here.

## 7. Known limitation

"Successful run" keys off `cron.job_run_details.status = 'succeeded'`, i.e. the cron command fired. The sweeps `net.http_post` asynchronously, so this reliably catches a deleted / non-firing job (the 11 May failure mode) but not a job that fires yet whose edge function later errors. Downstream-failure detection (reading `net._http_response` status or data freshness) is a deliberate future add.

## 8. Self-score

| Axis | Score | Notes |
|---|---|---|
| Code quality | 92 | Mirrors existing cron/migration + admin-tab patterns; pure logic extracted and tested. |
| Tests | 88 | Unit + DB adversarial solid; authenticated E2E deferred for missing fixture (called out). |
| UX polish | 90 | At-a-glance red/green, relative times, self-explaining empty/error states. |
| Security | 93 | SECURITY DEFINER read API returns no PHI; config table RLS-locked; no secrets in cron command. |
| Performance | 95 | One 15-min job; health RPC is a cheap lateral over cron history. |
| Robustness | 92 | Grace period prevents false alarms; auto-resolve prevents alert spam; dead-man's switch covers the watchdog itself. |
| **Aggregate** | **91** | Above the 90 floor. Dead-man's-switch URL is the one open wiring step. |
