import { useEffect, useState } from 'react';
import { supabase } from './supabase.ts';
import { useAuth } from './auth.tsx';

// MFA helpers used by the auth gate (RequireStaff in App.tsx) and the
// /enroll-2fa + /verify-2fa surfaces. Wraps Supabase's
// supabase.auth.mfa.* primitives in a hook that:
//
//   • Reports the current AAL ('aal1' | 'aal2') of the live session.
//   • Reports whether the user has a verified TOTP factor enrolled.
//   • Re-runs whenever auth state changes (sign-in, mfa.verify, sign-out).
//
// The auth gate uses these two facts together with the staff's
// require_2fa flag (from lng_staff_members) to decide:
//
//   require_2fa && aal === 'aal1' && hasVerifiedFactor   → /verify-2fa
//   require_2fa && aal === 'aal1' && !hasVerifiedFactor  → /enroll-2fa
//   otherwise                                            → through
//
// We deliberately don't read the AAL from the JWT's app_metadata —
// supabase.auth.mfa.getAuthenticatorAssuranceLevel is the supported
// API and stays correct across SDK changes.

export type Aal = 'aal1' | 'aal2';

export interface MfaStatus {
  loading: boolean;
  aal: Aal | null;
  // True when the user has at least one verified TOTP factor.
  // Phone factors are treated the same way; we just don't enrol them.
  hasVerifiedFactor: boolean;
  // The verified factor id, if any. Used by /verify-2fa to challenge.
  verifiedFactorId: string | null;
  refresh: () => void;
  error: string | null;
}

export function useMfaStatus(): MfaStatus {
  const { session, loading: authLoading } = useAuth();
  const [aal, setAal] = useState<Aal | null>(null);
  const [hasVerifiedFactor, setHasVerifiedFactor] = useState(false);
  const [verifiedFactorId, setVerifiedFactorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (authLoading) return;
    if (!session) {
      setAal(null);
      setHasVerifiedFactor(false);
      setVerifiedFactorId(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const aalRes = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        const factors = await supabase.auth.mfa.listFactors();
        if (cancelled) return;
        if (aalRes.error) throw new Error(aalRes.error.message);
        if (factors.error) throw new Error(factors.error.message);
        const verifiedTotp = (factors.data?.totp ?? []).find((f) => f.status === 'verified');
        const currentAal = (aalRes.data?.currentLevel as Aal | null) ?? null;
        setAal(currentAal);
        setHasVerifiedFactor(!!verifiedTotp);
        setVerifiedFactorId(verifiedTotp?.id ?? null);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, authLoading, tick]);

  return {
    loading: authLoading || loading,
    aal,
    hasVerifiedFactor,
    verifiedFactorId,
    error,
    refresh: () => setTick((t) => t + 1),
  };
}

// Drops every unverified TOTP factor for the current user. We call
// this at the top of /enroll-2fa so a half-completed enrolment from
// a previous attempt doesn't shadow a fresh one.
export async function purgeUnverifiedFactors(): Promise<void> {
  const factors = await supabase.auth.mfa.listFactors();
  if (factors.error) return;
  const stale = (factors.data?.totp ?? []).filter((f) => f.status !== 'verified');
  for (const f of stale) {
    await supabase.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
  }
}

// Initiates a fresh TOTP enrolment. Returns the QR code SVG, the
// otpauth URI (for manual entry), the totp secret, and the factor
// id required to verify the first code.
export async function startTotpEnrolment(): Promise<{
  factorId: string;
  qrSvg: string;
  uri: string;
  secret: string;
}> {
  await purgeUnverifiedFactors();
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Lounge authenticator',
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Enrolment did not return a factor.');
  return {
    factorId: data.id,
    qrSvg: data.totp.qr_code,
    uri: data.totp.uri,
    secret: data.totp.secret,
  };
}

// Verifies a TOTP code against an in-flight enrolment OR an existing
// verified factor. Both paths call mfa.challenge then mfa.verify;
// the only difference is whether the factor was newly minted.
export async function verifyTotp(args: { factorId: string; code: string }): Promise<void> {
  const challenge = await supabase.auth.mfa.challenge({ factorId: args.factorId });
  if (challenge.error) throw new Error(challenge.error.message);
  if (!challenge.data) throw new Error('Could not start MFA challenge.');
  const verify = await supabase.auth.mfa.verify({
    factorId: args.factorId,
    challengeId: challenge.data.id,
    code: args.code.trim(),
  });
  if (verify.error) throw new Error(verify.error.message);
}
