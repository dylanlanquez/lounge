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
} from '../../lib/queries/bookingTypeAxes.ts';
import type { BookingServiceType } from '../../lib/queries/bookingTypes.ts';
import { DEFAULT_COPY, type WidgetCopy } from './copy.ts';
import {
  validateEmail,
  validateFirstName,
  validateLastName,
  validatePhone,
} from './validation.ts';

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
  // Combined details + summary step. The form fields sit on top,
  // the booking-summary cards below, and the footer hosts the
  // terms checkbox + Today / On-the-day price preview. Avoids
  // the extra click the previous standalone summary step
  // demanded — customer fills + reviews on one screen.
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
  // Details now also hosts the booking summary + price card + terms
  // checkbox (via the footer) — one screen the customer reviews
  // and commits on. Previous standalone 'summary' step removed.
  out.push('details');
  if (state.service && state.service.depositPence > 0) out.push('payment');
  return out;
}

/** Resolved prefill the engine seeds initial state from. Builders:
 *  - WidgetReady, which resolves the host page's data-* attributes
 *    against the locations + booking-types live reads before passing
 *    the result here.
 *
 *  Every field is optional — an empty prefill is the legacy
 *  no-deep-link case where the patient picks every axis manually. */
export interface ResolvedPrefill {
  location: WidgetLocation | null;
  service: WidgetBookingType | null;
  axes: AxisPinState;
  details: Partial<WidgetDetails>;
}

const EMPTY_PREFILL: ResolvedPrefill = {
  location: null,
  service: null,
  axes: {},
  details: {},
};

/** Hook that owns the booking state, the current-step pointer, and
 *  the navigation helpers. Call from the route component once,
 *  passing the live-loaded locations list and a resolved prefill
 *  (location + service + axes + details prefilled from the host
 *  page's data-* attributes or the legacy ?location= search param).
 *
 *  The hook also runs the live upgrades query against the patient's
 *  resolved axes; the Upgrades step becomes part of the active
 *  list whenever the query returns rows. */
export function useBookingState(
  locations: WidgetLocation[],
  prefill: ResolvedPrefill = EMPTY_PREFILL,
) {
  const [state, setState] = useState<WidgetState>(() => {
    const remembered = loadRememberedIdentity();
    // Pre-selection priority: an explicit prefill from the host page
    // wins, then auto-select if there's only one location, else null
    // (the patient picks on Step 1).
    const startingLocation =
      prefill.location ?? (locations.length === 1 ? locations[0]! : null);
    return {
      location: startingLocation,
      service: prefill.service,
      axes: { ...prefill.axes },
      upgradeIds: [],
      slotIso: null,
      // Prefill-supplied identity (Shopify customer email) wins over
      // localStorage — the host page knows who the logged-in customer
      // is, our localStorage is a guess based on a previous session
      // that may have ended on a different account.
      details: { ...EMPTY_DETAILS, ...(remembered ?? {}), ...prefill.details },
    };
  });
  const [stepKey, setStepKey] = useState<StepKey>(() =>
    initialStepFor(prefill, locations.length),
  );
  // Lock boundary: the index of the first step the patient still has
  // to answer. Anything BEFORE it is a deep-link pin from the host
  // page (Shopify trigger data-attrs) and the back arrow must not let
  // the patient overwrite it. Computed once at mount because the
  // pinned prefix is fixed for the life of the flow — pins don't
  // appear or disappear mid-session.
  const [lockedStepIdx] = useState<number>(() =>
    initialLockedIdxFor(prefill, locations.length),
  );

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

  // The customer-facing progress only counts the steps they're
  // actually asked to answer. When a Shopify trigger pins service +
  // product, the locked prefix is invisible to the customer — the
  // counter must read "Step 1 of N" where N is just the remaining
  // steps. Anything else leaks the existence of options they were
  // never offered (e.g. someone clicking "Essix Retainers" should
  // never see the widget hint at a Service step before theirs).
  const visibleSteps = activeSteps.slice(lockedStepIdx);
  const visibleCurrentIdx = Math.max(0, currentIdx - lockedStepIdx);
  const visibleTotalSteps = visibleSteps.length;

  const goNext = () => {
    const nextIdx = currentIdx + 1;
    if (nextIdx < activeSteps.length) {
      setStepKey(activeSteps[nextIdx]!);
    }
  };
  const canGoBack = currentIdx > lockedStepIdx;
  const goBack = () => {
    if (canGoBack) {
      setStepKey(activeSteps[currentIdx - 1]!);
    }
  };
  const goTo = (key: StepKey) => {
    if (activeSteps.includes(key)) setStepKey(key);
  };

  // Choosing a service resets axis pins and upgrades (previous
  // service's choices don't transfer). Navigation does NOT advance
  // automatically — the footer Next button is the sole way to move
  // between steps, matching the retainer-cart UX. If the customer
  // back-navigates and re-picks a service, they explicitly tap Next
  // to walk into the new axes.
  const setService = (service: WidgetBookingType | null) => {
    setState((prev) => ({
      ...prev,
      service,
      axes: {},
      upgradeIds: [],
    }));
  };

  /** Update one axis pin. Does NOT advance to the next step —
   *  navigation is footer-driven now (single Next button at the
   *  bottom of the modal). Customer picks an option, the option's
   *  card shows the selected state, and they tap Next to commit.
   *  Matches the retainer-cart quiz UX. */
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
    resolvedRow: resolvedResult.data,
    priceBreakdown,
    stepKey,
    activeSteps,
    currentIdx,
    totalSteps,
    visibleCurrentIdx,
    visibleTotalSteps,
    canGoBack,
    goNext,
    goBack,
    goTo,
  };
}

