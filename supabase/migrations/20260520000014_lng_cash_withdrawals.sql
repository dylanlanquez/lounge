-- 20260520000014_lng_cash_withdrawals.sql
--
-- Cash withdrawals primitive. Records cash physically leaving the safe
-- for reasons other than a customer refund — bank deposit, float top-
-- up, petty cash, owner draw, etc. Pairs with the running-balance
-- rework of lng_cash_counts: each signed count's actual_pence is now
-- the opening balance the next count carries forward, so cash leaving
-- the safe needs a recordable event or the next count would read as a
-- shortfall.
--
-- Permission model:
--   * read: auth_can_view_financials() (same tier as cash counts).
--   * insert: auth_can_count_cash() (taking cash out is a higher-
--             trust action; same gate as performing a count).
--   * no update / delete policy — rows are insert-once for audit
--     integrity, mirroring lng_cash_count_lines.
--
-- Companion snapshot table lng_cash_count_withdrawal_lines records
-- which withdrawals were included in a given signed count, so the
-- statement stays accurate even if the underlying rows are added to
-- later. Same pattern as lng_cash_count_lines for payment snapshots.
--
-- Email seed for cash_withdrawal_notification template lands at the
-- bottom so Admin → Emails picks it up automatically. Mirrors the
-- manager_notification seed shape (20260519000015) — distinct copy +
-- distinct variables because the action is cash-flow focused, not
-- patient-flow focused.

-- ── 1. lng_cash_withdrawals ─────────────────────────────────────────
create table if not exists public.lng_cash_withdrawals (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references public.locations(id) on delete restrict,
  amount_pence    integer not null check (amount_pence > 0),
  reason          text not null check (reason in (
                    'bank_deposit',
                    'float_top_up',
                    'petty_cash',
                    'owner_draw',
                    'other'
                  )),
  note            text null,
  taken_by        uuid not null references public.accounts(id) on delete restrict,
  taken_at        timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index lng_cash_withdrawals_recent_idx
  on public.lng_cash_withdrawals (location_id, taken_at desc);

alter table public.lng_cash_withdrawals enable row level security;

create policy lng_cash_withdrawals_read on public.lng_cash_withdrawals
  for select to authenticated using (public.auth_can_view_financials());

create policy lng_cash_withdrawals_insert on public.lng_cash_withdrawals
  for insert to authenticated with check (public.auth_can_count_cash());

-- No update / delete policy. Withdrawals are append-only; mistakes get
-- corrected by recording a compensating withdrawal with a clear note,
-- never by editing or deleting the original row.

comment on table public.lng_cash_withdrawals is
  'Cash physically leaving the safe for non-refund reasons (bank deposit, float top-up, petty cash, owner draw, other). Insert-only audit row. Subtracted from the safe running balance and surfaced on the Right-now card + signed cash count statements.';

-- ── 2. lng_cash_count_withdrawal_lines ──────────────────────────────
-- Snapshot of withdrawals included in a count. Insert-once. Mirrors
-- lng_cash_count_lines so the historical statement reads accurately
-- even if a withdrawal's taken_by account is later disabled or
-- renamed (defensive denormalisation).

create table if not exists public.lng_cash_count_withdrawal_lines (
  id                          uuid primary key default gen_random_uuid(),
  count_id                    uuid not null references public.lng_cash_counts(id) on delete cascade,
  withdrawal_id               uuid not null references public.lng_cash_withdrawals(id) on delete restrict,
  amount_pence                integer not null check (amount_pence > 0),
  reason_snapshot             text not null,
  note_snapshot               text null,
  taken_at                    timestamptz not null,
  taken_by_name_snapshot      text null,
  created_at                  timestamptz not null default now()
);

create unique index lng_cash_count_withdrawal_lines_unique
  on public.lng_cash_count_withdrawal_lines (count_id, withdrawal_id);
create index lng_cash_count_withdrawal_lines_count_idx
  on public.lng_cash_count_withdrawal_lines (count_id, taken_at);

alter table public.lng_cash_count_withdrawal_lines enable row level security;

create policy lng_cash_count_withdrawal_lines_read on public.lng_cash_count_withdrawal_lines
  for select to authenticated using (public.auth_can_view_financials());

create policy lng_cash_count_withdrawal_lines_insert on public.lng_cash_count_withdrawal_lines
  for insert to authenticated with check (public.auth_can_count_cash());

comment on table public.lng_cash_count_withdrawal_lines is
  'Snapshot of cash withdrawals included in a count. Insert-only. Pair to lng_cash_count_lines (which snapshots cash payments). Denormalises taken_by name + reason + note at insert time so the historical statement stays accurate.';

-- ── 3. cash_withdrawal_notification email template ──────────────────
-- Seeded into lng_email_templates so Admin → Emails surfaces the row
-- automatically. Mirror the manager_notification seed shape from
-- 20260519000015 — same row keys + version + enabled defaults, but
-- with cash-flow-focused copy + a distinct variable set.

insert into public.lng_email_templates (
  key, service_type, subject, body_syntax,
  default_subject, default_body_syntax, version, enabled, description
) values (
  'cash_withdrawal_notification',
  null,
  'Cash taken from the safe — {{amount}}',
  $body$Hi {{managerName}},

A cash withdrawal has been recorded at the Lounge.

## Cash taken from the safe

{{amount}} removed for {{reasonLabel}}.

---

**Amount**
{{amount}}

**Reason**
{{reasonLabel}}

**Note**
{{noteOrEmpty}}

**Taken by**
{{takenByName}}

**Time**
{{takenAt}}

---

[button:Open cash counts]({{safeUrl}})

This notification is for your records. No action is required.

The Venneir Team$body$,
  'Cash taken from the safe — {{amount}}',
  $body$Hi {{managerName}},

A cash withdrawal has been recorded at the Lounge.

## Cash taken from the safe

{{amount}} removed for {{reasonLabel}}.

---

**Amount**
{{amount}}

**Reason**
{{reasonLabel}}

**Note**
{{noteOrEmpty}}

**Taken by**
{{takenByName}}

**Time**
{{takenAt}}

---

[button:Open cash counts]({{safeUrl}})

This notification is for your records. No action is required.

The Venneir Team$body$,
  1,
  true,
  'Sent to each manager listed under Admin → Emails → General → Manager notifications whenever a staff member records cash leaving the safe (bank deposit, float top-up, petty cash, owner draw, other). Edit the recipient list under the manager_notification row; this row only controls the copy.'
)
on conflict (key, service_type) do nothing;

-- ── Rollback ────────────────────────────────────────────────────────
-- delete from public.lng_email_templates
--   where key = 'cash_withdrawal_notification' and service_type is null;
-- drop table if exists public.lng_cash_count_withdrawal_lines;
-- drop table if exists public.lng_cash_withdrawals;
