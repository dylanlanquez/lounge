-- 20260907000023_lng_cash_sealed_envelopes.sql
--
-- Sealed envelopes: counted cash that stays in the safe until banked.
--
-- The working pattern (Dylan, 7 Sep 2026): Jade counts every Friday.
-- The counted cash goes into a signed, sealed envelope kept in the
-- safe. It might not be banked or collected every week; envelopes
-- mount up and go together. The safe therefore holds two kinds of
-- cash at any moment:
--   * sealed  — envelopes waiting to be banked or collected
--   * loose   — cash taken since the last seal
-- Right now (the safe total) is unchanged by sealing: nothing left the
-- safe. What changes is the picture: "£771.23 in the safe, of which
-- £771.23 sealed in 1 envelope, £0.00 loose".
--
-- Banking or collecting envelopes is one action: it records the bank
-- deposit withdrawal (two-person rule enforced by the existing trigger)
-- and marks the envelopes banked with that withdrawal, atomically.

create table if not exists public.lng_cash_sealed_envelopes (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete restrict,
  amount_pence integer not null check (amount_pence > 0),
  -- What is written on the envelope (a number, initials, anything).
  label text,
  note text,
  count_id uuid references public.lng_cash_counts(id) on delete set null,
  sealed_at timestamptz not null default now(),
  sealed_by uuid not null references public.accounts(id) on delete restrict,
  witness_id uuid references public.accounts(id) on delete restrict,
  -- Set when the envelope left the safe; the withdrawal is the money movement.
  banked_withdrawal_id uuid references public.lng_cash_withdrawals(id) on delete set null,
  banked_at timestamptz,
  banked_by uuid references public.accounts(id) on delete restrict,
  -- 'banked' (paid into the bank) or 'collected' (taken by a person).
  banked_how text check (banked_how in ('banked', 'collected')),
  created_at timestamptz not null default now()
);

comment on table public.lng_cash_sealed_envelopes is
  'Counted cash sealed in a signed envelope and kept in the safe until it is banked or collected. Sealing moves nothing; banking records the withdrawal and stamps the envelopes.';

create index if not exists lng_cash_sealed_envelopes_open_idx
  on public.lng_cash_sealed_envelopes (location_id) where banked_at is null;

alter table public.lng_cash_sealed_envelopes enable row level security;
drop policy if exists lng_cash_sealed_envelopes_read on public.lng_cash_sealed_envelopes;
create policy lng_cash_sealed_envelopes_read on public.lng_cash_sealed_envelopes
  for select to authenticated
  using (public.auth_can_count_cash() or public.auth_can_view_safe() or public.auth_can_view_financials());
-- Writes go through the functions below.

