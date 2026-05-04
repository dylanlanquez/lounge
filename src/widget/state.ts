import { useMemo, useState } from 'react';
import {
  WIDGET_BOOKING_TYPES,
  WIDGET_LOCATIONS,
  type WidgetBookingType,
  type WidgetDentist,
  type WidgetLocation,
} from './data.ts';

// Booking-widget state + step engine.
//
// Six possible steps. The step engine recomputes the active list
// every render based on:
//
//   • the number of locations         (skip Step 1 if exactly one)
//   • the chosen booking type         (skip Step 3 if !allowStaffPick;
//                                      skip Step 6 if depositPence===0)
//
// `progress` returns "Step 2 of 4" not "Step 2 of 6" so the patient
// sees the truth about how many screens are left, not a static
// upper bound.

export type StepKey = 'location' | 'service' | 'dentist' | 'time' | 'details' | 'payment';

export interface WidgetState {
  location: WidgetLocation | null;
  service: WidgetBookingType | null;
  dentist: WidgetDentist | 'any' | null;
  slotIso: string | null;
  details: WidgetDetails;
}

export interface WidgetDetails {
  firstName: string;
  lastName: string;
  email: string;
  phoneCountry: string; // ISO-2 code, e.g. "GB"
  phoneNumber: string; // local, no country prefix
  notes: string;
  rememberMe: boolean;
  agreeTerms: boolean;
}

const EMPTY_DETAILS: WidgetDetails = {
  firstName: '',
  lastName: '',
  email: '',
  phoneCountry: 'GB',
  phoneNumber: '',
  notes: '',
  rememberMe: true,
  agreeTerms: false,
};

const REMEMBER_KEY = 'lng.widget.identity';

export function loadRememberedIdentity(): Partial<WidgetDetails> | null {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WidgetDetails>;
    return parsed;
  } catch {
    return null;
  }
}

export function persistRememberedIdentity(details: WidgetDetails): void {
  try {
    if (!details.rememberMe) {
      localStorage.removeItem(REMEMBER_KEY);
      return;
    }
    const payload: Partial<WidgetDetails> = {
      firstName: details.firstName,
      lastName: details.lastName,
      email: details.email,
      phoneCountry: details.phoneCountry,
      phoneNumber: details.phoneNumber,
      rememberMe: true,
    };
    localStorage.setItem(REMEMBER_KEY, JSON.stringify(payload));
  } catch {
    // localStorage can throw in private mode / Safari iframe — not
    // fatal. The user just won't get auto-fill next time.
  }
}

export function clearRememberedIdentity(): void {
  try {
    localStorage.removeItem(REMEMBER_KEY);
  } catch {
    // see above
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step engine
// ─────────────────────────────────────────────────────────────────────────────

/** Compute the active step list from the current state. The order is
 *  fixed; only the inclusion of each step varies. */
export function activeStepsFor(state: WidgetState): StepKey[] {
  const out: StepKey[] = [];
  if (WIDGET_LOCATIONS.length > 1) out.push('location');
  out.push('service');
  if (state.service?.allowStaffPick) out.push('dentist');
  out.push('time');
  out.push('details');
  if (state.service && state.service.depositPence > 0) out.push('payment');
  return out;
}

/** Hook that owns the booking state, the current-step pointer, and
 *  the navigation helpers. Call from the route component once. */
export function useBookingState() {
  const [state, setState] = useState<WidgetState>(() => {
    const remembered = loadRememberedIdentity();
    return {
      location: WIDGET_LOCATIONS.length === 1 ? WIDGET_LOCATIONS[0]! : null,
      service: null,
      dentist: null,
      slotIso: null,
      details: { ...EMPTY_DETAILS, ...(remembered ?? {}) },
    };
  });
  const [stepKey, setStepKey] = useState<StepKey>(() =>
    WIDGET_LOCATIONS.length === 1 ? 'service' : 'location',
  );

  const activeSteps = useMemo(() => activeStepsFor(state), [state]);
  const currentIdx = activeSteps.indexOf(stepKey);
  const totalSteps = activeSteps.length;

  const goNext = () => {
    const nextIdx = currentIdx + 1;
    if (nextIdx < activeSteps.length) {
      setStepKey(activeSteps[nextIdx]!);
    }
  };
  const goBack = () => {
    if (currentIdx > 0) {
      setStepKey(activeSteps[currentIdx - 1]!);
    }
  };
  const goTo = (key: StepKey) => {
    if (activeSteps.includes(key)) setStepKey(key);
  };

  // Choosing a service can shorten or lengthen the step list. If the
  // user goes back to Service and re-picks a service that no longer
  // includes the step they were on, snap them to the right place
  // (the step the engine now expects after Service).
  const setService = (service: WidgetBookingType | null) => {
    setState((prev) => {
      const next = { ...prev, service };
      // If the service no longer allows staff selection, drop any
      // dentist they had picked.
      if (!service?.allowStaffPick) {
        next.dentist = null;
      }
      return next;
    });
  };

  return {
    state,
    setState,
    setService,
    stepKey,
    activeSteps,
    currentIdx,
    totalSteps,
    goNext,
    goBack,
    goTo,
  };
}

export type BookingStateApi = ReturnType<typeof useBookingState>;

// ─────────────────────────────────────────────────────────────────────────────
// Display helpers used across multiple steps
// ─────────────────────────────────────────────────────────────────────────────

export function stepTitle(key: StepKey): string {
  switch (key) {
    case 'location':
      return 'Location';
    case 'service':
      return 'What you need';
    case 'dentist':
      return 'Pick a dentist';
    case 'time':
      return 'Date and time';
    case 'details':
      return 'Your details';
    case 'payment':
      return 'Payment';
  }
}

export function formatPrice(pence: number): string {
  if (pence === 0) return 'Free';
  if (pence % 100 === 0) return `£${pence / 100}`;
  return `£${(pence / 100).toFixed(2)}`;
}

export const ALL_BOOKING_TYPES = WIDGET_BOOKING_TYPES;
export const ALL_LOCATIONS = WIDGET_LOCATIONS;
