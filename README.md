# Lounge

Walk-in and appointments app for Venneir, running on Meridian's Supabase project.

Build brief: [`/Users/dylan/Downloads/lounge-build-brief.md`](../../Downloads/lounge-build-brief.md). Phase 0 discovery: [`docs/`](./docs).

## Stack

- React 19 + Vite + TypeScript
- Supabase (project `npuvhxakffxqoszytkxw`, shared with Meridian)
- React Router v6
- Inline styles + theme tokens (no CSS framework)
- Lucide React for icons
- Storybook for component docs (Phase 2)
- Playwright for end-to-end tests
- Stripe Terminal S700 for in-person payments
- Vercel for hosting (`lounge.venneir.com`)

## Quickstart

```bash
cd ~/Desktop/lounge-app
npm install
cp .env.example .env.local           # then fill in real values from Meridian's .env
npm run dev                          # http://localhost:5173
```

## Scripts

- `npm run dev` — Vite dev server
- `npm run build` — typecheck + production build
- `npm run typecheck` — TS only, no emit
- `npm run lint` — ESLint
- `npm run test:e2e` — Playwright
- `npm run storybook` — Storybook on :6006

## Working with Supabase

Migrations are written locally in `supabase/migrations/` and pushed with:

```bash
npx supabase db push --project-ref npuvhxakffxqoszytkxw
```

**Critical:** Lounge runs on the same Supabase project as Meridian. Before any push, read the latest migration filename in `~/Desktop/meridian-app/supabase/migrations/` to confirm baseline; run on a Supabase branch first; show the diff; only then apply to production.

## Repo layout

- `src/` — application code
- `public/` — static assets (logos, favicon)
- `supabase/migrations/` — Postgres migrations (`lng_*` tables)
- `supabase/functions/` — edge functions (terminal, calendly, etc.)
- `tests/` — Playwright specs
- `docs/` — phase-by-phase planning and decisions
- `app-inspo/`, `calendar-design-inspo/`, `epos-inspo/` — design references (read-only)
- `bnpl-staff-guide/` — Klarna/Clearpay scripts and procedures
- `stripe-terminal-spec/` — Stripe Terminal project brief

## Deployment

Production: `lounge.venneir.com` via Vercel.
Previews on every PR.
