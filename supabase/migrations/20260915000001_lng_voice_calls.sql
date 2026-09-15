-- 20260915000001_lng_voice_calls.sql
--
-- Voice calls, slice 1: the resource, the booking type, and the staff
-- capability. The Twilio call surface (dialling, recording, the call
-- visit page) comes in a later slice; this migration gives it a schedule
-- to land on.
--
-- ── Model ──────────────────────────────────────────────────────────
--
--   * A VOICE CALL AGENT is a staff member with
--     lng_staff_members.is_voice_call_agent = true. That one flag is
--     the capability: it unlocks "Voice call mode" in the app and
--     makes them count towards voice call capacity.
--
--   * The AGENTS ARE A RESOURCE. The pool 'voice-call-agent'
--     (kind = staff_role) is what a voice call booking consumes, exactly
--     the way an impression booking consumes 'impression-clinician'
--     (ADR-006). Capacity = the number of active agents, kept in step
--     by the existing staff-role pool machinery. The flag and the pool
--     membership are the same fact, so a trigger keeps them in sync in
--     BOTH directions: flip the flag and the assignment follows; tick
--     or untick the agent in Admin, Conflicts and the flag follows.
--
--   * A VOICE CALL is a booking with service_type = 'voice_call'. It
--     has one phase, "Voice call", patient_required = true, consuming
--     the agent pool. Availability comes from the generic path
--     (booking-type working hours + the conflict checker), not the
--     per-clinician hours model that virtual impressions use. No
--     Google Meet, no chair, no lab time.
--
--   * Whole-clinic closures do not block voice calls. Like virtual
--     impressions, calls are a remote team; a closure on 'voice_call'
--     specifically still does.
--
-- Apply order: shadow first (verify), then Meridian, then deploy the
-- frontend. The frontend selects is_voice_call_agent and offers the
-- voice_call service, so it must not ship first.

begin;

-- ─────────────────────────────────────────────────────────────────
-- 1. Staff capability
-- ─────────────────────────────────────────────────────────────────
alter table public.lng_staff_members
  add column if not exists is_voice_call_agent boolean not null default false;

comment on column public.lng_staff_members.is_voice_call_agent is
  'When true this staff member is a voice call agent: they can switch Lounge into Voice call mode and they count towards the voice-call-agent pool capacity (kept in sync by lng_voice_call_agent_sync_pool_trg).';

-- lng_staff_members uses column-level grants for authenticated. New
-- columns must be granted explicitly or the client read/update fails.
grant select (is_voice_call_agent) on public.lng_staff_members to authenticated;
grant update (is_voice_call_agent) on public.lng_staff_members to authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 2. The agent pool (the resource)
-- ─────────────────────────────────────────────────────────────────
-- units = 1 is the placeholder every staff_role pool carries when nobody
-- is assigned (the units column is checked > 0; see 20260503000014).
-- The recompute below settles it to the real active agent count.
insert into public.lng_booking_resource_pools (id, display_name, kind, units, per_unit_capacity, notes)
values (
  'voice-call-agent',
  'Voice call agent',
  'staff_role',
  1,
  1,
  'Staff who take booked voice calls. Membership follows the Voice call agent flag on the staff member (Admin, Staff) and vice versa.'
)
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────
-- 3. Two-way sync: flag <-> pool assignment
-- ─────────────────────────────────────────────────────────────────
-- A transaction-local setting breaks the loop: whichever side writes
-- first sets it, and the other side's trigger returns early.

-- 3a. Flag -> assignment.
create or replace function public.lng_voice_call_agent_sync_pool_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('lng.syncing_voice_call_pool', true) = 'true' then
    return new;
  end if;
  perform set_config('lng.syncing_voice_call_pool', 'true', true);

  if new.is_voice_call_agent
     and (tg_op = 'INSERT' or old.is_voice_call_agent is distinct from true) then
    insert into public.lng_staff_pool_assignments (staff_member_id, pool_id, assigned_by)
    values (new.id, 'voice-call-agent', public.auth_account_id())
    on conflict (staff_member_id, pool_id) do nothing;
  elsif not new.is_voice_call_agent
        and tg_op = 'UPDATE'
        and old.is_voice_call_agent = true then
    delete from public.lng_staff_pool_assignments
     where staff_member_id = new.id and pool_id = 'voice-call-agent';
  end if;

  perform set_config('lng.syncing_voice_call_pool', 'false', true);
  return new;
