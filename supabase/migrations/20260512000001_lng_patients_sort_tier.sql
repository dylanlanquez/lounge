-- Patients listing: surface letter-starting names before number / symbol /
-- empty names. Default glibc text collation on Supabase puts digits before
-- letters in ascending order, which pushes "1Test"-style imports to the top
-- of the Patients route. Add a PostgREST computed column so usePatientList
-- can order by tier before first_name without an RPC.

CREATE OR REPLACE FUNCTION public.lng_patient_name_tier(p public.patients)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p.first_name IS NULL OR length(p.first_name) = 0 THEN 2::smallint
    WHEN p.first_name ~ '^[A-Za-z]' THEN 0::smallint
    ELSE 1::smallint
  END
$$;

GRANT EXECUTE ON FUNCTION public.lng_patient_name_tier(public.patients)
  TO anon, authenticated, service_role;

-- Force PostgREST to reload the schema cache so the computed column is
-- immediately available to .order() calls from the client.
NOTIFY pgrst, 'reload schema';
