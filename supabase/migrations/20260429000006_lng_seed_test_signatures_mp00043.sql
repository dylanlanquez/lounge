-- 20260429000006_lng_seed_test_signatures_mp00043.sql
--
-- Test-data seed only. Pre-launch the patient at internal_ref='MP-00043'
-- has no signatures, which makes it impossible to manually exercise the
-- new "Signed waivers" pagination on the patient profile. This migration
-- inserts ~20 signature rows for that patient so we can see >1 page in
-- the UI.
--
-- Mix of:
--   - Sections: general, denture, appliance, click_in_veneers (the
--     four seeded by migration 26).
--   - Versions: '2026-04-28-v1' (current) plus a synthetic
--     '2025-11-04-v0' so the audit table shows older snapshots too.
--   - signed_at spread across the past year so the table reads as a
--     real history rather than 20 rows on the same minute.
--
-- Idempotent: only seeds when the patient currently has fewer than 5
-- signatures. Re-running on an already-seeded patient is a no-op so the
-- migration can sit in the repo without ever bloating real data.

do $$
declare
  pid uuid;
  existing int;
  v_signature_svg text := '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80" width="320" height="80"><path d="M10 60 Q40 20 80 50 T160 50 T240 30 T310 60" stroke="#0E1414" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  v_terms_current jsonb := jsonb_build_array('Test waiver. Patient agreed to the current version of the section terms at signing.');
  v_terms_old     jsonb := jsonb_build_array('Test waiver. Patient agreed to a previous version of the section terms; needs re-sign at the current version.');
begin
  select id into pid from public.patients where internal_ref = 'MP-00043' limit 1;
  if pid is null then
    raise notice 'No patient with internal_ref MP-00043; skipping signature seed.';
    return;
  end if;

  select count(*) into existing from public.lng_waiver_signatures where patient_id = pid;
  if existing >= 5 then
    raise notice 'Patient MP-00043 already has % signatures; skipping seed.', existing;
    return;
  end if;

  insert into public.lng_waiver_signatures
    (patient_id, section_key, section_version, signature_svg, signed_at, terms_snapshot)
  values
    -- 4 current general (privacy/consent) signatures
    (pid, 'general',          '2026-04-28-v1', v_signature_svg, now() - interval '1 day',   v_terms_current),
    (pid, 'general',          '2026-04-28-v1', v_signature_svg, now() - interval '14 days', v_terms_current),
    (pid, 'general',          '2025-11-04-v0', v_signature_svg, now() - interval '95 days', v_terms_old),
    (pid, 'general',          '2025-11-04-v0', v_signature_svg, now() - interval '180 days', v_terms_old),
    -- 5 denture signatures across versions
    (pid, 'denture',          '2026-04-28-v1', v_signature_svg, now() - interval '2 days',   v_terms_current),
    (pid, 'denture',          '2026-04-28-v1', v_signature_svg, now() - interval '21 days',  v_terms_current),
    (pid, 'denture',          '2025-11-04-v0', v_signature_svg, now() - interval '60 days',  v_terms_old),
    (pid, 'denture',          '2025-11-04-v0', v_signature_svg, now() - interval '120 days', v_terms_old),
    (pid, 'denture',          '2025-11-04-v0', v_signature_svg, now() - interval '240 days', v_terms_old),
    -- 5 appliance signatures
    (pid, 'appliance',        '2026-04-28-v1', v_signature_svg, now() - interval '5 days',   v_terms_current),
    (pid, 'appliance',        '2026-04-28-v1', v_signature_svg, now() - interval '40 days',  v_terms_current),
    (pid, 'appliance',        '2025-11-04-v0', v_signature_svg, now() - interval '85 days',  v_terms_old),
    (pid, 'appliance',        '2025-11-04-v0', v_signature_svg, now() - interval '160 days', v_terms_old),
    (pid, 'appliance',        '2025-11-04-v0', v_signature_svg, now() - interval '300 days', v_terms_old),
    -- 6 click-in veneer signatures
    (pid, 'click_in_veneers', '2026-04-28-v1', v_signature_svg, now() - interval '3 hours',  v_terms_current),
    (pid, 'click_in_veneers', '2026-04-28-v1', v_signature_svg, now() - interval '7 days',   v_terms_current),
    (pid, 'click_in_veneers', '2026-04-28-v1', v_signature_svg, now() - interval '30 days',  v_terms_current),
    (pid, 'click_in_veneers', '2025-11-04-v0', v_signature_svg, now() - interval '70 days',  v_terms_old),
    (pid, 'click_in_veneers', '2025-11-04-v0', v_signature_svg, now() - interval '140 days', v_terms_old),
    (pid, 'click_in_veneers', '2025-11-04-v0', v_signature_svg, now() - interval '270 days', v_terms_old);

  raise notice 'Seeded 20 test waiver signatures for MP-00043.';
end $$;
