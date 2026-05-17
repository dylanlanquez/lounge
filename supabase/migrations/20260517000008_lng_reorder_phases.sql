-- 20260517000008_lng_reorder_phases.sql
--
-- Two RPCs to support drag-and-drop reordering on the Booking Types
-- editor's phase ribbons:
--
--   1. lng_reorder_booking_type_phases(config_id, ordered_phase_ids)
--      Atomic renumber WITHIN a single config row. Used for the
--      PARENT ribbon — every phase already belongs to the parent
--      config, so the operation is a pure pivot of phase_index.
--
--   2. lng_reorder_child_phases(child_config_id, ordered_entries)
--      Wipe-and-rewrite the OVERRIDE ribbon's phases. The client
--      sends the full effective ordered shape (parent-inherited
--      phases materialised into the payload) and we rebuild the
--      child config's phase rows from scratch. Snapshots the
--      patient-required / durations / pool_ids the user is looking
--      at on the ribbon so future parent edits no longer leak
--      through at the reordered indices. The caller is responsible
--      for surfacing this divergence in the UI.
--
-- Both RPCs use the negative-offset shuffle to side-step the unique
-- (config_id, phase_index) index during the renumber. Pool rows are
-- re-attached fresh on the override path.
--
-- Safe to re-run: CREATE OR REPLACE on both functions; no schema
-- changes.
-- ─────────────────────────────────────────────────────────────────

-- ── 1. Parent / pure-child renumber ──────────────────────────────

create or replace function public.lng_reorder_booking_type_phases(
  p_config_id        uuid,
  p_ordered_phase_ids uuid[]
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  n        int;
  existing int;
begin
  if p_config_id is null or p_ordered_phase_ids is null then
    raise exception 'config_id and ordered_phase_ids are required';
  end if;

  n := array_length(p_ordered_phase_ids, 1);
  select count(*) into existing
    from public.lng_booking_type_phases
   where config_id = p_config_id;

  if n is null or n <> existing then
    raise exception
      'reorder: ordered_phase_ids has % entries, config has % phase rows',
      coalesce(n, 0), existing;
  end if;

  -- Step 1: shift every phase on this config into negative-index
  -- space. Avoids hitting the unique (config_id, phase_index) index
  -- mid-renumber when the new indices overlap the old ones.
  update public.lng_booking_type_phases
     set phase_index = -phase_index
   where config_id = p_config_id;

  -- Step 2: assign new positive indices from the supplied order.
  -- WITH ORDINALITY is 1-based.
  with new_order as (
    select id, ord::int as new_index
      from unnest(p_ordered_phase_ids) with ordinality as t(id, ord)
  )
  update public.lng_booking_type_phases p
     set phase_index = no.new_index,
         updated_at  = now()
    from new_order no
   where p.id        = no.id
     and p.config_id = p_config_id;

  -- Step 3: defensive — every row should now have a positive index.
  -- Anything still negative means the caller omitted a phase id.
  if exists (
    select 1 from public.lng_booking_type_phases
     where config_id = p_config_id and phase_index < 0
  ) then
    raise exception
      'reorder: % was not included in ordered_phase_ids',
      (select array_agg(id) from public.lng_booking_type_phases
        where config_id = p_config_id and phase_index < 0);
  end if;
end;
$$;

grant execute on function public.lng_reorder_booking_type_phases(uuid, uuid[])
  to authenticated;

comment on function public.lng_reorder_booking_type_phases(uuid, uuid[]) is
  'Atomic renumber of all phases on a single booking_type_config row. Pass every phase id belonging to the config in the desired order; new indices are 1..N derived from array position. Used by the Booking Types editor''s parent ribbon drag-and-drop. ADR-006 + M17.';

-- ── 2. Override-ribbon wipe-and-rewrite ──────────────────────────

create or replace function public.lng_reorder_child_phases(
  p_child_config_id uuid,
  p_ordered_entries jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  entry        jsonb;
  new_idx      int := 0;
  inserted_id  uuid;
  pool_text    text;
begin
  if p_child_config_id is null or p_ordered_entries is null then
    raise exception 'child_config_id and ordered_entries are required';
  end if;

  if jsonb_typeof(p_ordered_entries) <> 'array' then
    raise exception 'ordered_entries must be a jsonb array, got %',
      jsonb_typeof(p_ordered_entries);
  end if;

  -- Wipe existing child phase rows + their pool junction rows. The
  -- new payload is the full effective shape, so anything still
  -- around belongs to the OLD order and must go.
  delete from public.lng_booking_type_phase_pools
   where phase_id in (
     select id from public.lng_booking_type_phases
      where config_id = p_child_config_id
   );
  delete from public.lng_booking_type_phases
   where config_id = p_child_config_id;

  -- Insert fresh rows in array order. Each entry is a full phase
  -- spec (label / patient_required / durations / pool_ids). Indices
  -- come from ordinality (1-based).
  for entry in select * from jsonb_array_elements(p_ordered_entries)
  loop
    new_idx := new_idx + 1;

    insert into public.lng_booking_type_phases (
      config_id,
      phase_index,
      label,
      patient_required,
      duration_min,
      duration_max,
      duration_default
    ) values (
      p_child_config_id,
      new_idx,
      coalesce(entry->>'label', 'Phase'),
      coalesce((entry->>'patient_required')::boolean, true),
      nullif(entry->>'duration_min', '')::int,
      nullif(entry->>'duration_max', '')::int,
      nullif(entry->>'duration_default', '')::int
    )
    returning id into inserted_id;

    -- Re-attach pools. coalesce to empty array so a phase with no
    -- pools is a no-op loop, not a null-cast error.
    for pool_text in
      select value
        from jsonb_array_elements_text(coalesce(entry->'pool_ids', '[]'::jsonb))
    loop
      insert into public.lng_booking_type_phase_pools (phase_id, pool_id)
      values (inserted_id, pool_text)
      on conflict do nothing;
    end loop;
  end loop;
end;
$$;

grant execute on function public.lng_reorder_child_phases(uuid, jsonb)
  to authenticated;

comment on function public.lng_reorder_child_phases(uuid, jsonb) is
  'Wipe-and-rewrite the phase rows on a child booking_type_config (override). Each entry in ordered_entries is {label, patient_required, duration_*, pool_ids} — phase_index is derived from array position. Used by the Booking Types editor''s override ribbon drag-and-drop, which snapshots the effective parent + child shape into the payload so the new order materialises fully. After this call the override no longer inherits any phase fields from the parent at its declared indices. ADR-006 + M17.';
