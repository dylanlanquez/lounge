# CLAUDE.md — Lounge project conventions

This file is loaded automatically when Claude Code is invoked in this directory.

## Read first

- [`/Users/dylan/Downloads/lounge-build-brief.md`](../../Downloads/lounge-build-brief.md) — the full v5 build brief. Phase-by-phase. Follow in order. Do not skip phases. Do not write code in read-only phases.
- [`docs/00-discovery.md`](docs/00-discovery.md) — Phase 0 discovery summary. Read before suggesting any new feature.
- [`docs/01-architecture-decision.md`](docs/01-architecture-decision.md) — ADRs. Architectural decisions go through here.
- [`docs/02-data-protection.md`](docs/02-data-protection.md) — UK GDPR / DPA 2018 framework, retention, DSAR runbook.
- [`docs/06-patient-identity.md`](docs/06-patient-identity.md) — matching priority, fill-blanks rule, generate_lwo_ref().

## Hard rules

- **All Lounge tables use `lng_` prefix.** Mirrors Meridian's `mrd_`.
- **Inline styles only.** No Tailwind, no styled-components, no CSS modules. Theme tokens come from `src/theme/index.ts`. No hardcoded values.
- **Lucide React only for icons.** No other icon libraries.
- **No silent fallbacks.** A `value || 'default'` masks missing data. Validate, throw, log, fix the root cause.
- **Failures must be loud.** Patient-axis events → `patient_events`. Lounge-internal events → `lng_event_log`. Failures → `lng_system_failures`.
- **No em dashes, en dashes, or hyphens used as punctuation in UI text.** Use commas or full stops.
- **Walk-ins are patients, not "guests" or "customers".**
- **Edge function auth:** anon key as Bearer JWT, defined at module level. Stripe webhooks verify Stripe signatures, not Supabase auth.
- **Sign storage URLs on demand**, never store them in DB.
- **Stripe webhook signature verification mandatory.** Stripe secret key never client-side, never logged, never returned in responses.
- **Idempotency keys on every PaymentIntent creation.**
- **BNPL: never suggest, never advise, never quote.** Helper UX must enforce.
- **BNPL scripts loaded from `lng_settings`,** not hardcoded.
- **Per-location email uniqueness** on `patients` (already enforced by Meridian's index).
- **Fill-blanks merge rule** on patient ingestion: never overwrite a non-null value.
- **`patients.lwo_ref` is immutable once set** (enforced by trigger `patients_guard_lwo_ref`).

## Testing

- Type-check + lint pass before any commit.
- Playwright E2E for every Phase 1+ slice. Each slice's smoke test in plain English goes in `docs/slices/NN-name.md`.
- Score each output out of 100 across the brief's eight axes (code quality, tests, UX polish, visual design, performance, security, a11y, i18n). Below 90 → stop, plan, present.

## Working with Supabase

- Lounge runs on Meridian's project `npuvhxakffxqoszytkxw` (production).
- A second Supabase project `vkgghplhykavklevfhkz` is the **shadow** — refreshed copy of Meridian's schema, used to test every migration before production. See `docs/runbooks/migration-workflow.md`.
- Migration filenames: `YYYYMMDD_NN_lng_<description>.sql`.
- Coordinate with Meridian: read latest migration in `~/Desktop/meridian-app/supabase/migrations/` before adding a Lounge migration.
- Apply order: write → shadow (verify) → Meridian. Never directly to Meridian without shadow verification.
- Edge function deploy: `npx supabase functions deploy <name> --project-ref npuvhxakffxqoszytkxw`.
- **DB connections use the session pooler, not direct hostnames.** Supabase moved `db.<ref>.supabase.co` to IPv6-only — IPv4 fails to resolve on most networks. Pooler URLs (as of 5 May 2026):
  - Meridian: `aws-1-eu-west-2.pooler.supabase.com:5432` with user `postgres.npuvhxakffxqoszytkxw`
  - Shadow:   `aws-1-eu-central-1.pooler.supabase.com:5432` with user `postgres.vkgghplhykavklevfhkz`
  - Apply migrations with `psql "$LNG_SHADOW_DB_URL" -f <file>` then `psql "$LNG_MERIDIAN_DB_URL" -f <file>`.
  - Both env vars live in `~/.zshrc`.

## Working agreement with Dylan

- Be explicit about file, function, line.
- Push back with evidence; not a yes-man.
- Solution-based, not negative.
- Dylan cannot access the Mac filesystem from a Claude session — describe state, don't ask him to look.
- Score out of 100; below 90 anywhere is a stop-and-improve signal.
