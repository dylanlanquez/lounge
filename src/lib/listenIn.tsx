import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { callEdgeFunction } from './edgeFunction.ts';
import { logFailure } from './failureLog.ts';

// An admin silently listening in on a call already in progress.
// Deliberately its own small provider, not folded into
// ActiveCallProvider (src/lib/activeCall.tsx) — "I am on a call" and
// "I am silently monitoring one" are different states worth not
// conflating, and an admin might in principle want to browse the app
// while listening without it looking like they're the one on the
// call. Reuses the same Twilio Voice SDK Device machinery, dynamically
// imported the same way, so staff who never listen in never download
// it either.

export type ListenInState = 'idle' | 'connecting' | 'listening' | 'ended' | 'error';

interface ListenInValue {
  state: ListenInState;
  patientName: string | null;
  errorMessage: string | null;
  startListening: (args: { sessionId: string; patientName: string }) => Promise<void>;
  stopListening: () => void;
}

const ListenInContext = createContext<ListenInValue | null>(null);

interface DeviceError {
  message?: string;
  code?: number;
}
interface TwilioCall {
  on: (event: 'accept' | 'disconnect' | 'error', cb: (arg?: DeviceError) => void) => void;
  disconnect: () => void;
}
interface TwilioDevice {
  destroy: () => void;
  connect: (opts: { params: Record<string, string> }) => Promise<TwilioCall>;
  on: (event: 'error', cb: (arg?: DeviceError) => void) => void;
}

export function ListenInProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ListenInState>('idle');
  const [patientName, setPatientName] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const deviceRef = useRef<TwilioDevice | null>(null);
  const callRef = useRef<TwilioCall | null>(null);

  const teardown = useCallback(() => {
    callRef.current = null;
    if (deviceRef.current) {
      try {
        deviceRef.current.destroy();
      } catch {
        // Already torn down, or never fully registered.
      }
    }
    deviceRef.current = null;
  }, []);

  const startListening = useCallback(
    async (args: { sessionId: string; patientName: string }) => {
      if (state !== 'idle' && state !== 'ended' && state !== 'error') return;
      setErrorMessage(null);
      setPatientName(args.patientName);
      setState('connecting');
      try {
        const result = await callEdgeFunction<{ ok: boolean; token?: string; error?: string; reason?: string }>(
          'twilio-voice-listen-in',
          { sessionId: args.sessionId },
        );
        if (!result.ok || !result.body.token) {
          throw new Error(result.body.error ?? 'Could not join this call');
        }
        const { Device } = await import('@twilio/voice-sdk');
        const device = new Device(result.body.token, { logLevel: 'error' }) as unknown as TwilioDevice;
        deviceRef.current = device;
        // Same two reasons as src/lib/activeCall.tsx: no
        // device.register() (the listen-in token grants no incoming
        // voice either, and a rejected registration never settles its
        // promise), and a Device-level 'error' listener, which this
        // provider was missing entirely. device.connect() rejects
        // with undefined on a signaling failure, so without this the
        // catch below could only ever say "Could not join this call",
        // and an error arriving outside connect() would be emitted on
        // an EventEmitter with no 'error' listener, which throws.
        let lastDeviceError: DeviceError | undefined;
        device.on('error', (err) => {
          lastDeviceError = err;
        });
        let call: TwilioCall;
        try {
          call = await device.connect({ params: { sessionId: args.sessionId, listen: '1' } });
        } catch (e) {
          throw e instanceof Error && !lastDeviceError
            ? e
            : new Error(lastDeviceError?.message ?? 'Could not join this call');
        }
        callRef.current = call;
        call.on('accept', () => setState('listening'));
        call.on('disconnect', () => {
          teardown();
          setState('ended');
          setTimeout(() => setState((current) => (current === 'ended' ? 'idle' : current)), 1500);
        });
        call.on('error', (err) => {
          teardown();
          setState('error');
          setErrorMessage(err?.message ?? 'The call ended unexpectedly');
        });
      } catch (e) {
        teardown();
        setState('error');
        const message = e instanceof Error ? e.message : 'Could not join this call';
        setErrorMessage(message);
        await logFailure({
          source: 'listenIn.startListening',
          severity: 'error',
          message,
          context: { sessionId: args.sessionId },
        });
      }
    },
    [state, teardown],
  );

  const stopListening = useCallback(() => {
    callRef.current?.disconnect();
  }, []);

  const value = useMemo<ListenInValue>(
    () => ({ state, patientName, errorMessage, startListening, stopListening }),
    [state, patientName, errorMessage, startListening, stopListening],
  );

  return <ListenInContext.Provider value={value}>{children}</ListenInContext.Provider>;
}

export function useListenIn(): ListenInValue {
  const ctx = useContext(ListenInContext);
  if (ctx === null) {
    throw new Error('useListenIn must be used inside <ListenInProvider>. Check the component tree in App.tsx.');
  }
  return ctx;
}
