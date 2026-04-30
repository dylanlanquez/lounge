-- 20260430000004_lng_realtime_publication.sql
--
-- Add every lng_* table the UI subscribes to (plus patient_events,
-- which Lounge reads for the visit timeline and the patient activity
-- feed) to Supabase's `supabase_realtime` publication. Without this,
-- postgres_changes events never fire for these tables and the app
-- can't auto-refresh — Schedule, In-Clinic, the nav counters, the
-- patient profile, and the VisitDetail cart and timeline all sit on
-- stale data until the user manually navigates.
--
-- Meridian-side tables (patients, cases, patient_files, ...) are
-- already in the publication; we are not modifying any of those.
--
-- Replica identity stays at default for these tables — every hook we
-- subscribe from re-fetches on change and never reads OLD row values
-- out of the change payload, so DEFAULT (primary key only) is enough
-- and avoids the WAL volume penalty of FULL.
--
-- Idempotent: each statement is wrapped in a DO block that only adds
-- the table if it isn't already a publication member, so re-running
-- the migration in a refreshed shadow doesn't error.

do $$
declare
  t text;
  tables text[] := array[
    'lng_appointments',
    'lng_visits',
    'lng_walk_ins',
    'lng_carts',
    'lng_cart_items',
    'lng_cart_item_upgrades',
    'lng_payments',
    'lng_waiver_signatures',
    'lng_event_log',
    'patient_events'
  ];
begin
  foreach t in array tables loop
    if not exists (
      select 1
        from pg_publication_tables
       where pubname    = 'supabase_realtime'
         and schemaname = 'public'
         and tablename  = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

-- Rollback (manual; only runs if the operator types it):
--
-- do $$
-- declare
--   t text;
--   tables text[] := array[
--     'lng_appointments','lng_visits','lng_walk_ins','lng_carts',
--     'lng_cart_items','lng_cart_item_upgrades','lng_payments',
--     'lng_waiver_signatures','lng_event_log','patient_events'];
-- begin
--   foreach t in array tables loop
--     if exists (
--       select 1 from pg_publication_tables
--        where pubname='supabase_realtime' and schemaname='public' and tablename=t
--     ) then
--       execute format('alter publication supabase_realtime drop table public.%I', t);
--     end if;
--   end loop;
-- end $$;
