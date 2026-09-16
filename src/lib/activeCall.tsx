import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { supabase } from './supabase.ts';
import { callEdgeFunction } from './edgeFunction.ts';
import { logFailure } from './failureLog.ts';
import { useCurrentAccount } from './queries/currentAccount.tsx';

// The in-browser Twilio softphone. One agent, one active call at a
// time: the underlying Twilio Voice SDK Device is a single WebRTC
// connection, lazily created on the first call this session and kept
// alive across route navigation so the agent can keep working (check
// the patient's profile, read a previous note) without dropping the
// call. See docs/slices/voice-calls.md for the outcome-logging side
// of this feature, which is untouched by this provider — this only
// makes the audio connection real; the agent still picks the
// outcome afterward.

export type CallState = 'idle' | 'connecting' | 'ringing' | 'in-call' | 'muted' | 'ended' | 'error';

export interface StartCallArgs {
  appointmentId: string;
  patientId: string;
  patientPhone: string;
  patientName: string;
}

interface ActiveCallValue {
  state: CallState;
  appointmentId: string | null;
  patientName: string | null;
  elapsedSeconds: number;
  errorMessage: string | null;
  startCall: (args: StartCallArgs) => Promise<void>;
  hangUp: () => void;
  toggleMute: () => void;
  /** Subscribe to a call ending. Returns an unsubscribe function. Not
   *  a context value itself, so a mounted appointment page can react
   *  without triggering re-renders on every tick of every other
   *  subscriber. */
  onCallEnded: (cb: (info: { appointmentId: string }) => void) => () => void;
}

const ActiveCallContext = createContext<ActiveCallValue | null>(null);

// Deliberately loose typing for the Twilio SDK's Device/Call — the
// SDK is only ever dynamically imported (see startCall below) so
// staff who never place a voice call never download it. A static
// type-only import would still be fine (erased at build time) but
// there is no @types package separate from the SDK's own bundled
// types, and importing purely for types pulls the whole module graph
// into `tsc`'s resolution either way, so the minimal, honest shape
// used here is what's actually called.
interface TwilioCall {
  on: (event: 'accept' | 'disconnect' | 'error', cb: (arg?: unknown) => void) => void;
  disconnect: () => void;
  mute: (shouldMute: boolean) => void;
  isMuted: () => boolean;
}
interface TwilioDevice {
  register: () => Promise<void>;
  destroy: () => void;
  updateToken: (token: string) => void;
  connect: (opts: { params: Record<string, string> }) => Promise<TwilioCall>;
  on: (event: 'tokenWillExpire', cb: () => void) => void;
}

