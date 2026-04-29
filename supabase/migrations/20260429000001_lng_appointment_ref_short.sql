-- 20260429000001_lng_appointment_ref_short.sql
--
-- Shorten the appointment reference format.
--
-- Old: LNGE-APT-YYYYMMDD-NNNN  (e.g. LNGE-APT-20260428-0001) — 21 chars
-- New: LAP-NNNNN               (e.g. LAP-00001)             —  9 chars
--
-- The old format encoded the stamp date and a per-day counter. In practice
-- the date adds noise on cards, badges, and printed paperwork — the
-- appointment row already has start_at when anyone needs it. The new format
-- is a single ever-increasing counter, zero-padded to 5 digits and rolling
-- past that naturally when the clinic eventually crosses 99,999 appointments.
--
-- Existing LNGE-APT-* refs are immutable (see
-- lng_appointments_guard_appointment_ref / lng_walk_ins_guard_appointment_ref)
-- and remain on the rows that already have them. Nothing in the codebase
-- parses the appointment_ref string — it's display-only — so the two formats
-- can coexist indefinitely.
--
-- Replaces:
--   public.generate_appointment_ref()       — now returns LAP-NNNNN
--   public.lng_appointment_ref_sequences    — drops year/month/day columns,
--                                             keeps singleton next_value
--
-- Rollback at the bottom of the file.

-- ── 1. simplify the counter table ───────────────────────────────────────────
-- Keep the singleton-row shape so anyone reading the DB still recognises the
-- pattern. Drop the date columns since the new format doesn't encode them.
-- The current next_value carries forward, so the first new ref takes whatever
-- counter the table holds at migration time (no reset to 1).
alter table public.lng_appointment_ref_sequences
  drop column if exists year,
  drop column if exists month,
  drop column if exists day;

-- ── 2. rewrite the generator ────────────────────────────────────────────────
create or replace function public.generate_appointment_ref()
returns text
language plpgsql
as $$
declare
  v_n int;
begin
  update public.lng_appointment_ref_sequences
     set next_value = next_value + 1,
         updated_at = now()
   where id = 1
   returning next_value - 1
     into v_n;

  if v_n is null then
    raise exception 'lng_appointment_ref_sequences row missing, was migration 28 applied?';
  end if;

  return 'LAP-' || lpad(v_n::text, 5, '0');
end;
$$;

comment on function public.generate_appointment_ref() is
  'Returns the next appointment reference (LAP-NNNNN). Atomically increments lng_appointment_ref_sequences. Replaces the LNGE-APT-YYYYMMDD-NNNN format from migration 28; existing refs remain unchanged (immutable per lng_appointments_guard_appointment_ref).';

-- ── 3. refresh column comments to reflect the new format ────────────────────
comment on column public.lng_appointments.appointment_ref is
  'Human-readable appointment reference (LAP-NNNNN). Stamped at intake submit. Immutable once set (see lng_appointments_guard_appointment_ref). Pre-2026-04-29 rows may carry the older LNGE-APT-YYYYMMDD-NNNN format.';

comment on column public.lng_walk_ins.appointment_ref is
  'Human-readable appointment reference (LAP-NNNNN). Stamped at walk-in creation. Immutable once set (see lng_walk_ins_guard_appointment_ref). Shares generate_appointment_ref() with lng_appointments so refs across both surfaces stay monotonic. Pre-2026-04-29 rows may carry the older LNGE-APT-YYYYMMDD-NNNN format.';

-- ── Rollback ────────────────────────────────────────────────────────────────
-- ALTER TABLE public.lng_appointment_ref_sequences
--   ADD COLUMN year  int NOT NULL DEFAULT extract(year  from now())::int,
--   ADD COLUMN month int NOT NULL DEFAULT extract(month from now())::int,
--   ADD COLUMN day   int NOT NULL DEFAULT extract(day   from now())::int;
-- Then re-create generate_appointment_ref() from migration 28's body.
-- Existing LAP-NNNNN rows on lng_appointments / lng_walk_ins remain
-- (rollback only restores the generator, not the stamped values).
