-- 20260519000006_lng_end_visit_state_machine.sql
--
-- Atomic state machine for the visit-end / resume-visit flow on the
-- in-clinic VisitDetail page. Replaces three multi-write client
-- orchestrations with three SECURITY DEFINER RPCs so the visit row,
-- the cart_items soft-delete trio, the unsuitability records, and
-- the patient_events audit move together in one transaction.
--
-- ── Why this exists ──────────────────────────────────────────────
-- Pre-existing bug (visible to staff): ending a visit, then resuming
-- it, restored EVERY soft-deleted line on the cart regardless of why
-- it had been removed. Example reported by Dylan:
--
--   1. cart has 10 items
--   2. staff removes 1 line mid-visit (reason='changed_mind', £40
--      refund issued)
--   3. staff ends the visit as unsuitable (the remaining 9 lines
--      soft-deleted)
--   4. staff resumes the visit
--   5. the cart restores 10 items (the original ten) instead of 9
--      — the mid-visit "changed_mind" removal got un-flagged too,
--      breaking the reconciliation with the £40 refund that already
--      moved
--
-- Root cause sits in two places:
--
--   • src/lib/queries/visits.ts :: endVisitEarly() writes
--     removed_reason='changed_mind' on EVERY active line. Collides
--     with the single-line "patient changed mind" removal flow —
--     once both kinds of rows exist on the same cart, no SQL filter
--     can tell them apart.
--
--   • src/lib/queries/visits.ts :: reverseUnsuitability() un-flags
--     every soft-deleted line on the cart with no removed_reason
--     filter at all, so it sweeps up both kinds of rows.
--
-- The fix has two layers:
--
--   • Distinct removed_reason value 'visit_ended_early' for lines
--     removed by the visit-end action. Single-line "changed_mind"
--     removals keep their existing reason.
--
--   • Atomic RPCs that own the multi-step transition so no caller
--     can leave a half-written state (visit terminated but cart
--     not soft-deleted, cart soft-deleted but no patient_events
--     row, etc.) — both forward (end_visit) and reverse (resume).
--
-- ── New contract: what resume restores ───────────────────────────
-- After this migration, lng_reverse_visit_end() restores only lines
-- where removed_reason IN ('unsuitable', 'visit_ended_early'). Lines
-- removed mid-visit for 'mistake' or 'changed_mind' STAY removed —
-- the staff intentionally took them off the cart before the visit
-- ended, and any refunds issued against those removals stay
-- reconciled.
--
-- This deliberately overrides the prior "Reverse really resets this
-- visit, no surprises about which lines come back" comment on
-- visits.ts:1395-1407. Dylan re-evaluated the trade-off when the
-- £40 refund / 10-item-restore mismatch broke a real visit, and
-- chose the new policy explicitly.
--
-- ── State machine summary ────────────────────────────────────────
-- Visit lifecycle (lng_visits.status) — RPC-mediated transitions
-- enforced inside the functions below, NOT just by the check
-- constraint:
--
--   booked → arrived → unsuitable | ended_early
--                    ↘ complete  (different RPC — completeVisit)
--   unsuitable | ended_early → arrived  (via lng_reverse_visit_end)
--
-- Cart-item lifecycle (lng_cart_items.removed_*):
--
--   active (removed_at IS NULL)
--     ── lng_remove_cart_line(mistake|changed_mind|unsuitable) ──▶ removed
--     ── lng_end_visit_early(visit_ended_early) ──────────────────▶ removed
--     ── lng_end_visit_early(unsuitable, picks) ──────────────────▶ removed (only picked)
--   removed (removed_reason IN ('unsuitable','visit_ended_early'))
--     ── lng_reverse_visit_end ──────────────────────────────────▶ active
--   removed (removed_reason IN ('mistake','changed_mind'))
--     ── stays removed under all reverse paths ─────────────────────
--
-- ── Idempotency ──────────────────────────────────────────────────
-- All three RPCs are safe to re-apply (CREATE OR REPLACE FUNCTION).
-- The functions themselves raise on impossible transitions
-- (already-removed line, already-reversed visit, no batch to
-- reverse) rather than silently no-op, so a double-click can't
-- corrupt state — the second call fails loudly.
--
-- ── Apply order (per CLAUDE.md) ──────────────────────────────────
-- Write → shadow (verify) → Meridian. The constraint update is
-- additive (allows an extra value), the data backfill touches 2
-- known legacy rows on Meridian, and the functions are pure
-- CREATE OR REPLACE — no destructive operations.

