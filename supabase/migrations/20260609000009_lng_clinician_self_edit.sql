-- 20260609000009_lng_clinician_self_edit.sql
--
-- Lets a virtual impression clinician edit their OWN availability when an
-- admin has turned it on, without giving them admin access. Editing hours
-- never touches already-booked appointments — those stand regardless; the
-- change only affects which NEW slots are offered going forward.
--
-- Additive; safe to apply any time. Apply: shadow first, then Meridian.

-- ── Flag ──────────────────────────────────────────────────────────
alter table public.lng_staff_members
  add column if not exists clinician_can_edit_own_hours boolean not null default false;

comment on column public.lng_staff_members.clinician_can_edit_own_hours is
  'When true, a virtual impression clinician may edit their own hours/overrides via the lng_*_own_clinician_* RPCs (no admin access needed).';

-- Column-level grants (lng_staff_members uses them — see 20260609000006).
grant select (clinician_can_edit_own_hours) on public.lng_staff_members to authenticated;
grant update (clinician_can_edit_own_hours) on public.lng_staff_members to authenticated;

-- ── Resolve the signed-in clinician (if allowed to self-edit) ─────
create or replace function public.lng_self_edit_clinician_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select sm.id
    from public.lng_staff_members sm
    join public.accounts a on a.id = sm.account_id
   where a.auth_user_id = auth.uid()
     and sm.status = 'active'
     and sm.is_virtual_impression_clinician = true
     and sm.clinician_can_edit_own_hours = true
   limit 1;
$$;
revoke all on function public.lng_self_edit_clinician_id() from public;
grant execute on function public.lng_self_edit_clinician_id() to authenticated;

-- ── Self-edit RPCs ────────────────────────────────────────────────
create or replace function public.lng_set_own_clinician_hours(p_windows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff uuid;
  w jsonb;
begin
  v_staff := public.lng_self_edit_clinician_id();
  if v_staff is null then
    raise exception 'You are not allowed to edit your own availability' using errcode = '42501';
  end if;
  if p_windows is null or jsonb_typeof(p_windows) <> 'array' then
    raise exception 'p_windows must be a jsonb array' using errcode = '22023';
  end if;
  delete from public.lng_clinician_hours where staff_member_id = v_staff;
  for w in select value from jsonb_array_elements(p_windows) loop
    insert into public.lng_clinician_hours (staff_member_id, day_of_week, start_local, end_local)
    values (v_staff, (w->>'day_of_week')::smallint, (w->>'start')::time, (w->>'end')::time);
  end loop;
end;
$$;
revoke all on function public.lng_set_own_clinician_hours(jsonb) from public;
grant execute on function public.lng_set_own_clinician_hours(jsonb) to authenticated;

create or replace function public.lng_add_own_clinician_override(
  p_date        date,
  p_kind        text,
  p_start_local time default null,
  p_end_local   time default null,
  p_note        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff uuid;
  v_id uuid;
begin
  v_staff := public.lng_self_edit_clinician_id();
  if v_staff is null then
    raise exception 'You are not allowed to edit your own availability' using errcode = '42501';
  end if;
  insert into public.lng_clinician_overrides (staff_member_id, override_date, kind, start_local, end_local, note)
  values (v_staff, p_date, p_kind, p_start_local, p_end_local, p_note)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.lng_add_own_clinician_override(date, text, time, time, text) from public;
grant execute on function public.lng_add_own_clinician_override(date, text, time, time, text) to authenticated;

create or replace function public.lng_delete_own_clinician_override(p_override_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff uuid;
begin
  v_staff := public.lng_self_edit_clinician_id();
  if v_staff is null then
    raise exception 'You are not allowed to edit your own availability' using errcode = '42501';
  end if;
  -- Only their own overrides.
  delete from public.lng_clinician_overrides
   where id = p_override_id and staff_member_id = v_staff;
end;
$$;
revoke all on function public.lng_delete_own_clinician_override(uuid) from public;
grant execute on function public.lng_delete_own_clinician_override(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
