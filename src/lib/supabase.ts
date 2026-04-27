import { createClient } from '@supabase/supabase-js';
import { env } from './env.ts';

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Tablet does not handle OAuth-redirect URL parsing; receptionist signs in via PIN flow.
    detectSessionInUrl: false,
  },
});
