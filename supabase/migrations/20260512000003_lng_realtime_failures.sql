-- lng_system_failures lives outside the Supabase Realtime publication, so the
-- appointment + visit timelines never receive postgres_changes events for it
-- — failed reminder sends, dispatch errors and any other late-arriving
-- structured failures only surfaced after a manual refresh. Add it (plus
-- lng_email_messages for parity, in case a future view wants to react to the
-- sent-email log) so every Timeline source the front-end subscribes to is
-- actually streamable.
--
-- Idempotent: the conditional checks avoid raising on a second run.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'lng_system_failures'
  ) then
    execute 'alter publication supabase_realtime add table public.lng_system_failures';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'lng_email_messages'
  ) then
    execute 'alter publication supabase_realtime add table public.lng_email_messages';
  end if;
end$$;