export type BookingStateApi = ReturnType<typeof useBookingState>;

/** Walks the would-be active steps for the prefilled state and
 *  returns the first one that still needs patient input. Used to
 *  decide where the engine lands on first render — a deep-link with
 *  service + product + arch all pinned should drop the patient on
 *  the time picker, not Step 1.
 *
 *  Note: we pass `hasUpgrades: false` here because upgrades load
 *  async and the engine doesn't know on first render whether they
 *  apply. If they do, the upgrades step inserts on a later render
 *  and the patient sees it before time. That's the correct UX —
 *  upgrades depend on the resolved catalogue row which itself
 *  depends on the pinned axes. */
function initialStepFor(prefill: ResolvedPrefill, locationCount: number): StepKey {
  const seed: WidgetState = {
    location:
      prefill.location ?? (locationCount === 1 ? null : null), // location pinning irrelevant for activeStepsFor's location branch — that one only checks locationCount
    service: prefill.service,
    axes: { ...prefill.axes },
    upgradeIds: [],
    slotIso: null,
    details: { ...EMPTY_DETAILS, ...prefill.details },
  };
  const steps = activeStepsFor(seed, false, locationCount);
  for (const step of steps) {
    if (step === 'location') {
      if (prefill.location) continue;
      return step;
    }
    if (step === 'service') {
      if (prefill.service) continue;
      return step;
    }
    if (step.startsWith('axis:')) {
      const axisKey = step.slice(5) as AxisKey;
      if (axisKey === 'product_key' && prefill.axes.product_key) continue;
      if (axisKey === 'arch' && prefill.axes.arch) continue;
      if (axisKey === 'repair_variant' && prefill.axes.repair_variant) continue;
      return step;
    }
    return step;
  }
  // Defensive: shouldn't reach here unless every step is somehow
  // pinned including time, which the trigger can't provide.
  return 'time';
}

/** Twin of initialStepFor — returns the INDEX of the first step the
 *  patient still needs to answer. Used as the back-navigation lock so
 *  the patient can't rewind into Service / Product / Arch when those
 *  came from the Shopify trigger. Same iteration logic as
 *  initialStepFor; counted separately so each function stays readable. */
