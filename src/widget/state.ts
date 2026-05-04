import { useMemo, useState } from 'react';
import {
  useWidgetUpgrades,
  WIDGET_LOCATIONS,
  type WidgetBookingType,
  type WidgetLocation,
} from './data.ts';
import {
  axesForService,
  type AxisKey,
  type CatalogueArchMatch,
} from '../lib/queries/bookingTypeAxes.ts';
import type { BookingServiceType } from '../lib/queries/bookingTypes.ts';

// Booking-widget state + step engine.
//
// Up to five top-level steps + one axis step per axis the chosen
// service declares. The engine recomputes the active list every
// render based on:
//
//   • the number of locations         (skip Step 1 if exactly one)
//   • the chosen booking type         (skip the axis steps the
//                                      service doesn't declare; skip
//                                      Payment if depositPence===0)
//
// Dentist selection is not exposed to the patient. The practice
// assigns staff internally based on availability — booking through
// the widget always lands as "any available".
//
// `progress` returns "Step 2 of 4" not "Step 2 of 6" so the patient
// sees the truth about how many screens are left, not a static
// upper bound.

// The fixed top-level steps. Axis steps live alongside as
// `axis:<key>` strings (e.g. `axis:product_key`, `axis:arch`) — the
// step engine inserts one per axis declared on the chosen service.
// The widget shell branches on the `axis:` prefix to render the
// AxisStep component.
export type StepKey =
  | 'location'
  | 'service'
  | 'upgrades'
  | 'time'
  | 'details'
  | 'payment'
  | `axis:${AxisKey}`;

export interface AxisPinState {
  repair_variant?: string;
  product_key?: string;
  arch?: 'upper' | 'lower' | 'both';
  /** When the patient picks a product, we capture its arch_match so
   *  the step engine can decide whether to ask the arch question.
   *  arch_match='single' → ask. 'both' / 'any' → skip and (for
   *  'both') auto-set arch='both'. */
  product_arch_match?: CatalogueArchMatch;
}

export interface WidgetState {
  location: WidgetLocation | null;
  service: WidgetBookingType | null;
  axes: AxisPinState;
  /** Upgrade ids the patient has ticked on the Upgrades step. The
   *  widget loads upgrades for the resolved catalogue row only when
   *  axes are complete enough to identify it; this set stays empty
   *  for services with no upgrades available. */
  upgradeIds: string[];
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

/** Compute the active step list from the current state.
 *
 *  Order is:
 *
 *    location
 *    service
 *    axis:<each axis the chosen service declares, in registry order>
 *    upgrades (when the resolved catalogue row has any visible upgrades —
 *              hasUpgrades flag flipped by the widget shell when its
 *              useWidgetUpgrades query returns rows)
 *    time
 *    details
 *    payment (only when service.depositPence > 0)
 *
 *  Axis ordering matches SERVICE_AXES — variant > product > arch.
 *  The arch axis is dropped when the picked product's arch_match
 *  isn't 'single' (a "both"-only product needs no arch question).
 *
 *  `hasUpgrades` is passed in (rather than read from state) because
 *  it depends on a network query the engine can't make synchronously.
 *  The widget shell holds the upgrade-list result and feeds the flag
 *  in. */
export function activeStepsFor(state: WidgetState, hasUpgrades: boolean): StepKey[] {
  const out: StepKey[] = [];
  if (WIDGET_LOCATIONS.length > 1) out.push('location');
  out.push('service');
  if (state.service) {
    const axes = axesForService(state.service.serviceType as BookingServiceType);
    for (const axis of axes) {
      // Conditional skip: if the patient picked a product whose
      // arch_match is anything other than 'single', the arch step
      // is meaningless and we drop it.
      if (
        axis.key === 'arch' &&
        state.axes.product_arch_match &&
        state.axes.product_arch_match !== 'single'
      ) {
        continue;
      }
      out.push(`axis:${axis.key}`);
    }
  }
  if (hasUpgrades) out.push('upgrades');
  out.push('time');
  out.push('details');
  if (state.service && state.service.depositPence > 0) out.push('payment');
  return out;
}

/** Hook that owns the booking state, the current-step pointer, and
 *  the navigation helpers. Call from the route component once. The
 *  hook also runs the live upgrades query against the patient's
 *  resolved axes; the Upgrades step becomes part of the active
 *  list whenever the query returns rows. */
export function useBookingState() {
  const [state, setState] = useState<WidgetState>(() => {
    const remembered = loadRememberedIdentity();
    return {
      location: WIDGET_LOCATIONS.length === 1 ? WIDGET_LOCATIONS[0]! : null,
      service: null,
      axes: {},
      upgradeIds: [],
      slotIso: null,
      details: { ...EMPTY_DETAILS, ...(remembered ?? {}) },
    };
  });
  const [stepKey, setStepKey] = useState<StepKey>(() =>
    WIDGET_LOCATIONS.length === 1 ? 'service' : 'location',
  );

  // Upgrades query lives inside the hook so the active step list
  // can flip on / off cleanly as the patient drills through axes.
  const upgradesResult = useWidgetUpgrades({
    serviceType: state.service?.serviceType ?? null,
    productKey: state.axes.product_key ?? null,
    repairVariant: state.axes.repair_variant ?? null,
  });
  const upgrades = upgradesResult.data ?? [];
  const hasUpgrades = upgrades.length > 0;
  const activeSteps = useMemo(() => activeStepsFor(state, hasUpgrades), [state, hasUpgrades]);
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
    setState((prev) => ({
      ...prev,
      service,
      // Switching service invalidates every axis pin from the
      // previous service AND any upgrades that were tied to the
      // old service's catalogue row. Reset both.
      axes: {},
      upgradeIds: [],
    }));
  };