end;
$$;
revoke all on function public.lng_voice_call_agent_sync_pool_trg() from public;
comment on function public.lng_voice_call_agent_sync_pool_trg() is
  'AFTER INSERT/UPDATE OF is_voice_call_agent on lng_staff_members: adds or removes the voice-call-agent pool assignment so the flag and the resource stay one fact.';

drop trigger if exists lng_staff_members_voice_call_agent_sync on public.lng_staff_members;
create trigger lng_staff_members_voice_call_agent_sync
  after insert or update of is_voice_call_agent on public.lng_staff_members
  for each row execute function public.lng_voice_call_agent_sync_pool_trg();

-- 3b. Assignment -> flag.
create or replace function public.lng_voice_call_pool_sync_flag_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.lng_staff_pool_assignments;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  if v_row.pool_id <> 'voice-call-agent' then
    return v_row;
  end if;
  if current_setting('lng.syncing_voice_call_pool', true) = 'true' then
    return v_row;
  end if;
  perform set_config('lng.syncing_voice_call_pool', 'true', true);

  update public.lng_staff_members
     set is_voice_call_agent = (tg_op <> 'DELETE')
   where id = v_row.staff_member_id
     and is_voice_call_agent is distinct from (tg_op <> 'DELETE');

  perform set_config('lng.syncing_voice_call_pool', 'false', true);
  return v_row;
end;
$$;
revoke all on function public.lng_voice_call_pool_sync_flag_trg() from public;
comment on function public.lng_voice_call_pool_sync_flag_trg() is
  'AFTER INSERT/DELETE on lng_staff_pool_assignments for pool voice-call-agent: mirrors membership onto lng_staff_members.is_voice_call_agent.';

drop trigger if exists lng_staff_pool_assignments_voice_call_sync on public.lng_staff_pool_assignments;
create trigger lng_staff_pool_assignments_voice_call_sync
  after insert or delete on public.lng_staff_pool_assignments
  for each row execute function public.lng_voice_call_pool_sync_flag_trg();

-- Settle the pool's units from its (currently empty) assignment set.
select public.lng_recompute_staff_role_pool_capacity('voice-call-agent');

-- ─────────────────────────────────────────────────────────────────
-- 4. service_type = 'voice_call' everywhere the value is enumerated
-- ─────────────────────────────────────────────────────────────────

-- 4a. lng_appointments
alter table public.lng_appointments
  drop constraint if exists lng_appointments_service_type_check;
alter table public.lng_appointments
  add constraint lng_appointments_service_type_check
  check (
    service_type is null
    or service_type in (
      'denture_repair',
      'click_in_veneers',
      'same_day_appliance',
      'impression_appointment',
      'virtual_impression_appointment',
      'voice_call',
      'other'
    )
  );

-- 4b. lng_booking_type_config
alter table public.lng_booking_type_config
  drop constraint if exists lng_booking_type_config_service_type_check;
alter table public.lng_booking_type_config
  add constraint lng_booking_type_config_service_type_check
  check (service_type = any (array[
    'denture_repair'::text,
    'click_in_veneers'::text,
    'same_day_appliance'::text,
    'impression_appointment'::text,
    'virtual_impression_appointment'::text,
    'voice_call'::text,
    'other'::text
  ]));

-- 4c. lng_closures: the table check, the write RPC, and the rule.
alter table public.lng_closures
  drop constraint if exists lng_closures_service_type_chk;
alter table public.lng_closures
  add constraint lng_closures_service_type_chk check (
    service_type is null or service_type in (
      'denture_repair', 'click_in_veneers', 'same_day_appliance',
      'impression_appointment', 'virtual_impression_appointment',
      'voice_call', 'other'
    )
  );

