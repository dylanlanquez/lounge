import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useCurrentAccount } from './queries/currentAccount.tsx';

// Voice call mode.
//
// A voice call agent works a diary of phone calls. The clinic floor
// (walk-ins, the in-clinic board, quick sale, cash, admin) is noise to
// them, so the app has a second mode that quietens all of it:
//
//   * the Schedule shows voice calls only, with a next-call hero and the
//     day's call counts in place of the clinic toolbar;
//   * the bottom nav drops to Schedule, Patients and Ledger;
//   * the top bar hides every admin and money destination;
//   * the notifications bell shows voice call notifications only.
//
// The switch lives in the top bar for staff flagged is_voice_call_agent
// and for admins (Dylan, 15 Sep 2026: admins get the toggle too, so
// they can see the agents' view without being counted as capacity). An
// agent with no other permissions starts in voice call mode; an admin
// starts in clinic mode and switches when they sit down to the phones. The choice
// is remembered per staff member on this device, so a shared iPad does
// not leak one person's mode onto the next.
//
// Mode is a view preference, not a permission: nothing here grants or
// removes access. Route gates keep enforcing the real permission flags.

interface VoiceCallModeValue {
  /** The signed-in staff member is a voice call agent, so the switch exists. */
  available: boolean;
  /** Voice call mode is on. Always false when not available. */
  active: boolean;
  setActive: (next: boolean) => void;
}

const VoiceCallModeContext = createContext<VoiceCallModeValue | null>(null);

function storageKey(staffMemberId: string): string {
  return `lng.voiceCallMode.${staffMemberId}`;
}

// null = nothing stored yet (first sign-in on this device).
function readStored(staffMemberId: string): boolean | null {
  try {
    const raw = localStorage.getItem(storageKey(staffMemberId));
    if (raw === 'on') return true;
    if (raw === 'off') return false;
    return null;
  } catch {
    // Private mode / blocked storage: the default applies every time.
    return null;
  }
}

function writeStored(staffMemberId: string, value: boolean): void {
  try {
    localStorage.setItem(storageKey(staffMemberId), value ? 'on' : 'off');
  } catch {
    // Same as above: the mode still applies for this session.
  }
}

export function VoiceCallModeProvider({ children }: { children: ReactNode }) {
  const { account } = useCurrentAccount();
  const staffMemberId = account?.staff_member_id ?? null;
  const available =
    account?.is_voice_call_agent === true || account?.is_admin === true || account?.is_super_admin === true;
  const defaultOn = account?.is_voice_call_only === true;
  // Bumped on every write so the memo below re-reads storage. Reading
  // synchronously (rather than in an effect) means the first paint
  // after sign-in is already in the right mode: no clinic-to-voice
  // flicker for an agent.
  const [tick, setTick] = useState(0);

  const active = useMemo(() => {
    if (!available || !staffMemberId) return false;
    const stored = readStored(staffMemberId);
    return stored ?? defaultOn;
    // tick is a dependency on purpose: it is what invalidates the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, staffMemberId, defaultOn, tick]);

  const setActive = useCallback(
    (next: boolean) => {
      if (!available || !staffMemberId) return;
      writeStored(staffMemberId, next);
      setTick((t) => t + 1);
    },
    [available, staffMemberId],
  );

  const value = useMemo<VoiceCallModeValue>(
    () => ({ available, active, setActive }),
    [available, active, setActive],
  );

  return <VoiceCallModeContext.Provider value={value}>{children}</VoiceCallModeContext.Provider>;
}

export function useVoiceCallMode(): VoiceCallModeValue {
  const ctx = useContext(VoiceCallModeContext);
  if (ctx === null) {
    throw new Error(
      'useVoiceCallMode must be used inside <VoiceCallModeProvider>. Check the component tree in App.tsx.',
    );
  }
  return ctx;
}
