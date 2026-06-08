# Slice: Meet staff recognition hosts

Lets an admin register a staff member as a Meet host who is recognised by
name (and then by captured Google ID), without that person connecting
their own Google account. Solves the case where the person who runs a
virtual appointment is not the OAuth account that owns the Meet space
(e.g. they sit outside the Workspace org and Google's `org_internal` gate
blocks their OAuth consent).

## What changed

- `lng_meet_hosts` gains `kind` ('oauth' | 'staff'), `staff_member_id`,
  nullable `google_email`, a shape-guard CHECK, admin write RLS policies
  (which also repair the previously silent Deactivate/Remove buttons),
  and a revoke of client SELECT on the token columns.
- Attendance matching (`meetAttendanceCore`) now always consults staff
  recognition hosts by display name, and auto-binds their Google user ID
  on the first exact-name sighting so later meetings match by the
  un-forgeable ID.
- Admin → Services → Meet hosts gains a "Add a staff member as a
  recognised host" picker. Booking and appointment host pickers are
  restricted to OAuth hosts (only they can own a Meet space).

## Smoke test (plain English)

1. Sign in as an admin. Go to Admin → Services → Meet hosts.
2. Under "Add a staff member as a recognised host", pick a staff member
   and tap "Add host". The person appears in the list as
   "Staff. Recognised by name." with a people icon.
3. The same person does NOT appear in the New Booking sheet's "Meet host"
   dropdown for a virtual impression appointment (only Google-connected
   hosts do).
4. Tap Deactivate on the staff host. It flips to Inactive (this also
   proves the write path works now). Tap Reactivate.
5. Run a virtual appointment whose Meet space is owned by the connected
   OAuth host. Have the staff member join the call under their real name
   while the OAuth owner never joins. After the meeting ends, open the
   appointment detail page and Refresh attendance.
6. The staff member is shown as the host (not as the patient / not as an
   unconfirmed joiner). The patient, if they joined, is shown separately.
7. Re-check Admin → Services: the staff host now reads
   "Staff. Recognised by Google ID." (their stable ID was auto-bound on
   first sighting).
8. Remove the staff host. It disappears from the list; past appointment
   attendance is unchanged.

## Guard rails verified

- Name matching is unit-tested in `src/lib/hostNameMatch.test.ts`:
  "Karly" matches "Karly Innes", "John Doe" does NOT match "John Smith",
  device tags like "(iPad)" are ignored, bare initials are dropped.
- Auto-bind only fires on an EXACT name match, so a loose label match can
  never persist the wrong person's Google ID onto a staff record.
- Token columns (`access_token`, `refresh_token`, `token_expiry`) are no
  longer SELECT-able by `authenticated` / `anon`.
