-- 20260519000005_lng_sms_templates_display_name.sql
--
-- Adds an editable display_name to lng_sms_templates so admins can
-- rename what each template reads as in the Admin > SMS list and in
-- the receptionist's Send-an-SMS dropdown on the Visit page. Today
-- the human label is derived from the template's `key` via a
-- hardcoded humaniseSmsKey() helper; this column lets that be
-- overridden per template without touching code.
--
-- Scope:
--   • Column lives on every row (General + service-typed overrides)
--     but admin UI only edits the General row's name; the picker
--     reads from there. Per-service overrides keep the General
--     display_name for consistency in the receptionist's dropdown.
--   • NULL = use the humanised default. Empty string falls through
--     to the same default app-side.
--
-- Also: this migration scrubs em dashes from the description rows
-- seeded by 20260518000012 and 20260519000004. Lounge house style
-- bans em / en dashes in any patient or operator-facing string,
-- preferring commas or full stops. The description shows in the
-- Admin SMS row beneath the title; receptionists never see it but
-- admins do, so the rule applies.
--
-- Rollback:
--   alter table public.lng_sms_templates drop column if exists display_name;

-- ── 1. Column ────────────────────────────────────────────────────

alter table public.lng_sms_templates
  add column if not exists display_name text null;

-- ── 2. Scrub em dashes from existing descriptions ────────────────
-- Replace " — " (space em dash space) with ". " so the sentence
-- reads as two short statements instead of one with a long pause.
-- Only touches rows that still contain the em dash; idempotent.

update public.lng_sms_templates
   set description = replace(description, ' — ', '. ')
 where description like '% — %';

-- A handful of descriptions also end with "in-clinic" / "hand-back"
-- compound hyphens — those are valid compound nouns and stay. The
-- replace above only targets the em-dash punctuation pattern.
