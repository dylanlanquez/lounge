-- 20260428_15_patients_guard_lwo_ref.sql
-- patients.lwo_ref is immutable once set. Stamping NULL → value is allowed.
-- Changing value → other-value or value → NULL is forbidden.
--
-- Per `06-patient-identity.md §5.4`.
--
-- Rollback: DROP TRIGGER patients_guard_lwo_ref ON public.patients;
--           DROP FUNCTION public.patients_guard_lwo_ref();

create or replace function public.patients_guard_lwo_ref()
returns trigger
language plpgsql
as $$
begin
  if old.lwo_ref is not null and new.lwo_ref is distinct from old.lwo_ref then
    raise exception 'patients.lwo_ref is immutable once set (was %, attempted %)',
      old.lwo_ref, coalesce(new.lwo_ref, '<NULL>');
  end if;
  return new;
end;
$$;

create trigger patients_guard_lwo_ref
  before update of lwo_ref on public.patients
  for each row execute function public.patients_guard_lwo_ref();

comment on function public.patients_guard_lwo_ref() is
  'Refuses any UPDATE that changes a non-null patients.lwo_ref. Stamp once, never overwrite.';
