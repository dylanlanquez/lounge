-- 20260506000020_lng_calendly_answer_map.sql
--
-- Replaces the event-type-label mapping (lng_calendly_type_map) with an
-- answer-level mapping. Calendly intake answers (e.g. "Snapped Denture"
-- from "Repair Type", or "Retainers" from "Appliance") map directly to
-- specific lwo_catalogue rows. The mapping key is (question, answer_text)
-- so identical answer values under different questions don't collide.
-- Arch is always derived separately from the intake arch question.
--
-- Also provides lng_distinct_calendly_answers(): an RPC that scans all
-- appointment intake records and returns every distinct (question, answer)
-- pair with frequency. The admin UI uses this to show exactly which answer
-- values exist in real bookings and which are already mapped.
--
-- Rollback:
--   drop function if exists public.lng_upsert_calendly_answer(text,text,uuid);
--   drop function if exists public.lng_distinct_calendly_answers();
--   drop table if exists public.lng_calendly_answer_map;

-- Remove the old event-type-label table that operated at the wrong level.
drop table if exists public.lng_calendly_type_map;

create table if not exists public.lng_calendly_answer_map (
  id           uuid        primary key default gen_random_uuid(),
  question     text        not null,
  answer_text  text        not null,
  catalogue_id uuid        not null references public.lwo_catalogue(id) on delete cascade,
  created_at   timestamptz not null default now()
);

-- One mapping per (question, answer_text) pair — case-insensitive, trimmed.
create unique index if not exists lng_calendly_answer_map_pair_idx
  on public.lng_calendly_answer_map (lower(trim(question)), lower(trim(answer_text)));

comment on table public.lng_calendly_answer_map is
  'Admin-defined mapping from a Calendly intake (question, answer_text) pair to a specific lwo_catalogue row. Used to pre-populate the arrival basket for legacy Calendly bookings.';

-- RLS: all authenticated staff can read; only admins can write.
alter table public.lng_calendly_answer_map enable row level security;

create policy "staff can read calendly answer map"
  on public.lng_calendly_answer_map for select
  using (auth.role() = 'authenticated');

create policy "admins can manage calendly answer map"
  on public.lng_calendly_answer_map for all
  using (public.is_admin())
  with check (public.is_admin());

-- Discovery function: returns one row per distinct (question, answer_text)
-- pair seen across all Calendly appointment intake records, with a
-- frequency count. Multi-select answers (newline-delimited values as
-- produced by Calendly checkbox questions) are split into individual lines
-- so each selectable option appears as its own row.
-- Arch questions and contact/personal fields are excluded — arch is
-- derived separately in the arrival pre-population flow.
create or replace function public.lng_distinct_calendly_answers()
returns table(question text, answer_text text, frequency bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    elem->>'question'   as question,
    trim(line.val)      as answer_text,
    count(*)            as frequency
  from public.lng_appointments,
       jsonb_array_elements(
         case
           when intake is not null
                and jsonb_typeof(intake::jsonb) = 'array'
           then intake::jsonb
           else '[]'::jsonb
         end
       ) as elem,
       unnest(string_to_array(elem->>'answer', E'\n')) as line(val)
  where trim(line.val) != ''
    and elem->>'question' is not null
    and trim(elem->>'question') != ''
    -- exclude contact / personal fields
    and elem->>'question' not ilike '%contact%'
    and elem->>'question' not ilike '%phone%'
    and elem->>'question' not ilike '%mobile%'
    and elem->>'question' not ilike '%email%'
    and elem->>'question' not ilike '%time zone%'
    -- exclude arch fields — handled separately in the pre-population flow
    and elem->>'question' not ilike '%arch%'
    and elem->>'question' not ilike '%upper or lower%'
    and elem->>'question' not ilike '%top or bottom%'
    and elem->>'question' not ilike '%which side%'
    and elem->>'question' not ilike '%jaw%'
  group by 1, 2
  order by 1, 3 desc, 2;
$$;

grant execute on function public.lng_distinct_calendly_answers() to authenticated;

-- Upsert helper: insert or update a mapping for (question, answer_text).
-- PostgREST can't resolve ON CONFLICT targets that are expression-based
-- unique indexes, so we use an RPC to handle the upsert atomically.
create or replace function public.lng_upsert_calendly_answer(
  p_question     text,
  p_answer_text  text,
  p_catalogue_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Permission denied';
  end if;

  insert into public.lng_calendly_answer_map (question, answer_text, catalogue_id)
  values (trim(p_question), trim(p_answer_text), p_catalogue_id)
  on conflict (lower(trim(question)), lower(trim(answer_text)))
  do update set catalogue_id = excluded.catalogue_id;
end;
$$;

grant execute on function public.lng_upsert_calendly_answer(text, text, uuid) to authenticated;
