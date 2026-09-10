import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase.ts';

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedInUserId, setSignedInUserId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let settled = false;

    // Bootstrap is "settled" the first time any signal arrives. Once
    // settled, `loading` is false forever — no later event can push
    // the app back into the Loading… fallback. The session pointer
    // still updates on subsequent onAuthStateChange events (SIGNED_IN,
    // SIGNED_OUT, TOKEN_REFRESHED) without touching `loading`.
    //
    // This shape replaces the previous getSession-only bootstrap which
    // could permanently hang on "Loading…" when getSession() rejected.
    // gotrue-js can reject getSession() during navigator.locks orphan
    // recovery, when the persisted token is malformed, or when a token
    // refresh inside the call fails. The old code had no .catch() on
    // the promise, so a rejection silently left loading=true and the
    // app stuck on the route fallback — exactly the symptom reported
    // in the field every few days.
    const settleBootstrap = (s: Session | null) => {
      if (!mounted || settled) return;
      settled = true;
      setSession(s);
      setLoading(false);
    };

    // Primary signal — onAuthStateChange emits INITIAL_SESSION exactly
    // once after the auth client finishes restoring from storage (with
    // s=null when there is no session). Even when the navigator.locks
    // orphan-recovery path fires inside gotrue, INITIAL_SESSION still
    // emits when initialization completes.
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (!mounted) return;
      if (event === 'INITIAL_SESSION') {
        settleBootstrap(s);
        return;
      }
      setSession(s);
      // Note the sign-in; do not act on it here. Anything that talks to
      // Supabase from inside this callback holds the auth lock hostage — see
      // the effect below for why. setState is safe, it touches nothing.
      if (event === 'SIGNED_IN' && s?.user?.id) setSignedInUserId(s.user.id);
    });

    // Fast-path. Resolves immediately when the session is already in
    // memory, short-cutting the wait for INITIAL_SESSION. A rejection
    // here is non-fatal: the auth-state subscription is the canonical
    // signal, and the watchdog below will catch any case where neither
    // path settles.
    supabase.auth.getSession()
      .then(({ data }) => settleBootstrap(data.session))
      .catch((err) => {
        console.error('[auth] getSession() rejected during bootstrap', err);
      });

    // Defence in depth — if 12 seconds pass without either Supabase
    // path settling (e.g., a future regression introduces a third
    // hang path), give up and treat the user as signed out. The
    // RequireStaff gate will then route them to /sign-in where they
    // can recover. Without this, an unsettled bootstrap traps the
    // user on the Loading… fallback with no way out short of
    // wiping site data.
    const watchdog = window.setTimeout(() => {
      if (!mounted || settled) return;
      console.error(
        '[auth] watchdog: auth bootstrap did not settle within 12s; treating as signed out so the user can retry from /sign-in.',
      );
      settleBootstrap(null);
    }, 12_000);

    return () => {
      mounted = false;
      window.clearTimeout(watchdog);
      sub.subscription.unsubscribe();
    };
  }, []);

  // Record every successful sign-in so Admin > Staff can show "Last active".
  //
  // This runs in an effect, not in the onAuthStateChange callback where it used
  // to live, and the distinction is the whole point. gotrue invokes subscriber
  // callbacks from inside its own lock and awaits them, so a callback runs while
  // lock:sb-<ref>-auth-token is held. Starting this RPC there enqueued a nested
  // acquisition on gotrue's pendingInLock, and the lock holder drains that queue
  // before releasing — so `void`-ing the promise bought nothing, gotrue awaited
  // it for us and kept the lock for the whole round trip. Past 5000ms every
  // other waiter steals the lock and its victim's request dies with "Lock broken
  // by another request with the 'steal' option".
  //
  // An effect runs after render, long after the callback returned and the lock
  // was released. Keyed on the id rather than on the session so a token refresh
  // does not re-record; set only by the SIGNED_IN event, so restoring a session
  // on reload is not mistaken for a fresh sign-in.
  //
  // Still fire-and-forget: a network blip must never block sign-in. The RPC is
  // SECURITY DEFINER and self-scoped (writes only the caller's
  // lng_staff_members row), so there's no privilege surface to worry about.
  useEffect(() => {
    if (!signedInUserId) return;
    void (async () => {
      try {
        await supabase.rpc('lng_record_staff_sign_in');
      } catch {
        /* never block sign-in on an admin-side write */
      }
    })();
  }, [signedInUserId]);

  const signIn: AuthContextValue['signIn'] = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user: session?.user ?? null, session, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
