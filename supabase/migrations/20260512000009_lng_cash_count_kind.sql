-- Legacy cash-count baseline.
--
-- Cash counts chain: each new count's period starts where the last
-- signed count's period ended. That works once the chain has been
-- established, but it doesn't give staff a way to RESET the chain
-- — e.g. when bringing the app live for a new venue, or when test
-- counts from a pre-launch shakedown need to be marked done so the
-- live launch starts clean.
--
-- Add a `kind` column so the same lng_cash_counts table can hold
-- regular reconciliation rows AND explicit baseline resets. The
-- position-computing logic doesn't need to change — it already
-- anchors on the most-recent signed count's period_end regardless of
-- kind — but the admin tool and the history view can now identify
-- which counts are baselines and label them accordingly.
--
-- Repeatable on purpose: Dylan asked for the option to do this
-- multiple times during pre-launch / re-launch cycles.

alter table public.lng_cash_counts
  add column if not exists kind text not null default 'regular'
    check (kind in ('regular', 'legacy_baseline'));

comment on column public.lng_cash_counts.kind is
  'Distinguishes regular reconciliation counts (the default) from legacy_baseline counts triggered from Admin to reset the cash chain at launch or re-launch.';

-- Index isn't strictly necessary — the kind values are tiny and the
-- history list already paginates — but it lets the admin "show only
-- baselines" filter (if we add one later) run without a seq scan.
create index if not exists lng_cash_counts_kind_idx
  on public.lng_cash_counts (kind, period_end desc);

NOTIFY pgrst, 'reload schema';
