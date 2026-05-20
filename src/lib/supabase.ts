import { createClient } from '@supabase/supabase-js';
import { env } from './env.ts';

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // detectSessionInUrl must be true. Every Lounge auth flow that
    // round-trips through Supabase (staff invite → lng-accept-invite
    // → action_link → /welcome, password reset, sign-in magic link)
    // ends with Supabase redirecting back to a Lounge URL that
    // carries #access_token=... in the hash. With this off, supabase-
    // js ignores the hash, the session never hydrates, AuthProvider
    // stays anonymous, and the user lands on a "link no longer valid"
    // page even though Supabase actually verified them.
    //
    // The flag was set false in the Phase 1 scaffold ("tablet does
    // not handle OAuth-redirect URL parsing") long before any of
    // these auth flows existed. The receptionist tablet PIN flow
    // does not use URL hashes — it submits PIN entry to a function
    // — so flipping this back on does not affect it.
    detectSessionInUrl: true,
  },
});
