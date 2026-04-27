# Slice 01 — Receptionist sign-in

**Status:** Draft, awaiting Phase 2 design-system sign-off before implementation
**Phase:** 3 (per brief §10.1, slice 1)
**Depends on:** Phase 1 migrations applied (specifically `20260428_03_lab_role_receptionist`, `20260428_04_auth_is_receptionist`, `20260428_13_lng_receptionist_sessions`, `20260428_17_lng_rls_policies`)
**Related docs:**
- `docs/01-architecture-decision.md §4` (ADR-004, receptionist role)
- `docs/02-data-protection.md §3` (tablet-specific controls)
- `docs/06-patient-identity.md §10.3` (no shared accounts)

---

## 1. User story

> As a receptionist at Motherwell, I sign in once on the tablet with my email and a 6-digit PIN. My session persists across the day so I am not asked to re-authenticate every time I open the app. After 60 seconds of inactivity the screen locks; I re-enter my PIN to unlock. At end of shift I tap "Sign out" and the next person can sign in to their account.

The brief's working assumption is one tablet at the Motherwell counter and one or two named receptionists. This slice supports that, plus admin-side device revocation if a tablet is lost.

---

## 2. Acceptance criteria

### 2.1 First-time sign-in

- [ ] Sign-in screen accepts email (full text input) and 6-digit PIN (numeric keypad, scrambled-keypad option from `lng_settings.epos.pin_scrambled` boolean — defaults to false).
- [ ] Email lookup is **server-side only**: the client never knows whether an email exists in the system until PIN is also submitted (no email-enumeration leak).
- [ ] Account must have:
  - `accounts.status = 'active'`
  - At least one `location_members` row with `lab_role = 'receptionist'` and `status = 'active'`
- [ ] On success: a `lng_receptionist_sessions` row is created (`device_id` from a stable client-generated UUID stored in localStorage; `account_id`, `location_id`, `signed_in_at = now()`, `last_seen_at = now()`, `user_agent`, `ip_inet`).
- [ ] On success: receptionist lands on the home screen at `/`.
- [ ] First-time sign-in time-to-home: **under 1.5 seconds** end-to-end on the Galaxy Tab WiFi.

### 2.2 Locked / idle behaviour

- [ ] After `epos.idle_lock_seconds` seconds (default 60) of no input, app dispatches a "lock" event:
  - Sets `lng_receptionist_sessions.locked_at = now()` (server-side write so admin can see lock state).
  - Renders a lock screen overlay.
  - Patient data is **blanked** behind the overlay so the next user doesn't see prior content.
- [ ] App background (visibilitychange to hidden) → immediate lock, regardless of idle timer.
- [ ] Lock screen accepts PIN only. Email is shown as a confirmation ("Locked: dylan@venneir.com") but cannot be edited.
- [ ] Wrong PIN: increment `lng_receptionist_sessions.failed_pin_count` and set `failed_pin_at = now()`.
- [ ] Rate limit: after **3** failed PINs, lock the unlock screen for **30 seconds**. After **6**, lock for **5 minutes**. Counter resets on successful unlock.
- [ ] Server enforces the rate limit (counter and `failed_pin_at` checked in the edge function).
- [ ] On successful unlock: clear `locked_at`, reset `failed_pin_count`, update `last_seen_at`. No new session is created — same row continues.

### 2.3 Sign-out

- [ ] "Sign out" button in the receptionist menu sets `lng_receptionist_sessions.ended_at = now()`.
- [ ] App returns to the sign-in screen.
- [ ] Local Supabase Auth session is also cleared (`supabase.auth.signOut()`).

### 2.4 Admin revocation (lost / stolen tablet)

- [ ] `/admin/devices` lists all `lng_receptionist_sessions` (active and ended) for the current admin's locations.
- [ ] Each row has a "Revoke" button → sets `revoked_at = now()`, `revoked_by = admin's account_id`.
- [ ] Bulk action: "Revoke all sessions for device X" applies to every row sharing that `device_id`.
- [ ] On the revoked tablet's next request: server rejects with 401 → app drops to the sign-in screen.
- [ ] Revoke action writes a `lng_event_log` row (`event_type = 'session_revoked'`, payload includes the revoked session id).