function initialLockedIdxFor(
  prefill: ResolvedPrefill,
  locationCount: number,
): number {
  const seed: WidgetState = {
    location: prefill.location ?? null,
    service: prefill.service,
    axes: { ...prefill.axes },
    upgradeIds: [],
    slotIso: null,
    details: { ...EMPTY_DETAILS, ...prefill.details },
  };
  const steps = activeStepsFor(seed, false, locationCount);
  let idx = 0;
  for (const step of steps) {
    if (step === 'location') {
      if (prefill.location) { idx++; continue; }
      return idx;
    }
    if (step === 'service') {
      if (prefill.service) { idx++; continue; }
      return idx;
    }
    if (step.startsWith('axis:')) {
      const axisKey = step.slice(5) as AxisKey;
      if (axisKey === 'product_key' && prefill.axes.product_key) { idx++; continue; }
      if (axisKey === 'arch' && prefill.axes.arch) { idx++; continue; }
      if (axisKey === 'repair_variant' && prefill.axes.repair_variant) { idx++; continue; }
      return idx;
    }
    return idx;
  }
  return idx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Display helpers used across multiple steps
// ─────────────────────────────────────────────────────────────────────────────

export function stepTitle(
  key: StepKey,
  copy: WidgetCopy = DEFAULT_COPY,
  state?: WidgetState,
): string {
  if (key.startsWith('axis:')) {
    const axisKey = key.slice(5) as AxisKey;
    if (axisKey === 'arch' && state?.service) {
      return archStepTitleFor(state.service.serviceType, state.axes.product_key);
    }
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
  product_key: 'Which retainer do you need?',
  arch: 'Which teeth?',
};

// Context-aware title for the arch step. Click-in veneers asks
// "Which teeth would you like to cover?" because the metaphor is
// cosmetic coverage; everything else asks "Which <appliance>
// do you need?" with the appliance interpolated from the product
// pin where present.
function archStepTitleFor(
  serviceType: string,
  productKey: string | undefined,
): string {
  if (serviceType === 'click_in_veneers') {
    return 'Which teeth would you like to cover?';
  }
  const appliance = productLabelFor(productKey);
  return appliance ? `Which ${appliance} do you need?` : 'Which teeth?';
}

function productLabelFor(productKey: string | undefined): string | null {
  switch (productKey) {
    case 'retainer':
      return 'retainer';
    case 'night_guard':
      return 'night guard';
    case 'day_guard':
      return 'day guard';
    case 'click_in_veneers':
      return 'click-in veneers';
    case 'missing_tooth':
      return 'missing-tooth appliance';
    default:
      return null;
  }
}

const GBP_FORMATTER = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPrice(pence: number): string {
  if (pence === 0) return 'Free';
  // Always show 2 decimals + thousand separators so big-ticket
  // services read as e.g. £1,248.00 instead of £1248. Per Dylan's
  // rule: every non-phone financial number gets Intl.NumberFormat.
  return GBP_FORMATTER.format(pence / 100);
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

// ─────────────────────────────────────────────────────────────────────────────
// Footer Next-button gate
// ─────────────────────────────────────────────────────────────────────────────
//
// One predicate per step that the sticky footer reads to decide if the
// Next button is enabled. Centralised here so the gating rules live
// next to the step machinery rather than scattered across the Widget
// shell. Mirrors the retainer-cart pattern where each step has a
// validator that lights up the navy pill.

export function isNextEnabled(api: BookingStateApi): boolean {
  switch (api.stepKey) {
    case 'location':
      return !!api.state.location;
    case 'service':
      return !!api.state.service;
    case 'axis:product_key':
      return !!api.state.axes.product_key;
    case 'axis:arch':
      return !!api.state.axes.arch;
    case 'axis:repair_variant':
      return !!api.state.axes.repair_variant;
    case 'upgrades':
      // Upgrades are optional — Next is always live so the customer
      // can pass through without picking anything.
      return true;
    case 'time':
      return !!api.state.slotIso;
    case 'details': {
      // Combined details + summary step. The customer must have
      // filled all identity fields AND ticked the terms checkbox
      // (rendered in the footer on this step) before they can
      // advance to payment / commit a free booking.
      const d = api.state.details;
      return (
        !validateFirstName(d.firstName) &&
        !validateLastName(d.lastName) &&
        !validateEmail(d.email) &&
        !validatePhone(d.phoneNumber, d.phoneCountry) &&
        d.agreeTerms
      );
    }
    case 'payment':
      // Stripe owns submission via its own button inside the iframe.
      // The footer's Next button is hidden on this step.
      return false;
    default:
      return false;
  }
}