-- ── 1. Extend the removed_reason check ───────────────────────────
-- Existing constraint pinned the values to ('mistake', 'changed_mind',
-- 'unsuitable'). The new value 'visit_ended_early' tags lines that
-- the visit-end action soft-deleted (the non-unsuitable path) so
-- reverse can pick them up cleanly without colliding with single-
-- line 'changed_mind' removals.

alter table public.lng_cart_items
  drop constraint if exists lng_cart_items_removed_pair_check;

alter table public.lng_cart_items
  add constraint lng_cart_items_removed_pair_check
  check (
    (removed_at is null and removed_reason is null)
    or
    (removed_at is not null
       and removed_reason in ('mistake', 'changed_mind', 'unsuitable', 'visit_ended_early'))
  );

comment on column public.lng_cart_items.removed_reason is
  'Reason category for soft-delete: mistake (staff error), changed_mind (patient declined this line), unsuitable (clinical), visit_ended_early (a visit-end action removed this line as part of the close-out, non-unsuitable path). NULL while the line is active. lng_reverse_visit_end restores only rows whose reason is unsuitable or visit_ended_early.';

-- ── 2. Backfill legacy rows ──────────────────────────────────────
-- Pre-migration, endVisitEarly() wrote 'changed_mind' for the lines
-- it soft-deleted. On Meridian there are two such rows
-- (2026-04-30 17:29:47, cart 914cf8a1) sitting on a visit that's
-- currently in 'ended_early' status. Without the backfill, those
-- rows would stay removed if staff ever reversed that visit — even
-- though they were originally removed BECAUSE the visit ended.
--
-- The backfill is narrow: only rows on visits currently in
-- 'ended_early' status whose removed_reason='changed_mind'. We do
-- NOT touch 'changed_mind' rows on 'arrived' or 'complete' visits
-- because those are genuine mid-visit "patient declined this line"
-- removals.

update public.lng_cart_items ci
  set removed_reason = 'visit_ended_early'
  from public.lng_carts c
  join public.lng_visits v on v.id = c.visit_id
  where ci.cart_id = c.id
    and ci.removed_reason = 'changed_mind'
    and v.status = 'ended_early';

-- ── 3. RPC: lng_remove_cart_line ─────────────────────────────────
-- Single-line removal. Replaces removeCartLineWithReason()'s
-- five-step client orchestration with one transaction. Same external
-- contract:
--
--   reason ∈ ('mistake', 'changed_mind', 'unsuitable')
--   note required for 'unsuitable'
--   catalogue_id required for 'unsuitable' (writes unsuitability_record)
--
-- Termination rule preserved: removing the last active line when at
-- least one unsuitability_record exists on this visit flips the
-- visit to 'unsuitable' atomically.
--
-- Failure modes (raised, not swallowed):
--   • visit not in 'arrived' (terminal state — can't remove from a
--     closed visit; the client locks the cart UI but we guard here
--     too)
--   • line already soft-deleted
--   • line belongs to a different visit (defense in depth)

