-- Merge duplicate patient records.
--
-- Background — see the investigation notes attached to commit
-- "patient profile: ..." (12 May 2026). Meridian's patients table carries
-- a per-location case-insensitive unique index on email, which means the
-- same real-world person can have two rows when they walk in at the
-- practice location AND exist as a Shopify customer at the lab location
-- (mrd_app_settings.customer_portal_location_id). Today there is one
-- such pair on Meridian (Dylan Lane / James Dylanor sharing
-- dylan@lanquez.com), but the population will grow as Lounge walk-ins
-- overlap with venneir.com sign-ups.
--
-- Dylan's direction (12 May 2026): patients are one company-wide entity,
-- so cross-location duplicates must be merged. Shopify is the source of
-- truth for identity (name, email, phone, shipping); Meridian's clinical
-- data (patient_files, waivers, cases, etc) is preserved on the
-- canonical row via FK reassignment.
--
-- This migration adds two pieces:
--
--   1. lng_find_duplicate_patient_emails()
--      Returns the current dup groups so the admin tool can surface them.
--      Email-only for now — phone-tail and name+DOB matches are weaker
--      signals that need human review before merging.
--
--   2. lng_merge_patients(canonical_id, duplicate_id)
--      The merge engine itself. SECURITY DEFINER (bypasses RLS so it can
--      reassign FKs the caller's role might not see), gated on is_admin()
--      inside the function body. Reassigns every FK that references
--      patients.id (15 tables today; the list lives inline so adding a
--      new patient-scoped table prompts a deliberate edit), fill-blanks
--      merges identity fields onto the canonical, audit-logs the move,
--      then deletes the duplicate row.
--
-- The function is intentionally narrow — it merges ONE pair per call
-- and is the only sanctioned path to delete a patients row. Bulk merges
-- are orchestrated by an admin tool invoking this per pair, so each
-- merge stays auditable.

-- ── 1. Duplicate finder ──────────────────────────────────────────────────

create or replace function public.lng_find_duplicate_patient_emails()
returns table (
  email                text,
  group_size           int,
  patient_ids          uuid[],
  internal_refs        text[],
  shopify_ids          text[],
  location_ids         uuid[],
  shopify_order_counts int[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
-- plpgsql so the embedded query (which references shopify_order_count,
-- added by Meridian migration 20260512_17) is parsed lazily. Shadow
-- doesn't carry the column today, but Lounge always runs against
-- Meridian so first call against shadow never happens.
begin
  return query
  with groups as (
    select lower(trim(p.email)) as email_norm,
           array_agg(p.id order by (p.shopify_customer_id is not null) desc, p.created_at) as ids,
           array_agg(p.internal_ref order by (p.shopify_customer_id is not null) desc, p.created_at) as refs,
           array_agg(coalesce(p.shopify_customer_id, '') order by (p.shopify_customer_id is not null) desc, p.created_at) as scids,
           array_agg(p.location_id order by (p.shopify_customer_id is not null) desc, p.created_at) as locs,
           array_agg(coalesce(p.shopify_order_count, 0) order by (p.shopify_customer_id is not null) desc, p.created_at) as oc,
           count(*) as n
      from public.patients p
     where p.email is not null and trim(p.email) <> ''
     group by 1
    having count(*) > 1
  )
  select email_norm, n::int, ids, refs, scids, locs, oc
    from groups
    order by n desc, email_norm;
end;
$$;

grant execute on function public.lng_find_duplicate_patient_emails()
  to authenticated, service_role;

comment on function public.lng_find_duplicate_patient_emails() is
  'Returns patient rows that share an email across locations. Used by the Lounge admin Duplicates tool to surface merge candidates. The first id in each group is the Shopify-linked row when one exists — preferred canonical.';


-- ── 2. Merge engine ──────────────────────────────────────────────────────

create or replace function public.lng_merge_patients(
  p_canonical_id  uuid,
  p_duplicate_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_canonical public.patients%rowtype;
  v_duplicate public.patients%rowtype;
  v_moved jsonb := '{}'::jsonb;
  v_count int;
begin
  -- Admin-only. Merging mutates clinical history and deletes a
  -- patients row — that's a destructive operation in every sense.
  if not public.is_admin() then
    raise exception 'lng_merge_patients: admin role required';
  end if;

  if p_canonical_id is null or p_duplicate_id is null then
    raise exception 'lng_merge_patients: canonical and duplicate ids required';
  end if;
  if p_canonical_id = p_duplicate_id then
    raise exception 'lng_merge_patients: canonical and duplicate must differ';
  end if;

  -- Lock both rows up front. If either has been deleted between
  -- the admin UI's read and the call, the merge aborts cleanly.
  select * into v_canonical from public.patients
    where id = p_canonical_id for update;
  if not found then
    raise exception 'lng_merge_patients: canonical % not found', p_canonical_id;
  end if;
  select * into v_duplicate from public.patients
    where id = p_duplicate_id for update;
  if not found then
    raise exception 'lng_merge_patients: duplicate % not found', p_duplicate_id;
  end if;

  -- ── FK reassignment ────────────────────────────────────────────────
  -- Each table that references patients.id gets its rows pointed at
  -- the canonical patient. Adding a new patient-scoped table without
  -- updating this list silently strands rows on the deleted row, so
  -- the list is intentionally explicit. v_moved records counts for
  -- the audit row at the end.

  update public.cases set patient_id = p_canonical_id
    where patient_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('cases', v_count);

  update public.production_cases set patient_id = p_canonical_id
    where patient_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('production_cases', v_count);

  update public.patient_files set patient_id = p_canonical_id
    where patient_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('patient_files', v_count);

  update public.patient_events set patient_id = p_canonical_id
    where patient_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('patient_events', v_count);

  update public.patient_pinned_versions set patient_id = p_canonical_id
    where patient_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('patient_pinned_versions', v_count);

  update public.customer_preview_presets set patient_id = p_canonical_id
    where patient_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('customer_preview_presets', v_count);

  update public.customer_push_tokens set patient_id = p_canonical_id
    where patient_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('customer_push_tokens', v_count);

  update public.portal_audit_log set patient_id = p_canonical_id
    where patient_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('portal_audit_log', v_count);

  update public.smile_designs set patient_id = p_canonical_id
    where patient_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('smile_designs', v_count);

  -- Lounge-side tables.
  update public.lng_visits set patient_id = p_canonical_id
    where patient_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('lng_visits', v_count);

  update public.lng_appointments set patient_id = p_canonical_id
    where patient_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('lng_appointments', v_count);

  update public.lng_walk_ins set patient_id = p_canonical_id
    where patient_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('lng_walk_ins', v_count);

  update public.lng_waiver_signatures set patient_id = p_canonical_id
    where patient_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('lng_waiver_signatures', v_count);

  update public.lng_unsuitability_records set patient_id = p_canonical_id
    where patient_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('lng_unsuitability_records', v_count);

  update public.lng_email_messages set patient_id = p_canonical_id
    where patient_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('lng_email_messages', v_count);

  -- ── Identity fill-blanks ───────────────────────────────────────────
  -- Shopify is the source of truth (Dylan, 12 May 2026), so the
  -- canonical row's non-null/non-blank identity wins. The duplicate
  -- only supplies values where the canonical is missing — typically
  -- clinical-side fields populated at walk-in (date_of_birth, sex,
  -- emergency contact, allergies, notes) that the customer-portal
  -- signup never collected.

  update public.patients set
    date_of_birth = coalesce(v_canonical.date_of_birth, v_duplicate.date_of_birth),
    sex = coalesce(nullif(trim(v_canonical.sex), ''), v_duplicate.sex),
    allergies = coalesce(nullif(trim(v_canonical.allergies), ''), v_duplicate.allergies),
    communication_preferences = coalesce(
      nullif(trim(v_canonical.communication_preferences), ''),
      v_duplicate.communication_preferences
    ),
    notes = coalesce(nullif(trim(v_canonical.notes), ''), v_duplicate.notes),
    avatar_data = coalesce(nullif(trim(v_canonical.avatar_data), ''), v_duplicate.avatar_data),
    emergency_contact_name = coalesce(
      nullif(trim(v_canonical.emergency_contact_name), ''),
      v_duplicate.emergency_contact_name
    ),
    emergency_contact_phone = coalesce(
      nullif(trim(v_canonical.emergency_contact_phone), ''),
      v_duplicate.emergency_contact_phone
    ),
    address = coalesce(nullif(trim(v_canonical.address), ''), v_duplicate.address),
    -- lwo_ref is patient-level and immutable once set; if canonical
    -- never had one, the duplicate's reference moves over. The
    -- patients_guard_lwo_ref trigger only blocks REWRITES of a non-null
    -- value, so this null-to-value path is allowed.
    lwo_ref = coalesce(v_canonical.lwo_ref, v_duplicate.lwo_ref),
    -- registered_at: take the earliest known registration so the
    -- profile reflects how long we've actually had this patient.
    registered_at = case
      when v_canonical.registered_at is null then v_duplicate.registered_at
      when v_duplicate.registered_at is null then v_canonical.registered_at
      when v_duplicate.registered_at < v_canonical.registered_at then v_duplicate.registered_at
      else v_canonical.registered_at
    end
  where id = p_canonical_id;

  -- ── Audit + delete ─────────────────────────────────────────────────
  insert into public.lng_event_log (source, event_type, payload)
  values (
    'lng_merge_patients',
    'patient_merged',
    jsonb_build_object(
      'canonical_id', p_canonical_id,
      'canonical_ref', v_canonical.internal_ref,
      'duplicate_id', p_duplicate_id,
      'duplicate_ref', v_duplicate.internal_ref,
      'canonical_location_id', v_canonical.location_id,
      'duplicate_location_id', v_duplicate.location_id,
      'shopify_customer_id', v_canonical.shopify_customer_id,
      'fk_rows_moved', v_moved
    )
  );

  delete from public.patients where id = p_duplicate_id;

  return jsonb_build_object(
    'ok', true,
    'canonical_id', p_canonical_id,
    'duplicate_id', p_duplicate_id,
    'fk_rows_moved', v_moved
  );
end;
$$;

grant execute on function public.lng_merge_patients(uuid, uuid)
  to authenticated, service_role;

comment on function public.lng_merge_patients(uuid, uuid) is
  'Merges the duplicate patient row into the canonical row. Reassigns all 15 patient-FK tables, fill-blanks-merges identity fields (Shopify canonical wins), audit-logs the merge, and deletes the duplicate. Admin-only (gated inside the function).';

NOTIFY pgrst, 'reload schema';