export function ActiveCallProvider({ children }: { children: ReactNode }) {
  const { account } = useCurrentAccount();
  const [state, setState] = useState<CallState>('idle');
  const [appointmentId, setAppointmentId] = useState<string | null>(null);
  const [patientName, setPatientName] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const deviceRef = useRef<TwilioDevice | null>(null);
  const callRef = useRef<TwilioCall | null>(null);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const listenersRef = useRef<Set<(info: { appointmentId: string }) => void>>(new Set());

  const clearElapsedTimer = useCallback(() => {
    if (elapsedIntervalRef.current !== null) {
      clearInterval(elapsedIntervalRef.current);
      elapsedIntervalRef.current = null;
    }
  }, []);

  const mintToken = useCallback(async (): Promise<string> => {
    const result = await callEdgeFunction<{ ok: boolean; token?: string; error?: string }>(
      'twilio-voice-token',
      {},
    );
    if (!result.ok || !result.body.token) {
      throw new Error(result.body.error ?? 'Could not start the call: token request failed');
    }
    return result.body.token;
  }, []);

  const teardown = useCallback(() => {
    clearElapsedTimer();
    callRef.current = null;
    if (deviceRef.current) {
      try {
        deviceRef.current.destroy();
      } catch {
        // Already torn down, or never fully registered — nothing left to clean up.
      }
    }
    deviceRef.current = null;
  }, [clearElapsedTimer]);

  const startCall = useCallback(
    async (args: StartCallArgs) => {
      if (state !== 'idle' && state !== 'ended' && state !== 'error') {
        return; // A call is already active elsewhere; VoiceCallActionCard disables the button for this case.
      }
      setErrorMessage(null);
      setAppointmentId(args.appointmentId);
      setPatientName(args.patientName);
      setState('connecting');

      try {
        const { data: session, error: sessionErr } = await supabase
          .from('lng_voice_call_sessions')
          .insert({
            appointment_id: args.appointmentId,
            patient_id: args.patientId,
            created_by: account?.account_id ?? null,
            to_phone: args.patientPhone,
          })
          .select('id')
          .single();
        if (sessionErr || !session) {
          throw new Error(sessionErr?.message ?? 'Could not create a call session');
        }
        const sessionId = (session as { id: string }).id;

        const token = await mintToken();
        const { Device } = await import('@twilio/voice-sdk');
        const device = new Device(token, { logLevel: 'error' }) as unknown as TwilioDevice;
        deviceRef.current = device;
        await device.register();
        device.on('tokenWillExpire', () => {
          mintToken()
            .then((fresh) => device.updateToken(fresh))
            .catch((e) =>
              logFailure({
                source: 'activeCall.tokenWillExpire',
                severity: 'warning',
                message: e instanceof Error ? e.message : String(e),
                context: { appointmentId: args.appointmentId },
              }),
            );
        });

        const call = await device.connect({
          params: { sessionId, To: args.patientPhone },
        });
        callRef.current = call;
        setState('ringing');

        call.on('accept', () => {
          setState('in-call');
          setElapsedSeconds(0);
          clearElapsedTimer();
          elapsedIntervalRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
        });
        call.on('disconnect', () => {
          const endedAppointmentId = args.appointmentId;
          teardown();
          setState('ended');
          for (const cb of listenersRef.current) cb({ appointmentId: endedAppointmentId });
          setTimeout(() => {
            setState((current) => (current === 'ended' ? 'idle' : current));
            setAppointmentId(null);
            setPatientName(null);
          }, 1500);
        });
        call.on('error', (err) => {
          const message = err instanceof Error ? err.message : 'The call failed';
          teardown();
          setState('error');
          setErrorMessage(message);
          logFailure({
            source: 'activeCall.callError',
            severity: 'error',
            message,
            context: { appointmentId: args.appointmentId },
          });
        });
      } catch (e) {
        teardown();
        setState('error');
        const message = e instanceof Error ? e.message : 'Could not place the call';
        setErrorMessage(message);
        await logFailure({
          source: 'activeCall.startCall',
          severity: 'error',
          message,
          context: { appointmentId: args.appointmentId },
        });
      }
    },
    [state, account?.account_id, mintToken, teardown, clearElapsedTimer],
  );

  const hangUp = useCallback(() => {
    callRef.current?.disconnect();
  }, []);

  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    const next = !call.isMuted();
    call.mute(next);
    setState(next ? 'muted' : 'in-call');
  }, []);

  const onCallEnded = useCallback((cb: (info: { appointmentId: string }) => void) => {
    listenersRef.current.add(cb);
    return () => {
      listenersRef.current.delete(cb);
    };
  }, []);

  useEffect(() => clearElapsedTimer, [clearElapsedTimer]);

  const value = useMemo<ActiveCallValue>(
    () => ({
      state,
      appointmentId,
      patientName,
      elapsedSeconds,
      errorMessage,
      startCall,
      hangUp,
      toggleMute,
      onCallEnded,
    }),
    [state, appointmentId, patientName, elapsedSeconds, errorMessage, startCall, hangUp, toggleMute, onCallEnded],
  );

  return <ActiveCallContext.Provider value={value}>{children}</ActiveCallContext.Provider>;
}

export function useActiveCall(): ActiveCallValue {
  const ctx = useContext(ActiveCallContext);
  if (ctx === null) {
    throw new Error('useActiveCall must be used inside <ActiveCallProvider>. Check the component tree in App.tsx.');
  }
  return ctx;
}
