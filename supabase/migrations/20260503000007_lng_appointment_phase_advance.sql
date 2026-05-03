-- 20260503000007_lng_appointment_phase_advance.sql
--
-- Receptionist-driven status transitions on lng_appointment_phases.
-- The schedule grid + appointment-detail timeline call this RPC when
-- the receptionist taps "Mark patient may leave" / "Mark ready for
-- collection". Server-side enforces forward-only — once a phase is
-- complete or skipped, it can't be reopened from this RPC.
--
-- ── Allowed transitions ──────────────────────────────────────────
-- pending      → in_progress | complete | skipped
-- in_progress  → complete    | skipped
-- complete     → (none — terminal)
-- skipped      → (none — terminal)
--
-- Idempotent on no-op: calling with the current status returns
-- silently and does not log a duplicate event.
--
-- ── SECURITY DEFINER ─────────────────────────────────────────────
-- Same justification as lng_materialise_appointment_phases — the
-- caller is a receptionist whose role can't write lng_appointment_
-- phases directly per its admin-write policy. The function runs as
-- the table owner and writes on the user's behalf. Search_path is
-- pinned to public to neutralise the standard SECURITY DEFINER
-- attack surface.
--
-- ── Idempotency ──────────────────────────────────────────────────
-- CREATE OR REPLACE FUNCTION. Safe to re-apply.

create or replace function public.lng_appointment_phase_advance(
  p_appointment_id uuid,
  p_phase_index    int,
  p_to_status      text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
begin
  if p_to_status not in ('pending', 'in_progress', 'complete', 'skipped') then
    raise exception 'Invalid target status: %', p_to_status
      using errcode = '22023';
  end if;

  select status into current_status
    from public.lng_appointment_phases
   where appointment_id = p_appointment_id
     and phase_index    = p_phase_index;

  if not found then
    raise exception 'Phase % not found for appointment %',
      p_phase_index, p_appointment_id
      using errcode = 'P0002';
  end if;

  -- No-op: already in target.
  if current_status = p_to_status then
    return;
  end if;

  -- Forward-only: terminal statuses are sticky.
  if current_status in ('complete', 'skipped') then
    raise exception
      'Cannot advance phase from terminal status: %',
      current_status
      using errcode = '22023';
  end if;

  -- pending may go to in_progress, complete, or skipped.
  -- in_progress may go to complete or skipped.
  if current_status = 'pending'
     and p_to_status not in ('in_progress', 'complete', 'skipped') then
    raise exception
      'Invalid transition from pending to %', p_to_status
      using errcode = '22023';
  end if;

  if current_status = 'in_progress'
     and p_to_status not in ('complete', 'skipped') then
    raise exception
      'Invalid transition from in_progress to %', p_to_status
      using errcode = '22023';
  end if;

  update public.lng_appointment_phases
     set status     = p_to_status,
         updated_at = now()
   where appointment_id = p_appointment_id
     and phase_index    = p_phase_index;

  -- Loud log per CLAUDE.md "failures must be loud" — every state
  -- change leaves a trail the admin can audit.
  insert into public.lng_event_log (source, event_type, payload, account_id)
  values (
    'lng_appointment_phase_advance',
    'appointment_phase_advanced',
    jsonb_build_object(
      'appointment_id', p_appointment_id,
      'phase_index',    p_phase_index,
      'from_status',    current_status,
      'to_status',      p_to_status
    ),
    public.auth_account_id()
  );
end;
$$;

revoke all on function public.lng_appointment_phase_advance(uuid, int, text) from public;
grant execute on function public.lng_appointment_phase_advance(uuid, int, text) to authenticated;

comment on function public.lng_appointment_phase_advance(uuid, int, text) is
  'Receptionist-driven status transition on lng_appointment_phases. Forward-only — pending → in_progress → complete (or skipped at any point). Logs to lng_event_log on every transition. SECURITY DEFINER so receptionists can advance without admin rights. Idempotent on no-op.';

-- ── Rollback ─────────────────────────────────────────────────────
-- drop function if exists public.lng_appointment_phase_advance(uuid, int, text);
