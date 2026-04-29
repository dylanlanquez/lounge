-- 20260429000007_lng_seed_test_visits_cases_mp00043.sql
--
-- Test-data seed only. Inflates the patient at internal_ref='MP-00043'
-- with ~20 visits and ~15 cases so the new pagination on the patient
-- profile (10 per page) is visible without manual setup.
--
-- Idempotent: each block guards on existing counts. Re-running on an
-- already-seeded patient is a no-op.
--
-- The visits seed uses lng_walk_ins → lng_visits (the constraint
-- requires exactly one of appointment_id / walk_in_id, and walk_in
-- creation requires no other dependent rows). The cases seed picks an
-- arbitrary case_type and submitter account from the existing tables —
-- if either is missing on a given Meridian deploy, the seed skips that
-- block rather than failing the whole migration.

-- ── Visits seed ─────────────────────────────────────────────────────────────
do $$
declare
  pid uuid;
  loc uuid;
  existing int;
  i int;
  walk_in_id uuid;
  service_types text[] := array['denture_repair', 'same_day_appliance', 'click_in_veneers', 'impression_appointment', 'other'];
  statuses text[] := array['complete', 'complete', 'complete', 'complete', 'cancelled'];
begin
  select id, location_id into pid, loc from public.patients where internal_ref = 'MP-00043' limit 1;
  if pid is null then
    raise notice 'No patient with internal_ref MP-00043; skipping visit seed.';
    return;
  end if;
  if loc is null then
    raise notice 'Patient MP-00043 has no location_id; skipping visit seed.';
    return;
  end if;

  select count(*) into existing from public.lng_visits where patient_id = pid;
  if existing >= 5 then
    raise notice 'Patient MP-00043 already has % visits; skipping visit seed.', existing;
    return;
  end if;

  for i in 1..20 loop
    insert into public.lng_walk_ins (patient_id, location_id, service_type, created_at)
      values (pid, loc, service_types[((i - 1) % array_length(service_types, 1)) + 1], now() - (i * interval '7 days'))
      returning id into walk_in_id;

    insert into public.lng_visits (patient_id, location_id, walk_in_id, status, arrival_type, opened_at, closed_at)
      values (
        pid,
        loc,
        walk_in_id,
        statuses[((i - 1) % array_length(statuses, 1)) + 1],
        'walk_in',
        now() - (i * interval '7 days'),
        case when statuses[((i - 1) % array_length(statuses, 1)) + 1] = 'complete'
             then now() - (i * interval '7 days') + interval '90 minutes'
             else null end
      );
  end loop;

  raise notice 'Seeded 20 test visits for MP-00043.';
end $$;

-- ── Cases seed ──────────────────────────────────────────────────────────────
do $$
declare
  pid uuid;
  existing int;
  i int;
  v_case_type_id uuid;
  v_submitter uuid;
  v_terminal_stage text;
  v_active_stage text;
  v_stage text;
  v_completed_at timestamptz;
begin
  select id into pid from public.patients where internal_ref = 'MP-00043' limit 1;
  if pid is null then
    raise notice 'No patient with internal_ref MP-00043; skipping case seed.';
    return;
  end if;

  select count(*) into existing from public.cases where patient_id = pid;
  if existing >= 5 then
    raise notice 'Patient MP-00043 already has % cases; skipping case seed.', existing;
    return;
  end if;

  -- Pick an arbitrary case_type and a submitter account. If the
  -- Meridian deploy doesn't have these populated yet, skip silently
  -- rather than fail the migration.
  select id into v_case_type_id from public.case_types order by created_at limit 1;
  if v_case_type_id is null then
    raise notice 'No case_types rows; skipping case seed.';
    return;
  end if;

  select id into v_submitter from public.accounts order by created_at limit 1;
  if v_submitter is null then
    raise notice 'No accounts rows; skipping case seed.';
    return;
  end if;

  -- Pick stage keys for variety. Falls back to 'case_created' if a
  -- terminal stage isn't available.
  select key into v_terminal_stage from public.case_stages where is_terminal = true order by sort_order limit 1;
  v_active_stage := 'case_created';
  if v_terminal_stage is null then
    v_terminal_stage := v_active_stage;
  end if;

  for i in 1..15 loop
    -- Mark every third case as completed for visual variety in the
    -- bucketed Case history view.
    if i % 3 = 0 then
      v_stage := v_terminal_stage;
      v_completed_at := now() - (i * interval '14 days') + interval '21 days';
    else
      v_stage := v_active_stage;
      v_completed_at := null;
    end if;

    insert into public.cases (
      case_reference,
      submitter_account_id,
      patient_id,
      case_type_id,
      stage_key,
      case_notes,
      created_at,
      completed_at
    ) values (
      'TEST-MP00043-' || lpad(i::text, 3, '0'),
      v_submitter,
      pid,
      v_case_type_id,
      v_stage,
      'Test case for pagination demo. Patient MP-00043, sequence ' || i || '.',
      now() - (i * interval '14 days'),
      v_completed_at
    )
    on conflict (case_reference) do nothing;
  end loop;

  raise notice 'Seeded up to 15 test cases for MP-00043.';
end $$;
