import { useMemo, useState } from 'react';
import {
  useResolvedCatalogueRow,
  useWidgetUpgrades,
  type WidgetBookingType,
  type WidgetLocation,
} from './data.ts';
import {
  axesForService,
  type AxisKey,
  type CatalogueArchMatch,
} from '../lib/queries/bookingTypeAxes.ts';
import type { BookingServiceType } from '../lib/queries/bookingTypes.ts';
import { DEFAULT_COPY, type WidgetCopy } from './copy.ts';

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
 *  in.
 *
 *  `locationCount` decides whether the location step is in play —
 *  zero or one location → skip Step 1 entirely (the widget's only
 *  one location, or a deep-link pre-selected one). */
export function activeStepsFor(
  state: WidgetState,
  hasUpgrades: boolean,
  locationCount: number,
): StepKey[] {
  const out: StepKey[] = [];
  if (locationCount > 1) out.push('location');
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
 *  the navigation helpers. Call from the route component once,
 *  passing the live-loaded locations list (and an optional
 *  pre-selected location for ?location= deep-links).
 *
 *  The hook also runs the live upgrades query against the patient's
 *  resolved axes; the Upgrades step becomes part of the active
 *  list whenever the query returns rows. */
export function useBookingState(locations: WidgetLocation[], preSelected: WidgetLocation | null = null) {
  const [state, setState] = useState<WidgetState>(() => {
    const remembered = loadRememberedIdentity();
    // Pre-selection priority: an explicit URL deep-link wins,
    // then auto-select if there's only one location, else null
    // (the patient picks on Step 1).
    const startingLocation =
      preSelected ?? (locations.length === 1 ? locations[0]! : null);
    return {
      location: startingLocation,
      service: null,
      axes: {},
      upgradeIds: [],
      slotIso: null,
      details: { ...EMPTY_DETAILS, ...(remembered ?? {}) },
    };
  });
  const [stepKey, setStepKey] = useState<StepKey>(() => {
    const startingLocation =
      preSelected ?? (locations.length === 1 ? locations[0]! : null);
    return startingLocation ? 'service' : 'location';
  });

  // Upgrades + catalogue resolution both live inside the hook so
  // every consumer (Summary, Service step, Payment step) sees the
  // same shape via the api object — no parallel hooks scattered
  // across the tree.
  const resolverInput = {
    serviceType: state.service?.serviceType ?? null,
    productKey: state.axes.product_key ?? null,
    repairVariant: state.axes.repair_variant ?? null,
  };
  const upgradesResult = useWidgetUpgrades(resolverInput);
  const resolvedResult = useResolvedCatalogueRow(resolverInput);
  const upgrades = upgradesResult.data ?? [];
  const hasUpgrades = upgrades.length > 0;
  const activeSteps = useMemo(
    () => activeStepsFor(state, hasUpgrades, locations.length),
    [state, hasUpgrades, locations.length],
  );
  const priceBreakdown = useMemo(
    () =>
      computePriceBreakdown({
        service: state.service,
        resolvedRow: resolvedResult.data,
        arch: state.axes.arch,
        upgrades,
        selectedUpgradeIds: state.upgradeIds,
      }),
    [state.service, resolvedResult.data, state.axes.arch, upgrades, state.upgradeIds],
  );
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

  // Choosing a service resets the axis pins (the previous
  // service's choices don't transfer) and any upgrade picks (they
  // were keyed on the old catalogue row). Navigation has to be
  // computed from the NEW state — calling api.goNext() afterward
  // would read the stale activeSteps from the current render, so
  // the patient would skip the axes the new service introduced.
  // We do the setStepKey here ourselves based on the predicted
  // post-update active list.
  const setService = (service: WidgetBookingType | null) => {
    setState((prev) => ({
      ...prev,
      service,
      axes: {},
      upgradeIds: [],
    }));
    if (!service) {
      setStepKey('service');
      return;
    }
    const newAxes = axesForService(service.serviceType as BookingServiceType);
    // First axis the new service declares wins. No axes → land on
    // 'time' directly (free-text bookings like virtual impression).
    // We don't try to land on 'upgrades' here even when upgrades
    // exist for the row — the upgrades query fires async, and
    // jumping the patient there mid-flight would be weird. The
    // engine inserts the upgrades step on a later render once
    // its query resolves.
    setStepKey(newAxes.length > 0 ? `axis:${newAxes[0]!.key}` : 'time');
  };

  /** Update one axis pin and advance to the next active step. The
   *  navigation is computed here (not via api.goNext from the call
   *  site) because the post-update active step list is what we
   *  need to consult — stale activeSteps in the render closure
   *  would let the patient skip future axes that this pick just
   *  introduced or hide an axis this pick just removed. */
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

    // Predict the next step from the post-pin state without
    // waiting for React to commit. Walks the same axis registry
    // activeStepsFor uses, applying the same conditional skip
    // rules.
    if (!state.service) return;
    const allAxes = axesForService(state.service.serviceType as BookingServiceType);
    const currentAxisIdx = allAxes.findIndex((a) => a.key === axisKey);
    for (let i = currentAxisIdx + 1; i < allAxes.length; i++) {
      const next = allAxes[i]!;
      // Same skip rule as activeStepsFor: drop the arch axis when
      // the picked product's arch_match isn't 'single'.
      const skipArch =
        next.key === 'arch' && productArchMatch && productArchMatch !== 'single';
      if (skipArch) continue;
      setStepKey(`axis:${next.key}`);
      return;
    }
    // Last axis pinned — go to 'time'. Same rationale as
    // setService: don't try to predict 'upgrades' here.
    setStepKey('time');
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
    resolvedRow: resolvedResult.data,
    priceBreakdown,
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

export function stepTitle(key: StepKey, copy: WidgetCopy = DEFAULT_COPY): string {
  if (key.startsWith('axis:')) {
    const axisKey = key.slice(5) as AxisKey;
    return AXIS_QUESTION[axisKey];
  }
  switch (key) {
    case 'location':
      return copy.locationTitle;
    case 'service':
      return copy.serviceTitle;
    case 'upgrades':
      return copy.upgradesTitle;
    case 'time':
      return copy.timeTitle;
    case 'details':
      return copy.detailsTitle;
    case 'payment':
      return copy.paymentTitle;
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

// ─────────────────────────────────────────────────────────────────────────────
// Pricing — pure resolution from state + catalogue row + upgrades
// ─────────────────────────────────────────────────────────────────────────────
//
// Given the patient's resolved catalogue row, their arch pin, the
// list of upgrade rows that apply, and the upgrade ids they've
// ticked, returns the breakdown the summary needs. Pure — no
// network, no React. The widget calls this once per render with
// inputs from the live hooks.

import type { ResolvedCatalogueRow, WidgetUpgrade } from './data.ts';

export interface PriceBreakdown {
  /** The catalogue row's price for the resolved arch. 0 when no
   *  row has been resolved yet. */
  serviceLinePence: number;
  /** Selected upgrades' prices summed, with each upgrade's per-arch
   *  price chosen the same way the service line is. */
  upgradesLinePence: number;
  /** Service + upgrades. */
  subtotalPence: number;
  /** Captured at booking — read from the booking type's
   *  widget_deposit_pence. */
  depositPence: number;
  /** Subtotal − deposit. Never negative. Surfaced as "Pay at
   *  appointment" in the summary. */
  payAtAppointmentPence: number;
}

export function computePriceBreakdown(input: {
  service: WidgetBookingType | null;
  resolvedRow: ResolvedCatalogueRow | null;
  arch: 'upper' | 'lower' | 'both' | undefined;
  upgrades: WidgetUpgrade[];
  selectedUpgradeIds: string[];
}): PriceBreakdown {
  const archIsBoth = input.arch === 'both';
  const priceFor = (
    unit: number,
    bothArches: number | null,
    archMatch?: 'any' | 'single' | 'both',
  ) => {
    // 'single' rows have a separate both-arches price; 'both' /
    // 'any' rows always use unit_price.
    if (archMatch === 'single' && archIsBoth && bothArches !== null) {
      return bothArches;
    }
    return unit;
  };

  const serviceLinePence = input.resolvedRow
    ? priceFor(
        input.resolvedRow.unitPricePence,
        input.resolvedRow.bothArchesPricePence,
        input.resolvedRow.archMatch,
      )
    : 0;

  const upgradesLinePence = input.upgrades
    .filter((u) => input.selectedUpgradeIds.includes(u.id))
    .reduce(
      (sum, u) =>
        sum +
        priceFor(
          u.unitPricePence,
          u.bothArchesPricePence,
          // Upgrades inherit the resolved row's arch_match: a
          // single-arch product's upgrade also uses the both-arches
          // price when the patient picked 'both'.
          input.resolvedRow?.archMatch,
        ),
      0,
    );

  const subtotalPence = serviceLinePence + upgradesLinePence;
  const depositPence = input.service?.depositPence ?? 0;
  const payAtAppointmentPence = Math.max(0, subtotalPence - depositPence);

  return {
    serviceLinePence,
    upgradesLinePence,
    subtotalPence,
    depositPence,
    payAtAppointmentPence,
  };
}

