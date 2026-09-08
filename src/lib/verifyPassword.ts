import { createClient } from '@supabase/supabase-js';
import { env } from './env.ts';

// Check a password WITHOUT touching the signed-in session.
//
// The obvious implementation of an unlock screen is
// supabase.auth.signInWithPassword() on the app's own client. That works, and
// it costs more than it looks:
//
//   • It mints a brand new session at aal1. A staff member whose row sets
//     require_2fa would clear the lock and be thrown straight into
//     /verify-2fa, which navigates away from the route they were on and so
//     destroys exactly the in-progress work the lock is designed to preserve.
//   • Every consumer of the auth context sees a session swap, for a person
//     who never actually left.
//
// So the check runs on a throwaway client instead. Separate storageKey and
// persistSession: false mean it shares no storage and no gotrue lock with the
// real client, writes nothing, and leaves the live session's tokens, AAL and
// expiry exactly as they were. All we want from it is the yes or no.
//
// A wrong password is an ordinary answer here, not a failure, so this returns
// a result rather than throwing. Anything that is not a credentials rejection
// is surfaced as its own message: "wrong password" and "gotrue is unreachable"
// must never look the same to someone standing at a locked tablet.
const verifier = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    storageKey: 'lng-password-verifier',
  },
});

export type PasswordCheck =
  | { ok: true }
  | { ok: false; reason: 'wrong_password' }
  | { ok: false; reason: 'error'; message: string };

export async function verifyPassword(email: string, password: string): Promise<PasswordCheck> {
  const { data, error } = await verifier.auth.signInWithPassword({ email, password });
  if (error) {
    // gotrue answers a bad email/password pair with 400 invalid_credentials.
    // Everything else (429 rate limit, 5xx, network) is a different story and
    // gets told as one.
    const invalid =
      error.code === 'invalid_credentials' ||
      error.status === 400 ||
      /invalid login credentials/i.test(error.message);
    return invalid ? { ok: false, reason: 'wrong_password' } : { ok: false, reason: 'error', message: error.message };
  }
  if (!data.session) {
    return { ok: false, reason: 'error', message: 'Sign in returned no session.' };
  }
  // Drop the throwaway session locally. Scope matters: a global sign-out here
  // would revoke every session for this user, including the live one behind
  // the lock, and the person who just proved who they are would be signed
  // out of the tablet instead of let back in.
  await verifier.auth.signOut({ scope: 'local' }).catch(() => {});
  return { ok: true };
}