### 2.5 Multi-device, single account

- [ ] One receptionist can have an active session on more than one device simultaneously (e.g. moves to a second tablet without signing out the first).
- [ ] Sign-out on device A does not affect the session on device B.
- [ ] Admin sees both as separate rows in `/admin/devices`.

### 2.6 Failure logging

- [ ] Every failed PIN attempt writes a `lng_event_log` row (`event_type = 'pin_attempt_failed'`, payload `{ device_id, attempt_count }`). Email is **not** logged here (no enumeration).
- [ ] Every PIN-rate-limit lockout writes a `lng_system_failures` row with `severity = 'warning'`.
- [ ] Every Supabase Auth error during sign-in writes a `lng_system_failures` row.

---

## 3. Smoke test (plain English, per brief §1)

> Sarah arrives at the Motherwell desk at 09:00. The tablet is showing the sign-in screen. She types her email, then her 6-digit PIN. Within 1 second she sees the home screen. She uses the app for 30 minutes processing two walk-ins. She steps away for tea. After 60 seconds, the screen locks. She returns 5 minutes later, taps the screen, types her PIN. The lock clears and she's exactly where she was. At 17:00 she taps her name in the corner and chooses "Sign out". The tablet returns to the sign-in screen. Mark, the next-shift receptionist, types his email and PIN and sees his own home screen.

If a non-technical person can describe each of those moments and confirm it happens, the slice is done.

---

## 4. Data model touches

| Table | Operation | Fields |
|---|---|---|
| `accounts` | READ | `id`, `auth_user_id`, `login_email`, `status`, `member_type`, `account_type`, `internal_sub_type` |
| `location_members` | READ | `account_id`, `location_id`, `lab_role`, `status` |
| `lng_receptionist_sessions` | INSERT, UPDATE | all columns; never DELETE |
| `lng_event_log` | INSERT | `event_type IN ('receptionist_signed_in', 'receptionist_signed_out', 'session_locked', 'session_unlocked', 'pin_attempt_failed', 'session_revoked')` |
| `lng_system_failures` | INSERT | severity warning/error |

No migration changes — slice 0 already has the schema.

### 4.1 Where the PIN actually lives

The PIN is stored as the **Supabase Auth password** (`auth.users.encrypted_password`). Reasoning:

- Supabase already bcrypts passwords correctly.
- Supabase already implements rate-limiting at the email level (additional safety net beyond ours).
- We don't have to build a parallel password-handling system.

Trade-off: a 6-digit PIN has only ~20 bits of entropy. Brute-force in seconds if not rate-limited. We mitigate with **server-side per-device rate limiting in the edge function** (§5.2 below) plus the fact that the tablet's local IP is known and we can reject suspicious traffic. Net: PINs are acceptable for a desk-anchored tablet but not for an internet-exposed account.

When a receptionist is created in the admin (Phase 3 slice 21), the admin sets an initial PIN. The receptionist can change it later (`/account/change-pin` — out of scope this slice; v1.5).

---

## 5. Edge functions

Two new edge functions in `supabase/functions/`:

### 5.1 `receptionist-signin`

- **Auth model:** anon key Bearer JWT (per brief §8.5).
- **Body:** `{ email: string, pin: string, device_id: string, device_label?: string }`.
- **Steps:**
  1. Validate inputs (email regex, PIN is 6 digits).
  2. Look up `accounts` by `login_email`. If not found, return generic `{ ok: false, reason: 'invalid_credentials' }` (no enumeration). **Time-pad the response to ~150ms** so non-existent emails take the same time as failed-PIN attempts.
  3. Confirm `accounts.status = 'active'` and at least one `location_members` row with `lab_role = 'receptionist'` and `status = 'active'`. If not, generic invalid_credentials.
  4. Check `lng_receptionist_sessions` for this `device_id` — if there's a row with `failed_pin_count >= 3` and `failed_pin_at + 30s > now()`, return `{ ok: false, reason: 'rate_limited', retry_after_seconds: N }`.
  5. Call Supabase Auth `signInWithPassword({ email, password: pin })`. If error, increment failed_pin_count on a session-shaped row (creating one if first attempt for this device), write `lng_event_log` `pin_attempt_failed`, return invalid_credentials.
  6. Success: insert a fresh `lng_receptionist_sessions` row, write `lng_event_log` `receptionist_signed_in`, return `{ ok: true, session_id, access_token, refresh_token, expires_at, account: { display_name, location_name } }`.
