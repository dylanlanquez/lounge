# Runbook — Lounge migration workflow

**Purpose:** the standard, repeatable process for getting a Lounge database migration from "written" to "applied to Meridian." Built once, used forever.

**Why this exists:** Lounge runs on Meridian's Supabase project. Meridian is shared production. Mistakes are expensive. This runbook gives every migration a tested path before it touches production.

---

## 0. The two projects

| Role | Project ref | Purpose |
|---|---|---|
| **Production** | `npuvhxakffxqoszytkxw` | Meridian. Real patients, real cases. Lounge runs alongside in `lng_*` tables. |
| **Shadow** | `vkgghplhykavklevfhkz` | The parked Supabase project. Holds a refreshed copy of Meridian's schema (no data). Used to test every Lounge migration before production. |

Going forward, **the shadow is real estate**, not "the parked project we may use one day." Treat it as part of the dev pipeline.

---

## 1. One-time setup (do this once, ~15 minutes)

### 1.1 Install Postgres client tools

```bash
brew install libpq
echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
psql --version    # should print "psql (PostgreSQL) 17.x" or similar
pg_dump --version # should print same
```

### 1.2 Save connection strings (one-time)

**Use the pooler URLs, not the direct DB hostnames.** Supabase has moved direct hosts (`db.<ref>.supabase.co`) to IPv6-only — they will *not* resolve over IPv4 on most home / office networks, so anything that uses them silently fails with `could not translate host name`. The pooler has IPv4 records and is the only reliable path from a developer machine.

In Supabase Dashboard → each project → **Project Settings → Database → Connection string → "Session pooler"** (port 5432). Copy both. Keep them in your password manager (not in git).

```bash
# Add to ~/.zshrc, source it. NEVER commit to a file in git.
# Both URLs as of 5 May 2026 — re-check the dashboard if the pooler
# host or region changes (Supabase occasionally rebalances).
export LNG_MERIDIAN_DB_URL='postgresql://postgres.npuvhxakffxqoszytkxw:<pw>@aws-1-eu-west-2.pooler.supabase.com:5432/postgres'
export LNG_SHADOW_DB_URL='postgresql://postgres.vkgghplhykavklevfhkz:<pw>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres'
```

The two projects sit in different regions (Meridian → London, Shadow → Frankfurt) so the pooler hostnames are NOT the same — copy each one from the dashboard separately.

**If the dashboard URL ever stops working, re-discover the region:**

```bash
# Probe a handful of pooler hosts. The right one returns "select 1 → 1";
# the wrong ones return "Tenant or user not found".
for prefix in aws-1-eu-west-2 aws-1-eu-central-1 aws-1-eu-west-1 \
              aws-0-eu-west-2 aws-0-eu-central-1 aws-0-us-east-1; do
  echo "=== $prefix ==="
  psql "postgresql://postgres.<project_ref>:<pw>@${prefix}.pooler.supabase.com:5432/postgres" \
    -c "select 1 as ok;" 2>&1 | tail -2
done
```

(Direct DB hostnames still work over IPv6 if your machine and network are dual-stacked — useful if you need a feature that the pooler doesn't pass through, like `LISTEN/NOTIFY`. For DDL migrations, the session pooler is fine.)

### 1.3 Bootstrap the shadow with Meridian's schema

```bash
# Dump Meridian's schema (no data)
pg_dump --schema-only --no-owner --no-privileges \
  --schema=public --schema=auth --schema=storage \
  "$LNG_MERIDIAN_DB_URL" > /tmp/meridian-schema-$(date +%Y%m%d).sql

# Inspect — should be many CREATE TABLE / FUNCTION / TRIGGER statements,
# no INSERT statements (that would mean data leaked, which we did not want).
grep -c '^INSERT' /tmp/meridian-schema-*.sql   # should be 0 or close to it

# Apply to the shadow project
psql "$LNG_SHADOW_DB_URL" < /tmp/meridian-schema-$(date +%Y%m%d).sql
```

The shadow now has Meridian's schema (tables, functions, triggers, RLS) but **no patient data**. Confirm in Supabase Studio for the shadow project: tables list should match Meridian's.

### 1.4 Save the bootstrap state

Tag the schema dump in your password manager / notes:

> "Shadow bootstrap on YYYY-MM-DD against Meridian migration `20260427_16`. Refresh next month."

---

## 2. Per-migration workflow (run this every time)

You wrote a new migration in `~/Desktop/lounge-app/supabase/migrations/`. Here's how to ship it.

### 2.1 Apply to the shadow first

```bash
cd ~/Desktop/lounge-app

# Link to the shadow
npx supabase link --project-ref vkgghplhykavklevfhkz
# Will prompt for the shadow's DB password — paste it.

# Push only Lounge's migrations (the shadow already has Meridian's schema).
# --include-all forces the CLI to push every local migration not yet on the
# remote schema_migrations table; the shadow has no Lounge entries yet on
# first run, so all 18 will go.
npx supabase db push --include-all
```

If the CLI complains "remote migration versions not found in local migrations directory", that's the Meridian baseline mismatch (the dump didn't write to `supabase_migrations.schema_migrations`). Force it:

