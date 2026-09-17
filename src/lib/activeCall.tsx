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
  // Exposed so CallBar can watch lng_voice_call_listeners for this
  // call and show an "an admin has joined" indicator — see
  // CallBar.tsx's ADMIN_JOINED_INDICATOR_ENABLED flag.
  sessionId: string | null;
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
  onCallEnded: (cb: (info: { appointmentId: string; sessionId: string }) => void) => () => void;
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
interface DeviceError {
  message?: string;
  code?: number;
}
interface TwilioCall {
  on: (event: 'accept' | 'disconnect' | 'error', cb: (arg?: DeviceError) => void) => void;
  disconnect: () => void;
  mute: (shouldMute: boolean) => void;
  isMuted: () => boolean;
}
// Twilio's own message for these is accurate but reads like a stack
// trace, not something to show a receptionist mid-shift. 31401/31402
// are the SDK's getUserMedia failure codes (denied vs no device/track
// found) — the two an agent will actually hit if their browser or OS
// hasn't granted mic access to this site yet.
function friendlyCallErrorMessage(err: DeviceError | undefined): string {
  if (err?.code === 31401) {
    return 'Microphone access is blocked. Allow microphone access for this site in your browser, then try again.';
  }
  if (err?.code === 31402) {
    return 'No microphone was found. Check a microphone is connected and try again.';
  }
  return err?.message ?? 'The call failed';
}

// Checked before anything else in startCall, not left for the Twilio
// SDK to discover deep inside device.connect(). Without this, the
// button shows "Connecting…" then briefly "Ringing…" — device.connect()
// resolves locally before the SDK's own getUserMedia call fails, so
// the agent sees the call apparently progress for a few seconds
// before it errors out, which reads as "it rang but nothing happened"
// rather than what actually happened: the call was never placed
// because the browser couldn't get the microphone. Failing here
// first also means no lng_voice_call_sessions row or Twilio token is
// created for a call that was never going to happen. A permission
// denial reads as DOMException NotAllowedError; no device at all
// reads as NotFoundError — mapped to the same two messages
// friendlyCallErrorMessage uses for the SDK's own 31401/31402.
async function ensureMicrophoneAccess(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      `This browser has no microphone API available (navigator.mediaDevices${navigator.mediaDevices ? '.getUserMedia' : ''} is missing). Try a different browser or check for a policy disabling media access.`,
    );
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    // Distinguish real permission denials (the common, expected case,
    // with a friendly fix) from anything else, which we surface
    // verbatim rather than guessing — an earlier version of this
    // collapsed every failure into "access is blocked" regardless of
    // the real cause, which hid a genuine misdiagnosis from Dylan
    // when the Mac/Chrome/extension permission chain checked out
    // clean but the call still failed instantly.
    const name = e instanceof DOMException ? e.name : e instanceof Error ? e.name : 'UnknownError';
    const detail = e instanceof Error ? e.message : String(e);
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      throw new Error('No microphone was found. Check a microphone is connected and try again.');
    }
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      throw new Error(
        `Microphone access is blocked (${name}). Allow microphone access for this site in your browser, then try again. On a Mac, also check System Settings, Privacy and Security, Microphone, and make sure your browser is allowed there.`,
      );
    }
    throw new Error(`Could not access the microphone: ${name} — ${detail}`);
  }
  // Only checking access is possible here; the Voice SDK opens its
  // own stream when the call actually connects. Release this one
  // immediately rather than holding two open media streams.
  for (const track of stream.getTracks()) track.stop();
}

interface TwilioDevice {
  register: () => Promise<void>;
  destroy: () => void;
  updateToken: (token: string) => void;
  connect: (opts: { params: Record<string, string> }) => Promise<TwilioCall>;
  on: (event: 'tokenWillExpire' | 'error', cb: (arg?: DeviceError) => void) => void;
}

export function ActiveCallProvider({ children }: { children: ReactNode }) {
  const { account } = useCurrentAccount();
  const [state, setState] = useState<CallState>('idle');
  const [appointmentId, setAppointmentId] = useState<string | null>(null);
  const [sessionIdState, setSessionIdState] = useState<string | null>(null);
  const [patientName, setPatientName] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const deviceRef = useRef<TwilioDevice | null>(null);
  const callRef = useRef<TwilioCall | null>(null);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const listenersRef = useRef<Set<(info: { appointmentId: string; sessionId: string }) => void>>(new Set());

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
        await ensureMicrophoneAccess();

        // A redial on this same appointment (no answer, tried again,
        // etc) leaves its earlier attempt's session row open forever
        // if that attempt never reached a Twilio-reported terminal
        // status — closing every other still-open session for this
        // appointment before starting a new one keeps Admin -> Calls'
        // "Live now" panel from showing a superseded attempt as
        // though it were still happening.
        await supabase.rpc('lng_close_stale_voice_call_sessions', {
          p_appointment_id: args.appointmentId,
          p_except_session_id: null,
        });

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
        setSessionIdState(sessionId);

        const token = await mintToken();
        const { Device } = await import('@twilio/voice-sdk');
        const device = new Device(token, { logLevel: 'error' }) as unknown as TwilioDevice;
        deviceRef.current = device;
        // device.register()/connect() reject with `undefined` on a
        // signaling error (e.g. an invalid Access Token), not the
        // TwilioError describing what actually happened — that only
        // ever surfaces via this 'error' event. Capturing it here is
        // the only way startCall's catch block below can report
        // anything more useful than "the call failed" when that
        // happens (confirmed by reproducing a real
        // AccessTokenInvalid failure against Twilio's own servers).
        let lastDeviceError: DeviceError | undefined;
        device.on('error', (err) => {
          lastDeviceError = err;
        });
        try {
          await device.register();
        } catch (e) {
          throw e instanceof Error && !lastDeviceError ? e : new Error(friendlyCallErrorMessage(lastDeviceError));
        }
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

        let call: TwilioCall;
        try {
          call = await device.connect({
            params: { sessionId, To: args.patientPhone },
          });
        } catch (e) {
          throw e instanceof Error && !lastDeviceError ? e : new Error(friendlyCallErrorMessage(lastDeviceError));
        }
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
          for (const cb of listenersRef.current) cb({ appointmentId: endedAppointmentId, sessionId });
          setTimeout(() => {
            setState((current) => (current === 'ended' ? 'idle' : current));
            setAppointmentId(null);
            setSessionIdState(null);
            setPatientName(null);
          }, 1500);
        });
        call.on('error', (err) => {
          teardown();
          setState('error');
          setErrorMessage(friendlyCallErrorMessage(err));
          logFailure({
            source: 'activeCall.callError',
            severity: 'error',
            message: err?.message ?? 'The call failed',
            context: { appointmentId: args.appointmentId, code: err?.code },
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

  const onCallEnded = useCallback((cb: (info: { appointmentId: string; sessionId: string }) => void) => {
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
      sessionId: sessionIdState,
      patientName,
      elapsedSeconds,
      errorMessage,
      startCall,
      hangUp,
      toggleMute,
      onCallEnded,
    }),
    [state, appointmentId, sessionIdState, patientName, elapsedSeconds, errorMessage, startCall, hangUp, toggleMute, onCallEnded],
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