create or replace function public.lng_add_closure(
  p_closed_date  date,
  p_service_type text default null,
  p_reason       text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admins can add closures' using errcode = '42501';
  end if;
  if p_service_type is not null and p_service_type not in (
       'denture_repair', 'click_in_veneers', 'same_day_appliance',
       'impression_appointment', 'virtual_impression_appointment',
       'voice_call', 'other'
     ) then
    raise exception 'Unknown service_type %', p_service_type using errcode = '22023';
  end if;

  insert into public.lng_closures (closed_date, service_type, reason, created_by)
  values (p_closed_date, p_service_type, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid())
  on conflict (closed_date, service_type) do update
    set reason     = excluded.reason,
        updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- Whole-clinic closures block every in-person type but never the remote
-- teams: virtual impressions and voice calls. A per-type closure still
-- blocks that type.
create or replace function public.lng_is_closed(
  p_service_type text,
  p_date         date
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.lng_closures c
     where c.closed_date = p_date
       and (
         c.service_type = p_service_type
         or (c.service_type is null
             and p_service_type is distinct from 'virtual_impression_appointment'
             and p_service_type is distinct from 'voice_call')
       )
  );
$$;
comment on function public.lng_is_closed(text, date) is
  'True when a booking of p_service_type on the clinic-local date p_date is blocked by lng_closures. Whole-clinic closures (service_type null) match every in-person type but never virtual_impression_appointment or voice_call.';

-- ─────────────────────────────────────────────────────────────────
-- 5. Booking type: parent config row + the single Voice call phase
-- ─────────────────────────────────────────────────────────────────
-- Hours mirror the virtual impression default (Mon-Fri 9-18, Sat 10-16,
-- Sun closed) in the Mon-first 7-element array shape every other
-- booking type uses. 15 minutes, patient on the line throughout.
insert into public.lng_booking_type_config (
  service_type,
  working_hours,
  patient_facing_min_minutes,
  patient_facing_max_minutes
)
select
  'voice_call',
  jsonb_build_array(
    jsonb_build_object('open', '09:00', 'close', '18:00'),
    jsonb_build_object('open', '09:00', 'close', '18:00'),
    jsonb_build_object('open', '09:00', 'close', '18:00'),
    jsonb_build_object('open', '09:00', 'close', '18:00'),
    jsonb_build_object('open', '09:00', 'close', '18:00'),
    jsonb_build_object('open', '10:00', 'close', '16:00'),
    jsonb_build_object('closed', true)
  ),
  15,
  15
where not exists (
  select 1
  from public.lng_booking_type_config
  where service_type = 'voice_call'
    and repair_variant is null
    and product_key is null
    and arch is null
);

insert into public.lng_booking_type_phases (
  config_id,
  phase_index,
  label,
  patient_required,
  duration_default
)
select
  c.id,
  1,
  'Voice call',
  true,
  15
from public.lng_booking_type_config c
where c.service_type = 'voice_call'
  and c.repair_variant is null
  and c.product_key is null
  and c.arch is null
  and not exists (
    select 1 from public.lng_booking_type_phases p
    where p.config_id = c.id
  );

insert into public.lng_booking_type_phase_pools (phase_id, pool_id)
select p.id, 'voice-call-agent'
  from public.lng_booking_type_phases p
  join public.lng_booking_type_config c on c.id = p.config_id
 where c.service_type = 'voice_call'
   and c.repair_variant is null
   and c.product_key is null
   and c.arch is null
on conflict (phase_id, pool_id) do nothing;

-- ─────────────────────────────────────────────────────────────────
-- 6. Patient emails for voice calls
-- ─────────────────────────────────────────────────────────────────
-- The General rows say "see you soon" and print the clinic address,
-- which is wrong for a phone call. Service-typed overrides (key,
-- 'voice_call') win over the General row in lng_resolve_email_template,
-- so these land without any edge function change. Same placeholder
-- vocabulary as the other seeded rows.
insert into public.lng_email_templates (key, service_type, subject, body_syntax, default_subject, default_body_syntax, version, enabled)
values
  ('booking_confirmation', 'voice_call',
   'Your call with Venneir is booked',
   $body$Hi {{patientFirstName}},

Your call with us is booked. One of our team will phone you at the time below on the number we have for you, so please keep your phone to hand.

## {{appointmentDateTime}}

**Voice call, about {{patientFacingDuration}}**

There is nothing to prepare and no app to install. If you would like us to call a different number, reply to this email before your call.

Apple Mail and Outlook pick up the attached calendar file automatically.

---

**Need to make a change?**

[Reschedule or cancel your call]({{manageUrl}})

Reference: {{appointmentRef}}

Speak soon,
The Venneir Team$body$,
   'Your call with Venneir is booked',
   $body$Hi {{patientFirstName}},

Your call with us is booked. One of our team will phone you at the time below on the number we have for you, so please keep your phone to hand.

## {{appointmentDateTime}}

**Voice call, about {{patientFacingDuration}}**

There is nothing to prepare and no app to install. If you would like us to call a different number, reply to this email before your call.

Apple Mail and Outlook pick up the attached calendar file automatically.

---

**Need to make a change?**

[Reschedule or cancel your call]({{manageUrl}})

Reference: {{appointmentRef}}

Speak soon,
The Venneir Team$body$,
   1, true),
  ('booking_reschedule', 'voice_call',
   'Your call with Venneir has moved',
   $body$Hi {{patientFirstName}},

We have moved your call to a new time. One of our team will phone you then on the number we have for you.

## {{appointmentDateTime}}

**Voice call, about {{patientFacingDuration}}**

*Was {{oldAppointmentDateTime}}.*

Your existing calendar entry will update automatically.

---

**Need to make another change?**

[Reschedule or cancel your call]({{manageUrl}})

Reference: {{appointmentRef}}

Speak soon,
The Venneir Team$body$,
   'Your call with Venneir has moved',
   $body$Hi {{patientFirstName}},

We have moved your call to a new time. One of our team will phone you then on the number we have for you.

## {{appointmentDateTime}}

**Voice call, about {{patientFacingDuration}}**

*Was {{oldAppointmentDateTime}}.*

Your existing calendar entry will update automatically.

---

**Need to make another change?**

[Reschedule or cancel your call]({{manageUrl}})

Reference: {{appointmentRef}}

Speak soon,
The Venneir Team$body$,
   1, true),
  ('booking_cancellation', 'voice_call',
   'Your call with Venneir is cancelled',
   $body$Hi {{patientFirstName}},

Your call with us has been cancelled, so nobody will phone you at the time below. Your calendar will update automatically.

## {{appointmentDateTime}}

---

**Need to rebook?**

[Book another call]({{manageUrl}})

Reference: {{appointmentRef}}

Speak soon,
The Venneir Team$body$,
   'Your call with Venneir is cancelled',
   $body$Hi {{patientFirstName}},

Your call with us has been cancelled, so nobody will phone you at the time below. Your calendar will update automatically.

## {{appointmentDateTime}}

---

**Need to rebook?**

[Book another call]({{manageUrl}})

Reference: {{appointmentRef}}

Speak soon,
The Venneir Team$body$,
   1, true),
  ('appointment_reminder', 'voice_call',
   'Reminder: we are calling you tomorrow',
   $body$Hi {{patientFirstName}},

A friendly reminder that one of our team will phone you tomorrow. Please keep your phone to hand at the time below.

## {{appointmentDateTime}}

**Voice call, about {{patientFacingDuration}}**

**Need to make a change?**

[Reschedule or cancel your call]({{manageUrl}})

Speak soon,
The Venneir Team$body$,
   'Reminder: we are calling you tomorrow',
   $body$Hi {{patientFirstName}},

A friendly reminder that one of our team will phone you tomorrow. Please keep your phone to hand at the time below.

## {{appointmentDateTime}}

**Voice call, about {{patientFacingDuration}}**

**Need to make a change?**

[Reschedule or cancel your call]({{manageUrl}})

Speak soon,
The Venneir Team$body$,
   1, true)
on conflict (key, service_type) do nothing;

commit;

notify pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- delete from public.lng_email_templates where service_type = 'voice_call';
-- delete from public.lng_booking_type_phase_pools where pool_id = 'voice-call-agent';
-- delete from public.lng_booking_type_phases where config_id in (select id from public.lng_booking_type_config where service_type = 'voice_call');
-- delete from public.lng_booking_type_config where service_type = 'voice_call';
-- (re-create lng_is_closed / lng_add_closure / the three service_type checks from 20260610000004 and 20260504000004)
-- drop trigger if exists lng_staff_pool_assignments_voice_call_sync on public.lng_staff_pool_assignments;
-- drop function if exists public.lng_voice_call_pool_sync_flag_trg();
-- drop trigger if exists lng_staff_members_voice_call_agent_sync on public.lng_staff_members;
-- drop function if exists public.lng_voice_call_agent_sync_pool_trg();
-- delete from public.lng_staff_pool_assignments where pool_id = 'voice-call-agent';
-- delete from public.lng_booking_resource_pools where id = 'voice-call-agent';
-- alter table public.lng_staff_members drop column if exists is_voice_call_agent;