- **Service-role:** writes to `lng_receptionist_sessions`, `lng_event_log`, `lng_system_failures` use the service-role client (the user's JWT is not yet established at this point).
- **Logging:** every failed signin writes one row to `lng_event_log`. Repeated failures (count >= 3) escalate to `lng_system_failures` (severity `warning`) and (count >= 6) to severity `error`.

### 5.2 `receptionist-unlock`

- **Auth model:** authenticated user (Bearer of the receptionist's access token).
- **Body:** `{ session_id: string, pin: string }`.
- **Steps:**
  1. Validate inputs.
  2. Load `lng_receptionist_sessions` by `id`. Confirm it belongs to the caller (`account_id = auth_account_id()`). Confirm not revoked, not ended.
  3. Rate-limit check (same as 5.1).
  4. Re-verify PIN by calling `signInWithPassword` against the same email + pin (we need fresh proof; we don't store the PIN anywhere we can re-check directly).
  5. Success: clear `locked_at`, reset `failed_pin_count`, set `last_seen_at = now()`. Write `lng_event_log` `session_unlocked`. Return `{ ok: true }`.
  6. Failure: increment failed_pin_count, write `lng_event_log` `pin_attempt_failed`, return `{ ok: false, reason }`.

### 5.3 `receptionist-signout`

Could be a Supabase JS direct call rather than an edge function — `supabase.auth.signOut()` plus an UPDATE to `lng_receptionist_sessions`. The UPDATE goes through standard auth + RLS. Edge function is unnecessary; do it client-side.

### 5.4 `admin-revoke-session` (Phase 3 slice 21, not this slice)

Admin-side revocation. Out of scope here; spec lives in the admin slice.

### 5.5 Time-padding rationale

If "email not found" returns in 5ms but "wrong PIN" returns in 200ms, an attacker can enumerate valid emails by timing alone. We pad the negative path with `await Promise.allSettled([..., new Promise(r => setTimeout(r, 150))])` style so all negative paths take a similar duration.

---

## 6. UI components needed

These are produced in **Phase 2 design system** (brief §9.7); the slice consumes them.

| Component | First needed | Notes |
|---|---|---|
| `Button` (primary pill, bottom-anchored) | This slice | Primary "Sign in" button |
| `Input` (text, with label) | This slice | Email field |
| `NumericKeypad` | This slice | 6-digit PIN entry |
| `Card` | This slice | Sign-in card on the centre of the screen |
| `Toast` (error variant) | This slice | "Wrong email or PIN" feedback |
| `Skeleton` | Not this slice | (later slices) |
| `BottomSheet` | Not this slice | (later slices) |

If Phase 2 hasn't shipped these by the time this slice is implemented, **stop and finish Phase 2 first** per brief §9.1.

### 6.1 Screen-level designs (defined in Phase 2)

- **Sign-in screen.** Centred card. Lounge logo top-centre. Email field. PIN is hidden until email is entered (optional UX nicety; or both visible at once — design call).
- **Lock screen.** Black-out overlay over the previous screen. Email shown ("dylan@venneir.com") with PIN keypad.
- **Sign-out confirmation.** Bottom sheet: "Sign out of Lounge?" + cancel / confirm.

### 6.2 Hooks and state

- `useReceptionistSession()` — returns `{ session, loading, error, signIn, unlock, signOut }`. Wraps the edge functions.
- `useIdleLock(timeoutSec)` — listens for `mousedown`, `keydown`, `touchstart`, `visibilitychange`. Calls a callback when idle threshold passes. Used in the app shell.

---

## 7. Tests

### 7.1 Unit (Vitest or similar — pick in implementation)

- PIN format validator (6 digits, no letters).
- Email format validator.
- Time-padding helper returns >= 150ms for negative paths.
- `useIdleLock` fires after the configured timeout; resets on user input.

### 7.2 Integration (against a Supabase branch)

- `receptionist-signin` returns 200 + tokens for valid creds.
- Returns 401 + `invalid_credentials` for wrong PIN.
- Returns 401 + `invalid_credentials` for non-receptionist account (e.g. an admin trying to sign in via this endpoint).
- Returns 429 after 3 consecutive failures; respects `Retry-After` header.
- `receptionist-unlock` accepts the matching PIN; rejects mismatched.
- `lng_event_log` rows are written for each path (success, fail, lock, unlock).

### 7.3 Playwright (`tests/slice-01-receptionist-signin.spec.ts`)

- Sign in successfully → home screen.
- Sign in with wrong PIN → toast + can retry.
- After 3 wrong PINs, button is disabled + "Try again in 30s" countdown.
- Idle for `epos.idle_lock_seconds` → lock screen appears.
- Unlock with PIN → returns to previous screen (NOT to home).
- Sign out → sign-in screen.
- Two browser contexts simulating two devices: sign-out on device A doesn't sign out device B.

### 7.4 Manual QA on the Galaxy Tab

- Same as Playwright but on the actual hardware. Camera-distance privacy check (can someone in the queue read the email field?).

---

## 8. Out of scope (this slice)

- PIN reset flow ("I forgot my PIN") — admin sets a new one via `/admin/devices` (slice 21). v1.5 self-serve flow.
- Biometric unlock (fingerprint, face). Not in v1.
- Multi-factor auth. PIN is single-factor (something you know); the device pairing serves as a soft second factor in practice but is not formally MFA. v1.5 if needed.
- Email-based magic link sign-in. The brief specifies PIN; this is the only path.
- Forgot-PIN self-service. v1.5.

---

## 9. Open questions

| # | Question | Resolution path |
|---|---|---|
| QA1 | First-time provisioning: does the receptionist set their own PIN on first sign-in (forced change) or does admin set the initial PIN? | Recommend: admin sets initial PIN (4–6 digit), receptionist forced to change on first use. Confirm in implementation. |
| QA2 | Email casing: stored as lowercased on `accounts.login_email`? Confirm by reading existing Meridian behaviour. | Read `accounts` constraints during implementation. |
| QA3 | Should the lock screen show the full email or initials only? Privacy vs UX. | Recommend: initials + first character of email domain ("D@v…"). Confirm in design review. |
| QA4 | Do we want a "Switch user" path on the lock screen, or only "Sign out + sign in fresh"? | Recommend: only sign-out + sign-in. Avoids the social-engineering vector. |
| QA5 | Idle-lock timeout — `lng_settings` global default is 60s. Per-tablet override? | v1: global only. v1.5: per-device override. |

---

## 10. Implementation order (when this slice runs)

1. Spec sign-off (this doc).
2. UI primitive components from Phase 2: `Button`, `Input`, `Card`, `NumericKeypad`, `Toast`. **All must be in Storybook before this slice starts.**
3. Edge function `receptionist-signin` — implement, test against a Supabase branch.
4. Edge function `receptionist-unlock` — same.
5. Hooks: `useReceptionistSession`, `useIdleLock`.
6. Routes: `/sign-in` and the lock-screen overlay.
7. Tests: unit, integration, Playwright.
8. Smoke test on the Galaxy Tab in the Motherwell office.
9. Score this output. Below 90 → plan-mode improvement.
10. Ship to staging. Dylan signs off. Ship to production.

---

## 11. Self-score (current spec only — not the implementation)

| Axis | Score | Notes |
|---|---|---|
| Spec completeness | 92 | All states covered; rate-limit math explicit; revocation flow specified. |
| Security thinking | 92 | Time-padding, no enumeration, server-side rate limit. PIN entropy concern called out and mitigated. |
| UX coverage | 88 | Multi-device dependency on QA3 / QA4. Lock-screen email visibility is a design call. |
| Testability | 92 | All three test layers planned; Playwright spec name fixed. |
| Brief faithfulness | 95 | Maps exactly to brief §10.1 #1, §7.2, §10.3. |
| **Aggregate** | **91** | Above the 90 floor. Ready for sign-off pending QA1–QA5 answers. |

---

*End of slice 01 spec.*
