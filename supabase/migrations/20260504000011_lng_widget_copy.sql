-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — booking widget copy (phase 2e)
--
-- Lets the admin override the patient-facing strings on each step
-- of the widget — titles, helper paragraphs, key CTAs. Stored as
-- one jsonb document under the lng_settings key 'widget.copy'.
--
-- Why one jsonb document and not 14 individual keys: the strings
-- are read together (every patient page renders multiple at once)
-- and edited together (one Save commits the whole copy block). One
-- row keeps the writes atomic and the read a single round-trip.
--
-- Default is the empty object — the widget merges with code-side
-- defaults at render time, so any field the admin hasn't touched
-- falls back to the shipped string. Empty string saved by the
-- admin counts as "use default" too (the admin never accidentally
-- blanks a label).
--
-- Anon-readable via the new lng_widget_copy view, since the widget
-- itself is unauthenticated.
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.lng_settings (location_id, key, value, description)
values (
  null,
  'widget.copy',
  '{}'::jsonb,
  'Per-step patient-facing copy overrides for the booking widget. JSON object keyed by step / element name (e.g. "service.title", "upgrades.helper"). Empty strings or missing keys fall back to the shipped defaults at render time.'
)
on conflict (key) where location_id is null do nothing;

create or replace view public.lng_widget_copy as
  select coalesce(value, '{}'::jsonb) as copy
  from public.lng_settings
  where key = 'widget.copy'
    and location_id is null;

grant select on public.lng_widget_copy to anon, authenticated;

comment on view public.lng_widget_copy is
  'Anon-readable widget copy overrides. Returns one row with a single jsonb column "copy" — keys map to per-step strings the admin can override. Missing keys fall back to widget code defaults.';