create or replace function public.lng_remove_cart_line(
  p_cart_item_id   uuid,
  p_visit_id       uuid,
  p_patient_id     uuid,
  p_reason         text,
  p_note           text,
  p_catalogue_id   uuid
)
returns table (visit_terminated boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id     uuid;
  v_cart_id        uuid;
  v_visit_status   text;
  v_line_name      text;
  v_active_count   int;
  v_unsuit_count   int;
  v_trimmed_note   text;
  v_terminated     boolean := false;
begin
  v_account_id   := public.auth_account_id();
  v_trimmed_note := nullif(btrim(coalesce(p_note, '')), '');

  if p_reason not in ('mistake', 'changed_mind', 'unsuitable') then
    raise exception 'Invalid removal reason: %', p_reason using errcode = '22023';
  end if;
  if p_reason = 'unsuitable' and v_trimmed_note is null then
    raise exception 'A reason note is required for unsuitable removals' using errcode = '22023';
  end if;
  if p_reason = 'unsuitable' and p_catalogue_id is null then
    raise exception 'Unsuitable removal requires a catalogue-backed line' using errcode = '22023';
  end if;

  -- Lock the visit row for the transaction so a concurrent
  -- end-visit can't change the status under us.
  select status into v_visit_status
    from public.lng_visits where id = p_visit_id for update;
  if not found then
    raise exception 'Visit % not found', p_visit_id using errcode = 'P0002';
  end if;
  if v_visit_status <> 'arrived' then
    raise exception 'Cannot remove cart lines while visit is in status %', v_visit_status
      using errcode = '22023';
  end if;

  -- Resolve the cart and confirm the line belongs to this visit.
  select c.id into v_cart_id
    from public.lng_carts c
   where c.visit_id = p_visit_id
     for update;
  if not found then
    raise exception 'No cart for visit %', p_visit_id using errcode = 'P0002';
  end if;

  select name into v_line_name
    from public.lng_cart_items
   where id = p_cart_item_id
     and cart_id = v_cart_id
     and removed_at is null
   for update;
  if not found then
    raise exception 'Active cart line % not found on cart %', p_cart_item_id, v_cart_id
      using errcode = 'P0002';
  end if;

  -- Soft-delete.
  update public.lng_cart_items
     set removed_at     = now(),
         removed_reason = p_reason,
         removed_by     = v_account_id,
         removed_note   = v_trimmed_note
   where id = p_cart_item_id;

  -- Unsuitable: write the immutable clinical audit row.
  if p_reason = 'unsuitable' then
    insert into public.lng_unsuitability_records
      (patient_id, visit_id, catalogue_id, reason, recorded_by)
    values
      (p_patient_id, p_visit_id, p_catalogue_id, v_trimmed_note, v_account_id);
  end if;

  -- Timeline event. Mirrors the payload the client used to write so
  -- existing visitTimeline.ts renderers keep working unchanged.
  insert into public.patient_events
    (patient_id, event_type, actor_account_id, notes, payload)
  values
    (p_patient_id,
     'cart_line_removed',
     v_account_id,
     v_trimmed_note,
     jsonb_build_object(
       'visit_id',     p_visit_id,
       'cart_item_id', p_cart_item_id,
       'catalogue_id', p_catalogue_id,
       'line_name',    v_line_name,
       'reason',       p_reason,
       'note',         v_trimmed_note
     ));

  -- Termination rule: cart empty AND at least one unsuitability
  -- record on the visit → flip visit to 'unsuitable'. The triggering
  -- removal's note carries to the visit row as the end-reason note.
  select count(*) into v_active_count
    from public.lng_cart_items
   where cart_id = v_cart_id and removed_at is null;

  if v_active_count = 0 then
    select count(*) into v_unsuit_count
      from public.lng_unsuitability_records
     where visit_id = p_visit_id;

    if v_unsuit_count > 0 then
      -- A note is required by the lng_visits_end_reason_check
      -- constraint when status flips to unsuitable. Use the line-
      -- level note when present; fall back to a fixed string when
      -- staff removed the terminating line as 'mistake' with no
      -- note (rare, but possible — the check would otherwise fail
      -- and the whole transaction would roll back).
      update public.lng_visits
         set status           = 'unsuitable',
             closed_at        = now(),
             visit_end_reason = 'unsuitable',
             visit_end_note   = coalesce(v_trimmed_note, 'Cart emptied with prior unsuitable verdict')
       where id = p_visit_id;
      v_terminated := true;
    end if;
  end if;

  return query select v_terminated;
end;
$$;

revoke all on function public.lng_remove_cart_line(uuid, uuid, uuid, text, text, uuid) from public;
grant execute on function public.lng_remove_cart_line(uuid, uuid, uuid, text, text, uuid) to authenticated;

comment on function public.lng_remove_cart_line(uuid, uuid, uuid, text, text, uuid) is
  'Soft-delete one cart line with reason + note, write the timeline event, and (when the cart goes empty with at least one unsuitability record on the visit) flip the visit to unsuitable. Atomic. Replaces the multi-write removeCartLineWithReason() client function.';

-- ── 4. RPC: lng_end_visit_early ──────────────────────────────────
-- Single atomic entry point for the End-visit-early modal. Replaces
-- the client loop that called removeCartLineWithReason() N times
-- (which left a half-written window if the request died mid-loop).
--
-- Two branches based on p_reason:
--
--   • p_reason = 'unsuitable':
--       p_picks is an array of {cart_item_id, catalogue_id}. Each
--       picked line is soft-deleted with removed_reason='unsuitable'
--       and writes one lng_unsuitability_records row. One
--       'cart_line_removed' patient_events row per picked line
--       preserves the timeline detail the per-item breakdown gave
--       us pre-RPC.
--
--       Visit termination is CONDITIONAL: the visit flips to
--       'unsuitable' only when the picks leave the cart with zero
--       active lines (same rule as removeCartLineWithReason's prior
--       termination check). Partial picks — staff marks some lines
--       unsuitable but leaves others active — keep the visit in
--       'arrived' so they can take payment for the remaining lines.
--       This matches the pre-RPC behaviour where submitEndEarly
--       looped removeCartLineWithReason and only the last call's
--       cart-empty check could flip the visit.
--
--   • p_reason ∈ ('patient_declined','patient_walked_out','wrong_booking','other'):
--       ALL active lines are soft-deleted with
--       removed_reason='visit_ended_early' (the new distinct value
--       that distinguishes them from manual 'changed_mind'
--       removals). Visit ALWAYS flips to 'ended_early' — the
--       non-clinical end-visit reasons are unconditional close-outs.
--
-- A visit-level 'visit_ended_early' patient_events row is written
-- only when the visit actually terminates (so the timeline's
-- "Visit ended early" entry doesn't appear for partial unsuitable
-- picks that left the visit open).

create or replace function public.lng_end_visit_early(
  p_visit_id    uuid,
  p_patient_id  uuid,
  p_reason      text,
  p_note        text,
  p_picks       jsonb default '[]'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id     uuid;
  v_cart_id        uuid;
  v_visit_status   text;
  v_trimmed_note   text;
  v_pick           jsonb;
  v_pick_item_id   uuid;
  v_pick_cat_id    uuid;
  v_pick_name      text;
  v_active_count   int;
  v_terminate      boolean;
begin
  v_account_id   := public.auth_account_id();
  v_trimmed_note := nullif(btrim(coalesce(p_note, '')), '');

  if p_reason not in ('unsuitable','patient_declined','patient_walked_out','wrong_booking','other') then
    raise exception 'Invalid end-visit reason: %', p_reason using errcode = '22023';
  end if;
  if v_trimmed_note is null then
    raise exception 'A reason note is required to end the visit early' using errcode = '22023';
  end if;
  if p_reason = 'unsuitable' and (p_picks is null or jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) = 0) then
    raise exception 'Unsuitable end-visit requires at least one picked line' using errcode = '22023';
  end if;

  -- Lock the visit row for the duration of the transaction so a
  -- concurrent remove-line / end-visit can't race.
  select status into v_visit_status from public.lng_visits where id = p_visit_id for update;
  if not found then
    raise exception 'Visit % not found', p_visit_id using errcode = 'P0002';
  end if;
  if v_visit_status <> 'arrived' then
    raise exception 'Visit % is in status % — cannot end-early from this state', p_visit_id, v_visit_status
      using errcode = '22023';
  end if;

  -- Resolve the cart. The end-visit modal is reachable on
  -- empty-cart visits (non-unsuitable branch); cart_id may be NULL
  -- if no line was ever added — in that case the unsuitable branch
  -- has nothing to pick from and the validation above would already
  -- have rejected the call.
  select id into v_cart_id from public.lng_carts where visit_id = p_visit_id for update;

  if p_reason = 'unsuitable' then
    -- Walk the picks. Each one: soft-delete the line, write the
    -- unsuitability record, write the per-line cart_line_removed
    -- event so the timeline keeps the per-item rows it has today.
    for v_pick in select * from jsonb_array_elements(p_picks) loop
      v_pick_item_id := nullif(v_pick->>'cart_item_id','')::uuid;
      v_pick_cat_id  := nullif(v_pick->>'catalogue_id','')::uuid;
      if v_pick_item_id is null then
        raise exception 'Pick missing cart_item_id: %', v_pick using errcode = '22023';
      end if;
      if v_pick_cat_id is null then
        raise exception 'Pick missing catalogue_id (cart_item_id %): unsuitable removals need a catalogue-backed line', v_pick_item_id using errcode = '22023';
      end if;

      select name into v_pick_name
        from public.lng_cart_items
       where id = v_pick_item_id
         and cart_id = v_cart_id
         and removed_at is null
       for update;
      if not found then
        raise exception 'Active cart line % not found on cart %', v_pick_item_id, v_cart_id
          using errcode = 'P0002';
      end if;

      update public.lng_cart_items
         set removed_at     = now(),
             removed_reason = 'unsuitable',
             removed_by     = v_account_id,
             removed_note   = v_trimmed_note
       where id = v_pick_item_id;

      insert into public.lng_unsuitability_records
        (patient_id, visit_id, catalogue_id, reason, recorded_by)
      values
        (p_patient_id, p_visit_id, v_pick_cat_id, v_trimmed_note, v_account_id);

      insert into public.patient_events
        (patient_id, event_type, actor_account_id, notes, payload)
      values
        (p_patient_id, 'cart_line_removed', v_account_id, v_trimmed_note,
         jsonb_build_object(
           'visit_id',     p_visit_id,
           'cart_item_id', v_pick_item_id,
           'catalogue_id', v_pick_cat_id,
           'line_name',    v_pick_name,
           'reason',       'unsuitable',
           'note',         v_trimmed_note
         ));
    end loop;

    -- Conditional termination: only when the cart is now empty.
    -- Partial picks keep the visit alive so staff can take payment
    -- for the remaining lines. v_active_count = 0 is sufficient —
    -- we just inserted at least one unsuitability record above so
    -- the "has any unsuitability record" half of the rule is true
    -- by construction.
    select count(*) into v_active_count
      from public.lng_cart_items
     where cart_id = v_cart_id and removed_at is null;

    v_terminate := (v_active_count = 0);

    if v_terminate then
      update public.lng_visits
         set status           = 'unsuitable',
             closed_at        = now(),
             visit_end_reason = 'unsuitable',
             visit_end_note   = v_trimmed_note
       where id = p_visit_id;
    end if;

  else
    -- Non-unsuitable end-visit reasons unconditionally close out:
    -- soft-delete every active line with removed_reason=
    -- 'visit_ended_early' (the new distinct value), flip the visit
    -- to 'ended_early'. No per-line patient_events rows — the
    -- single visit-level event below covers the timeline entry.
    if v_cart_id is not null then
      update public.lng_cart_items
         set removed_at     = now(),
             removed_reason = 'visit_ended_early',
             removed_by     = v_account_id,
             removed_note   = v_trimmed_note
       where cart_id = v_cart_id
         and removed_at is null;
    end if;

    update public.lng_visits
       set status           = 'ended_early',
           closed_at        = now(),
           visit_end_reason = p_reason,
           visit_end_note   = v_trimmed_note
     where id = p_visit_id;

    v_terminate := true;
  end if;

  -- Visit-level audit event only when the visit actually
  -- terminated. Payload mirrors what endVisitEarly() used to write
  -- so visitTimeline.ts's case 'visit_ended_early' renderer keeps
  -- reading from the same fields. Partial unsuitable picks that
  -- don't end the visit skip this event — the per-line
  -- cart_line_removed rows already carry the audit.
  if v_terminate then
    insert into public.patient_events
      (patient_id, event_type, actor_account_id, notes, payload)
    values
      (p_patient_id, 'visit_ended_early', v_account_id, v_trimmed_note,
       jsonb_build_object(
         'visit_id',         p_visit_id,
         'reason',           p_reason,
         'note',             v_trimmed_note,
         'staff_account_id', v_account_id
       ));
  end if;
end;
$$;

revoke all on function public.lng_end_visit_early(uuid, uuid, text, text, jsonb) from public;
grant execute on function public.lng_end_visit_early(uuid, uuid, text, text, jsonb) to authenticated;

comment on function public.lng_end_visit_early(uuid, uuid, text, text, jsonb) is
  'Atomic End-visit-early. p_reason=unsuitable picks individual items; everything else removes all active cart lines (with removed_reason=visit_ended_early). Flips lng_visits.status, writes patient_events. Replaces the multi-call client orchestration in submitEndEarly().';

-- ── 5. RPC: lng_reverse_visit_end ────────────────────────────────
-- Restores items removed by the visit-end action and reopens the
-- visit. The contract reset:
--
--   Restores lng_cart_items where removed_reason IN
--     ('unsuitable', 'visit_ended_early')
--   on this visit's cart. Mid-visit 'mistake' and 'changed_mind'
--   removals stay removed — their refunds (if any) already moved
--   money out the door and shouldn't be re-debited by an unrelated
--   verdict reversal.
--
-- lng_unsuitability_records are never deleted — they're immutable
-- clinical audit. The reversed verdict gets a visit-level event so
-- the timeline shows "Unsuitable reversed" + reason note.

create or replace function public.lng_reverse_visit_end(
  p_visit_id    uuid,
  p_patient_id  uuid,
  p_note        text default null
)
returns table (restored_count int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id    uuid;
  v_cart_id       uuid;
  v_visit_status  text;
  v_trimmed_note  text;
  v_restored      int := 0;
begin
  v_account_id   := public.auth_account_id();
  v_trimmed_note := nullif(btrim(coalesce(p_note, '')), '');

  select status into v_visit_status from public.lng_visits where id = p_visit_id for update;
  if not found then
    raise exception 'Visit % not found', p_visit_id using errcode = 'P0002';
  end if;
  if v_visit_status not in ('unsuitable', 'ended_early') then
    raise exception 'Visit % is in status % — only unsuitable or ended_early visits can be resumed', p_visit_id, v_visit_status
      using errcode = '22023';
  end if;

  select id into v_cart_id from public.lng_carts where visit_id = p_visit_id for update;

  if v_cart_id is not null then
    update public.lng_cart_items
       set removed_at     = null,
           removed_reason = null,
           removed_by     = null,
           removed_note   = null
     where cart_id = v_cart_id
       and removed_at is not null
       and removed_reason in ('unsuitable', 'visit_ended_early');
    get diagnostics v_restored = row_count;
  end if;

  -- Reopen the visit. The pre-termination live state is 'arrived'
  -- (in_chair was retired in 20260430000009).
  update public.lng_visits
     set status           = 'arrived',
         closed_at        = null,
         visit_end_reason = null,
         visit_end_note   = null
   where id = p_visit_id;

  insert into public.patient_events
    (patient_id, event_type, actor_account_id, notes, payload)
  values
    (p_patient_id, 'patient_unsuitable_reversed', v_account_id, v_trimmed_note,
     jsonb_build_object(
       'visit_id',         p_visit_id,
       'staff_account_id', v_account_id,
       'restored_count',   v_restored,
       'note',             v_trimmed_note
     ));

  return query select v_restored;
end;
$$;

revoke all on function public.lng_reverse_visit_end(uuid, uuid, text) from public;
grant execute on function public.lng_reverse_visit_end(uuid, uuid, text) to authenticated;

comment on function public.lng_reverse_visit_end(uuid, uuid, text) is
  'Reverse an unsuitable or ended-early visit. Restores cart lines where removed_reason IN (unsuitable, visit_ended_early); leaves mistake / changed_mind removals as-is so issued refunds stay reconciled. Flips visit back to arrived. Atomic.';

-- ── Rollback ─────────────────────────────────────────────────────
-- drop function if exists public.lng_reverse_visit_end(uuid, uuid, text);
-- drop function if exists public.lng_end_visit_early(uuid, uuid, text, text, jsonb);
-- drop function if exists public.lng_remove_cart_line(uuid, uuid, uuid, text, text, uuid);
-- alter table public.lng_cart_items
--   drop constraint if exists lng_cart_items_removed_pair_check;
-- alter table public.lng_cart_items
--   add constraint lng_cart_items_removed_pair_check
--   check (
--     (removed_at is null and removed_reason is null)
--     or
--     (removed_at is not null and removed_reason in ('mistake','changed_mind','unsuitable'))
--   );
-- -- Reverse the backfill (only if no NEW visit_ended_early rows have been written):
-- update public.lng_cart_items ci
--   set removed_reason = 'changed_mind'
--   from public.lng_carts c, public.lng_visits v
--   where ci.cart_id = c.id and v.id = c.visit_id
--     and ci.removed_reason = 'visit_ended_early'
--     and v.status = 'ended_early';