```bash
npx supabase db push --include-all --dry-run    # confirms what would apply
npx supabase db push --include-all              # do it
```

If a migration **fails on the shadow**, fix the SQL file in `supabase/migrations/`, and re-run. The CLI is idempotent on already-applied migrations.

### 2.2 Verify the shadow

Supabase Studio for shadow project (`vkgghplhykavklevfhkz`) → Database → Tables. Confirm:

- New `lng_*` tables exist with expected columns.
- Triggers (e.g. `patients_guard_lwo_ref`) listed under the `patients` table.
- New functions (`generate_lwo_ref`, `auth_is_receptionist`) under Database → Functions.
- New enum value (`receptionist`) under Database → Types → `lab_role_enum`.

### 2.3 Apply to Meridian (production)

Only after the shadow is green:

```bash
# Re-link to Meridian
npx supabase link --project-ref npuvhxakffxqoszytkxw
# Prompts for Meridian's DB password.

# Same push command as for the shadow
npx supabase db push --include-all
```

Watch every line of output. If a migration fails, **stop**. Do not re-link to the shadow yet. Investigate, fix locally, repeat from §2.1.

### 2.4 Verify production

Supabase Studio for Meridian → Database → Tables. Same checks as §2.2.

### 2.5 Commit

```bash
git add supabase/migrations/
git commit -m "Apply slice <NN> migrations: <short description>"
git push origin <feature-branch>
```

Open a PR against `main`. Merge after the slice's other code (edge functions, UI) is also reviewed.

---

## 3. Periodic shadow refresh (monthly, or after big Meridian changes)

The shadow only stays useful while it mirrors Meridian's current schema. As Meridian ships new migrations, the shadow drifts.

```bash
# Drop everything in the shadow, reapply latest Meridian schema, then reapply
# our Lounge migrations.

# 1. Dump latest Meridian
pg_dump --schema-only --no-owner --no-privileges \
  --schema=public --schema=auth --schema=storage \
  "$LNG_MERIDIAN_DB_URL" > /tmp/meridian-schema-$(date +%Y%m%d).sql

# 2. Reset shadow (THIS DROPS THE SHADOW SCHEMA — destructive but on a non-prod project)
psql "$LNG_SHADOW_DB_URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'

# 3. Apply latest Meridian schema
psql "$LNG_SHADOW_DB_URL" < /tmp/meridian-schema-$(date +%Y%m%d).sql

# 4. Reapply Lounge migrations
cd ~/Desktop/lounge-app
npx supabase link --project-ref vkgghplhykavklevfhkz
npx supabase db push --include-all
```

Set a calendar reminder: **first Monday of each month**, run §3 before doing any new Lounge schema work.

---

## 4. Recovery — when production migration goes wrong

If `db push` fails partway against Meridian:

### 4.1 Diagnose

The CLI prints which migration failed. Look at the error. Common causes:

