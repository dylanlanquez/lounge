# Slice — Per-staff exemption from the idle lock screen

**Status:** Built, type-checked + linted, unit-tested. **Migration NOT applied**, no manual or shadow verification yet.
**Phase:** Cross-cutting (security + staff admin)
**Migrations (this slice):** `20260914000001_lng_staff_idle_lock.sql` — adds `lng_staff_members.idle_lock_enabled boolean not null default true`

The idle lock covers Lounge after five idle minutes and asks for the signed-in
user's password again, because the tablet sits on a public reception desk
showing a patient's name, date of birth, phone number, payments and photos. It
applied to everyone with no way to make an exception, and for staff who do not
work in front of the public the re-prompt is friction without a matching risk.

This adds one switch, per staff member, in Admin > Staff > Manage.

**Denylist, not allowlist.** The column defaults `true`, so every existing and
every future staff member keeps the lock without anyone remembering to switch
it on. Only an admin ticking a named person off exempts them. That is the
opposite of `marketing_walkthrough_enabled`, which this otherwise mirrors, and
the difference is deliberate: a flag that grants a capability defaults closed
by being false, and a flag that removes a protection defaults closed by being
true.

**Touched files:**
- `supabase/migrations/20260914000001_lng_staff_idle_lock.sql` — the column, defaulting true, with a comment stating what switching it off exposes
- `src/lib/queries/staff.ts` — `idleLockEnabledFrom` (the one fail-safe read), `idle_lock_enabled` on `StaffRow` and `CurrentStaffMembership`, both select lists, both mappers, and `setIdleLockEnabled`
- `src/lib/queries/currentAccount.tsx` — exposes the flag on the current account, fail-safe against a still-loading or unreadable membership
- `src/lib/idleLockContext.tsx` — consumes it: `enabled` gains `&& !staffExempt`, and `canLock` is published so the chrome knows whether locking is possible at all
- `src/components/KioskStatusBar/KioskStatusBar.tsx` — hides the profile sheet's "Lock" button for an exempt person and changes the sheet's description, rather than offering a button that cannot do anything
- `src/routes/Admin.tsx` — the "Screen lock" section in the Manage sheet, the optimistic `toggleIdleLock` handler, and a "No lock screen" pill on the staff row
- `src/lib/queries/staff.test.ts` — pins the fail-safe read

---

## 1. Deploy order (this one matters)

The migration MUST be applied before this code reaches production. Both select
lists now ask PostgREST for `idle_lock_enabled`, and one of them is
`fetchCurrentStaffMembership`, which runs on the auth gate on every app load. If
the column is missing, that request errors and the gate is what breaks.

Order: shadow, verify, Meridian, then deploy the code. Per CLAUDE.md, read the
latest migration in Meridian's repo first, which was not possible from the
Windows machine this was written on (no `psql`, no `LNG_*_DB_URL`, no Meridian
checkout).

---

## 2. Manual smoke test, in plain English

1. Sign in as an admin. Go to Admin > Staff. Every row looks as it did, with no
   new pill on anybody.
2. Open Manage on a staff member. There is a "Screen lock" section with "Lock
   the screen when idle" ticked.
3. Untick it. The tick goes immediately, the sheet does not reload, and the
   staff row behind it grows a "No lock screen" pill.
4. Close and reopen the sheet. Still unticked, so it was saved and not just
   held in the page.
5. Sign in as that staff member on a tablet. Leave it untouched for six
   minutes. It never locks.
6. Open their profile sheet from the status bar. There is no "Lock" button, and
   the description says the lock screen is switched off for this account.
7. Sign back in as the admin, tick the switch on again, and repeat step 5 as
   that staff member. It locks after five minutes as before, and the "Lock"
   button is back.
8. Leave a different, untouched staff member alone throughout. They lock after
   five minutes, proving the exemption is per person and not global.

---

## 3. What is deliberately not here

- **No audit trail.** Switching off a security control on a device holding
  patient records is exactly the kind of change UK GDPR accountability wants a
  record of, but no staff permission change in Lounge is audited today, and
  adding it for this one flag alone would be inconsistent and misleading. It
  belongs as its own piece of work covering every `lng_staff_members` write.
- **No Playwright E2E.** The flow needs a real signed-in staff member and a
  six-minute wait; the existing suite has no fixture for either. The unit test
  covers the part that can silently go wrong.

---

## 4. Verification done

- `tsc --noEmit` clean.
- `eslint` clean on every touched and new file. The one warning in `Admin.tsx`
  (`react-hooks/exhaustive-deps` at line 2434) is pre-existing and untouched.
- `src/lib/queries/staff.test.ts` 4/4, `src/lib/idleLock.test.ts` 19/19.
- `npm run build:staff` green.
- Not verified: anything requiring the database. The column does not exist yet.

---

## 5. Notes / follow-ups

- **The fail-safe read is the fragile part.** `idleLockEnabledFrom` is
  `raw !== false`, not the `raw === true` every other flag in `staff.ts` uses.
  Making it "consistent" with its neighbours would exempt every staff member at
  once, silently. It is one exported function with a test naming that exact
  mistake, so the rule lives in one place instead of three.
- **An exempt tablet never auto-locks and can no longer be locked by hand.**
  Those are the same switch. If stepping away should still be possible for an
  exempt person, the lock's `enabled` needs splitting into "auto-lock" and
  "lock allowed", which is a bigger change than this one.