-- ── Seal cash ────────────────────────────────────────────────────────
-- Safe holders only. Amount must not exceed the loose cash in the safe
-- (safe total minus envelopes already sealed), so the envelopes can
-- never claim more than is physically there.
create or replace function public.lng_cash_seal_envelope(
  p_amount_pence integer,
  p_label text,
  p_note text,
  p_count_id uuid,
  p_witness_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me uuid;
  v_loc uuid;
  v_total integer;
  v_sealed integer;
  v_id uuid;
begin
  if not public.auth_can_count_cash() then
    raise exception 'Only a safe holder can seal cash.' using errcode = '42501';
  end if;
  if p_amount_pence is null or p_amount_pence <= 0 then
    raise exception 'Enter the amount going into the envelope.' using errcode = '22023';
  end if;
  select a.id, a.location_id into v_me, v_loc from public.accounts a where a.auth_user_id = auth.uid();
  if v_loc is null then
    raise exception 'This account has no location set.' using errcode = '22004';
  end if;
  if p_witness_id is not null then
    perform public.lng_cash_assert_two_person(v_me, p_witness_id, true, 'seal');
  end if;

  v_total := (public.lng_cash_safe_position()->>'expected_in_safe_pence')::integer;
  select coalesce(sum(amount_pence), 0) into v_sealed
    from public.lng_cash_sealed_envelopes
   where location_id = v_loc and banked_at is null;
  if p_amount_pence > v_total - v_sealed then
    raise exception 'Only % pence is loose in the safe (% in total, % already sealed). The envelope cannot hold more than that.',
      v_total - v_sealed, v_total, v_sealed using errcode = '22023';
  end if;

  insert into public.lng_cash_sealed_envelopes (location_id, amount_pence, label, note, count_id, sealed_by, witness_id)
  values (v_loc, p_amount_pence, nullif(trim(p_label), ''), nullif(trim(p_note), ''), p_count_id, v_me, p_witness_id)
  returning id into v_id;

  insert into public.lng_event_log (source, event_type, account_id, location_id, payload)
  values ('cash_counts', 'cash_envelope_sealed', v_me, v_loc,
          jsonb_build_object('envelope_id', v_id, 'amount_pence', p_amount_pence, 'label', p_label, 'count_id', p_count_id, 'witness_id', p_witness_id));
  return jsonb_build_object('envelope_id', v_id);
end
$function$;

revoke all on function public.lng_cash_seal_envelope(integer, text, text, uuid, uuid) from public;
grant execute on function public.lng_cash_seal_envelope(integer, text, text, uuid, uuid) to authenticated;

-- ── Bank or collect envelopes ────────────────────────────────────────
-- One withdrawal for the envelopes' total (two-person trigger applies),
-- envelopes stamped with it. All or nothing.
create or replace function public.lng_cash_bank_envelopes(
  p_envelope_ids uuid[],
  p_how text,
  p_note text,
  p_witness_id uuid,
  p_taken_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me uuid;
  v_loc uuid;
  v_total integer;
  v_count integer;
  v_wid uuid;
  v_labels text;
begin
  if not public.auth_can_count_cash() then
    raise exception 'Only a safe holder can bank envelopes.' using errcode = '42501';
  end if;
  if p_how not in ('banked', 'collected') then
    raise exception 'Say whether the envelopes were banked or collected.' using errcode = '22023';
  end if;
  select a.id, a.location_id into v_me, v_loc from public.accounts a where a.auth_user_id = auth.uid();

  select coalesce(sum(amount_pence), 0), count(*),
         string_agg(coalesce(label, 'unlabelled'), ', ' order by sealed_at)
    into v_total, v_count, v_labels
    from public.lng_cash_sealed_envelopes
   where id = any(p_envelope_ids) and location_id = v_loc and banked_at is null;
  if v_count = 0 or v_count <> coalesce(array_length(p_envelope_ids, 1), 0) then
    raise exception 'One or more of those envelopes is not in the safe any more. Refresh and try again.' using errcode = '22023';
  end if;

  insert into public.lng_cash_withdrawals (location_id, amount_pence, reason, note, taken_by, witness_id, on_camera, taken_at)
  values (
    v_loc, v_total, 'bank_deposit',
    concat_ws(' · ',
      case when p_how = 'collected' then 'Collected' else 'Banked' end
        || ': ' || v_count || ' envelope' || case when v_count = 1 then '' else 's' end || ' (' || v_labels || ')',
      nullif(trim(p_note), '')),
    v_me, p_witness_id, true, coalesce(p_taken_at, now())
  )
  returning id into v_wid;

  update public.lng_cash_sealed_envelopes
     set banked_withdrawal_id = v_wid, banked_at = coalesce(p_taken_at, now()), banked_by = v_me, banked_how = p_how
   where id = any(p_envelope_ids);

  insert into public.lng_event_log (source, event_type, account_id, location_id, payload)
  values ('cash_counts', 'cash_envelopes_banked', v_me, v_loc,
          jsonb_build_object('withdrawal_id', v_wid, 'envelope_ids', to_jsonb(p_envelope_ids), 'amount_pence', v_total, 'how', p_how));
  return jsonb_build_object('withdrawal_id', v_wid, 'amount_pence', v_total, 'envelope_count', v_count);
end
$function$;

revoke all on function public.lng_cash_bank_envelopes(uuid[], text, text, uuid, timestamptz) from public;
grant execute on function public.lng_cash_bank_envelopes(uuid[], text, text, uuid, timestamptz) to authenticated;

-- Realtime so every device shows the same envelopes.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'lng_cash_sealed_envelopes') then
    alter publication supabase_realtime add table public.lng_cash_sealed_envelopes;
  end if;
end $$;