| Error | Fix |
|---|---|
| `relation "X" already exists` | A previous migration partially applied. Remove the failing CREATE statement or guard with IF NOT EXISTS, push again. |
| `permission denied for ...` | RLS policy referencing a non-existent helper. Verify `is_admin()` / `auth_location_id()` exist on Meridian. |
| `enum X does not exist` | ALTER TYPE migration not yet applied or in same transaction as a use. Check that ALTER TYPE has its own migration file. |
| Connection timeout | Meridian is busy or rate-limiting. Retry. |

### 4.2 Roll back

Each migration in this repo has a `Rollback:` comment in its header. Apply manually via Supabase Studio → SQL Editor for the production project.

### 4.3 Postmortem

Write a quick note in `docs/runbooks/incidents/YYYY-MM-DD-<short>.md`. What broke, what we did, what we'll do differently. Future-you will thank present-you.

---

## 5. Why this workflow over alternatives

- **vs. `supabase branches create`:** Supabase preview branches start empty. Useless for testing migrations that depend on Meridian's schema.
- **vs. local Postgres in Docker:** would also work but adds Docker as a dependency. Shadow is cloud-native, same infra as production = highest fidelity.
- **vs. apply-direct-to-Meridian:** higher risk per migration. The shadow takes ~30 seconds to verify against and catches 90% of typos / RLS mistakes / FK ordering errors before they hit production.

---

## 6. Slice 0 — the first run of this workflow

### Files involved

`~/Desktop/lounge-app/supabase/migrations/20260428_01..18`. 18 migrations, all additive.

### Risk profile

- 0 `DROP` statements
- 0 `UPDATE` on existing rows
- 1 `ALTER TYPE` (adds enum value `receptionist` to `lab_role_enum`) — non-breaking
- 1 `CREATE TRIGGER` on existing `patients` table (`patients_guard_lwo_ref`) — fires only when `lwo_ref` UPDATE happens; no existing rows have `lwo_ref` set so zero observable effect
- 16 `CREATE TABLE` / `CREATE FUNCTION` / `CREATE VIEW` on new `lng_*` objects
- 1 `INSERT INTO lng_settings` (BNPL seed) — only into the new table

### Pre-flight check

Read each migration's header `Rollback:` line. They are:

| # | Rollback |
|---|---|
| 01 | `DROP TABLE public.lng_lwo_sequences;` |
| 02 | `DROP TABLE public.lng_settings;` |
| 03 | (cannot remove enum value; recreate type if needed — see migration header) |
| 04 | `DROP FUNCTION public.auth_is_receptionist();` |
| 05–13, 16 | `DROP TABLE/VIEW` on the new object |
| 14 | `DROP FUNCTION public.generate_lwo_ref();` |
| 15 | `DROP TRIGGER patients_guard_lwo_ref ON public.patients;` and `DROP FUNCTION public.patients_guard_lwo_ref();` |
| 17 | `ALTER TABLE … DISABLE ROW LEVEL SECURITY; DROP POLICY …;` |
| 18 | `DELETE FROM public.lng_settings WHERE location_id IS NULL AND key LIKE 'bnpl.%' OR key LIKE 'epos.%';` |

If applying production fails midway, rollback from #18 down to whichever migration last applied successfully, fix, retry from §2.1.

### Smoke test after Meridian apply

In Supabase Studio for Meridian:
- Database → Tables → `lng_appointments`, `lng_walk_ins`, `lng_visits`, `lng_carts`, `lng_payments`, etc. — should all be present with correct columns.
- Database → Types → `lab_role_enum` — should include `receptionist`.
- Database → Functions → `generate_lwo_ref`, `auth_is_receptionist`, `patients_guard_lwo_ref` — present.
- SQL Editor → run `SELECT * FROM public.lng_settings WHERE key LIKE 'bnpl.%' LIMIT 5;` — should return BNPL seed rows.
- SQL Editor → run `SELECT generate_lwo_ref();` — should return `LWO-20260428-0001` (or whatever the date is).

If any of those don't match: stop, debug, ask before retrying.

---

*Last updated 5 May 2026 — connection strings switched to the session pooler after Supabase moved direct DB hostnames to IPv6-only. Pooler URLs are IPv4-friendly and what the migration runbook now assumes.*
