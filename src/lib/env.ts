// Validated, typed environment variables.
// Per brief §1: no silent fallbacks. Missing required vars throw at boot.

function required(key: string): string {
  const value = (import.meta.env as Record<string, string | undefined>)[key];
  if (!value || value.length === 0) {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
        `Copy .env.example to .env.local and fill it in.`
    );
  }
  return value;
}

function optional(key: string): string | undefined {
  const value = (import.meta.env as Record<string, string | undefined>)[key];
  return value && value.length > 0 ? value : undefined;
}

export const env = {
  SUPABASE_URL: required('VITE_SUPABASE_URL'),
  SUPABASE_ANON_KEY: required('VITE_SUPABASE_ANON_KEY'),
  STRIPE_PUBLISHABLE_KEY: optional('VITE_STRIPE_PUBLISHABLE_KEY'),
  STRIPE_EXPECTED_ACCOUNT_ID: optional('VITE_STRIPE_EXPECTED_ACCOUNT_ID'),
} as const;
