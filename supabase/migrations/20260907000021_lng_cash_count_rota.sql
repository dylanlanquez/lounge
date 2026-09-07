-- 20260907000021_lng_cash_count_rota.sql
--
-- Who counts the safe, and when. Super admin sets a rota per location:
-- the weekdays a count is due and the safe holder responsible, with a
-- cover person for a date range when the usual person is off. The
-- responsible person sees a banner on their home screen from the start
-- of the due day until a count is signed; if a due day is missed the
-- banner stays, marked overdue, until it is done. Nothing is
-- materialised: "due" is derived from the rota and the signed counts,
-- so it can never be dismissed without doing the task.
--
-- Also: permanently delete a voided count (super admin), for the
-- Archive's "Delete for good".

create table if not exists public.lng_cash_count_rota (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  -- ISO weekday, 1 = Monday .. 7 = Sunday.
  weekday smallint not null check (weekday between 1 and 7),
  assignee_account_id uuid not null references public.accounts(id) on delete restrict,
  enabled boolean not null default true,
  created_by uuid references public.accounts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, weekday)
);

create table if not exists public.lng_cash_count_rota_covers (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  cover_account_id uuid not null references public.accounts(id) on delete restrict,
  from_date date not null,
  to_date date not null check (to_date >= from_date),
  note text,
  created_by uuid references public.accounts(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.lng_cash_count_rota is 'Weekdays a cash count is due at a location and the safe holder responsible.';
comment on table public.lng_cash_count_rota_covers is 'Date ranges where someone else covers the cash count (the usual person is off).';

alter table public.lng_cash_count_rota enable row level security;
alter table public.lng_cash_count_rota_covers enable row level security;

-- Everyone who can reach the Cash counts page can read the rota.
drop policy if exists lng_cash_count_rota_read on public.lng_cash_count_rota;
create policy lng_cash_count_rota_read on public.lng_cash_count_rota
  for select to authenticated
  using (public.auth_can_count_cash() or public.auth_can_view_safe() or public.auth_can_view_financials());
drop policy if exists lng_cash_count_rota_covers_read on public.lng_cash_count_rota_covers;
create policy lng_cash_count_rota_covers_read on public.lng_cash_count_rota_covers
  for select to authenticated
  using (public.auth_can_count_cash() or public.auth_can_view_safe() or public.auth_can_view_financials());

-- Only the super admin writes the rota.
drop policy if exists lng_cash_count_rota_write on public.lng_cash_count_rota;
create policy lng_cash_count_rota_write on public.lng_cash_count_rota
  for all to authenticated
  using (public.auth_is_super_admin()) with check (public.auth_is_super_admin());
drop policy if exists lng_cash_count_rota_covers_write on public.lng_cash_count_rota_covers;
create policy lng_cash_count_rota_covers_write on public.lng_cash_count_rota_covers
  for all to authenticated
  using (public.auth_is_super_admin()) with check (public.auth_is_super_admin());

-- ── Is a count due, and whose job is it? ─────────────────────────────
-- Returns the most recent due date on or before today (London) that has
-- no signed count on or after it, with the person responsible on that
-- date (cover first, then the weekday's assignee). Null due_date when
-- nothing is outstanding. Any authenticated staff member may call it;
-- it exposes only names and dates.
create or replace function public.lng_cash_count_due(p_location_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_loc uuid;
  v_today date := (now() at time zone 'Europe/London')::date;
  v_last_signed date;
  v_due date;
  v_weekday smallint;
  v_assignee uuid;
  v_responsible uuid;
  v_name text;
  v_cover boolean := false;
  v_day date;
  v_lookback int := 0;
begin
  select coalesce(p_location_id, a.location_id) into v_loc
    from public.accounts a where a.auth_user_id = auth.uid();
  if v_loc is null then
    return jsonb_build_object('due_date', null);
  end if;

  select max((period_end at time zone 'Europe/London')::date) into v_last_signed
    from public.lng_cash_counts
   where status = 'signed' and location_id = v_loc;

  -- Walk back from today to find the latest rota day that is still
  -- outstanding. Stop at the last signed count or 60 days.
  v_day := v_today;
  while v_lookback < 60 loop
    exit when v_last_signed is not null and v_day <= v_last_signed;
    v_weekday := extract(isodow from v_day)::smallint;
    select r.assignee_account_id into v_assignee
      from public.lng_cash_count_rota r
     where r.location_id = v_loc and r.weekday = v_weekday and r.enabled;
    if v_assignee is not null then
      v_due := v_day;
      exit;
    end if;
    v_day := v_day - 1;
    v_lookback := v_lookback + 1;
  end loop;

  if v_due is null then
    return jsonb_build_object('due_date', null, 'last_signed_date', v_last_signed, 'today', v_today);
  end if;

  select c.cover_account_id into v_responsible
    from public.lng_cash_count_rota_covers c
   where c.location_id = v_loc and v_due between c.from_date and c.to_date
   order by c.created_at desc limit 1;
  v_cover := v_responsible is not null;
  if v_responsible is null then v_responsible := v_assignee; end if;

  select coalesce(nullif(trim(concat_ws(' ', a.first_name, a.last_name)), ''), a.name) into v_name
    from public.accounts a where a.id = v_responsible;

  return jsonb_build_object(
    'due_date', v_due,
    'today', v_today,
    'overdue', v_due < v_today,
    'responsible_account_id', v_responsible,
    'responsible_name', v_name,
    'is_cover', v_cover,
    'last_signed_date', v_last_signed
  );
end
$function$;

revoke all on function public.lng_cash_count_due(uuid) from public;
grant execute on function public.lng_cash_count_due(uuid) to authenticated;

-- ── Delete a voided count for good ───────────────────────────────────
create or replace function public.lng_cash_delete_voided_count(p_count_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me uuid;
  v_row public.lng_cash_counts%rowtype;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only the super admin can delete a count.' using errcode = '42501';
  end if;
  select a.id into v_me from public.accounts a where a.auth_user_id = auth.uid();
  select * into v_row from public.lng_cash_counts where id = p_count_id for update;
  if v_row.id is null then
    raise exception 'Count not found.' using errcode = 'P0002';
  end if;
  if v_row.status <> 'disputed' then
    raise exception 'Only a voided count can be deleted. Void it first.' using errcode = '22023';
  end if;
  insert into public.lng_event_log (source, event_type, account_id, location_id, payload)
  values ('cash_counts', 'cash_count_deleted', v_me, v_row.location_id,
          jsonb_build_object('count_id', v_row.id, 'period_start', v_row.period_start, 'period_end', v_row.period_end,
                             'expected_pence', v_row.expected_pence, 'actual_pence', v_row.actual_pence, 'notes', v_row.notes));
  delete from public.lng_cash_counts where id = p_count_id;
  return jsonb_build_object('count_id', p_count_id);
end
$function$;

revoke all on function public.lng_cash_delete_voided_count(uuid) from public;
grant execute on function public.lng_cash_delete_voided_count(uuid) to authenticated;

-- Realtime so the home-screen banner clears the moment a count is signed
-- and updates when the rota changes.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'lng_cash_count_rota') then
      alter publication supabase_realtime add table public.lng_cash_count_rota;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'lng_cash_count_rota_covers') then
      alter publication supabase_realtime add table public.lng_cash_count_rota_covers;
    end if;
  end if;
end $$;