  /** Update one axis pin and advance to the next active step. The
   *  step engine recomputes the list before navigating, so picking
   *  a "both"-only product correctly skips straight past the arch
   *  step. Also clears the upgrade picks — switching axes can land
   *  the patient on a different catalogue row whose upgrade set
   *  doesn't include what was previously chosen. */
  const setAxisPin = (
    axisKey: AxisKey,
    value: string,
    productArchMatch?: CatalogueArchMatch,
  ) => {
    setState((prev) => {
      const nextAxes: AxisPinState = { ...prev.axes };
      if (axisKey === 'repair_variant') nextAxes.repair_variant = value;
      else if (axisKey === 'product_key') {
        nextAxes.product_key = value;
        nextAxes.product_arch_match = productArchMatch;
        // If the product is "both"-only, auto-pin arch and skip
        // the question entirely. 'any' leaves arch blank.
        if (productArchMatch === 'both') nextAxes.arch = 'both';
        if (productArchMatch !== 'single') {
          // Clear any stale arch pin from a prior product choice.
          if (productArchMatch !== 'both') delete nextAxes.arch;
        }
      } else if (axisKey === 'arch') {
        nextAxes.arch = value as 'upper' | 'lower' | 'both';
      }
      return { ...prev, axes: nextAxes, upgradeIds: [] };
    });
  };

  /** Toggle a single upgrade in the patient's selection. Used by
   *  the Upgrades step's checkbox cards. */
  const toggleUpgrade = (id: string) => {
    setState((prev) => ({
      ...prev,
      upgradeIds: prev.upgradeIds.includes(id)
        ? prev.upgradeIds.filter((x) => x !== id)
        : [...prev.upgradeIds, id],
    }));
  };

  return {
    state,
    setState,
    setService,
    setAxisPin,
    toggleUpgrade,
    upgrades,
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
  if (key.startsWith('axis:')) {
    const axisKey = key.slice(5) as AxisKey;
    return AXIS_QUESTION[axisKey];
  }
  switch (key) {
    case 'location':
      return 'Location';
    case 'service':
      return 'What you need';
    case 'upgrades':
      return 'Optional extras';
    case 'time':
      return 'Date and time';
    case 'details':
      return 'Your details';
    case 'payment':
      return 'Payment';
    default:
      return '';
  }
}

/** Patient-friendly question per axis. The registry's labels
 *  ("Repair type", "Product", "Arch") are operator-facing and read
 *  too clinical for someone booking from their phone. The widget
 *  asks plain-English questions instead. */
export const AXIS_QUESTION: Record<AxisKey, string> = {
  repair_variant: 'What needs fixing?',
  product_key: 'What kind?',
  arch: 'Which teeth?',
};

export function formatPrice(pence: number): string {
  if (pence === 0) return 'Free';
  if (pence % 100 === 0) return `£${pence / 100}`;
  return `£${(pence / 100).toFixed(2)}`;
}

export const ALL_LOCATIONS = WIDGET_LOCATIONS;
