-- 20260430000006_lng_waiver_signatures_witness_name.sql
--
-- Capture the signature witness as a free-text column instead of
-- inferring it from the witnessed_by → accounts join.
--
-- Why:
--
--   • The typed "Witnessed by" field on the Arrival waiver sheet was
--     never persisted — it was UI-only confirmation. The DB only knew
--     the signed-in receptionist via witnessed_by (the auth account
--     id), so a colleague witnessing a signature couldn't be recorded.
--
--   • The patient-profile waiver sheet had no witness UI at all and
--     leaned entirely on the join. Patient profile signing now needs
--     the same witness affordance the Arrival flow has.
--
--   • Audit-grade output (printed waivers, the Signed waivers table)
--     should read a stable name that travels with the signature row,
--     not one that mutates if the witness's account is later renamed
--     or deactivated.
--
-- witnessed_by stays on the row — it remains the system-of-record FK
-- for accountability (which logged-in user actually clicked Sign).
-- witness_name is the human-meaningful name the patient saw at sign
-- time, persisted verbatim.

alter table lng_waiver_signatures
  add column if not exists witness_name text;

comment on column lng_waiver_signatures.witness_name is
  'Free-text name of the staff member who witnessed this signature, captured at sign time. Decouples the audit witness from the signed-in account (witnessed_by) so a colleague can be recorded as witness, and so account renames after the fact never alter the historical record.';

-- ── Backfill ──────────────────────────────────────────────────────────
-- Existing rows have no typed witness_name. Best available reconstruction
-- is the account name behind witnessed_by — copy it onto the row so
-- readers can drop the join and use witness_name unconditionally going
-- forward. NULL stays NULL when witnessed_by is null or the account row
-- is missing a name.

update lng_waiver_signatures s
   set witness_name = nullif(
         trim(coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, '')),
         ''
       )
  from accounts a
 where s.witness_name is null
   and s.witnessed_by is not null
   and a.id = s.witnessed_by;
