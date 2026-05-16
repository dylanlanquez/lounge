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
//
// Denture-repair has its own custom flow that doesn't run through the
// generic axis registry (kept untouched so the staff-app override
// pickers still validate correctly). It uses three dedicated keys:
//
//   repair:arch    — "Which denture needs fixing? Top / Bottom / Both"
//   repair:top     — multi-select repair tiles for the top arch
//   repair:bottom  — multi-select repair tiles for the bottom arch
//
// Top-only / Bottom-only arch answers run one repair step; Both runs
// repair:top then repair:bottom.
export type StepKey =
  | 'location'
  | 'service'
  | 'upgrades'
  | 'time'
  // Details captures only the patient's identity (name / email /
  // phone / notes). Review (next step) carries the booking summary
  // + payment-option selector. Splitting them keeps the payment
  // choice on its own screen — when both lived on Details the
  // selector sat below-the-fold on phones and the customer thought
  // the form was broken.
  | 'details'
  | 'review'
  | 'payment'
  | `axis:${AxisKey}`
  | 'repair:arch'
  | 'repair:top'
  | 'repair:bottom';

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

/** One repair line in the denture-repair cart. The repair step lets
 *  the patient pile up multiple repairs (reline upper + 2 broken
 *  teeth on lower + …) before continuing, and each line carries
 *  enough info to render the cart, compute the total, and submit
 *  the booking with full per-line breakdown. */
export interface RepairLine {
  /** Stable client-side id used for React keys + removal. */
  lineId: string;
  /** Catalogue row id (lwo_catalogue.id) — what the booking write
   *  will reference when we land the lng_booking_repair_items
   *  migration. Snapshotted so a catalogue edit mid-session doesn't
   *  swap the line under the patient. */
  catalogueId: string;
  /** Catalogue code, e.g. 'den_snapped'. Convenience for downstream
   *  filters / logging. */
  code: string;
  /** lwo_catalogue.repair_variant — the column value the slot RPC,
   *  the catalogue resolver and the upgrades query all filter on
   *  (e.g. "Snapped denture", "Broken tooth", "Relining"). Mirrored
   *  to axes.repair_variant whenever the cart's first line changes. */
  repairVariant: string;
  /** Display name snapshotted at add time. */
  name: string;
  /** unit_label from the catalogue ('per tooth' / 'per arch' / null).
   *  Drives the cart display ("× 3 teeth" suffix) and the sheet's
   *  quantity stepper visibility. */
  unitLabel: string | null;
  arch: 'upper' | 'lower' | 'both';
  quantity: number;
  /** Per-unit price snapshotted from the catalogue at add time. */
  unitPricePence: number;
  /** Both-arches override snapshotted from the catalogue. Used when
   *  arch === 'both' AND the catalogue has a both_arches_price (e.g.
   *  Reline £320 for both arches vs £160 each). */
  bothArchesPricePence: number | null;
  /** Resolved total for this line, in pence. Precomputed at add
   *  time so the cart shows a stable price; recomputed if quantity
   *  changes via the stepper. */
  lineTotalPence: number;
}

export interface WidgetState {
  location: WidgetLocation | null;
  service: WidgetBookingType | null;
  axes: AxisPinState;
  /** Denture-repair cart. Empty for every other service; one or more
   *  RepairLines for denture_repair. axes.repair_variant mirrors the
   *  first line's code so downstream queries (slot duration, upgrades)
   *  keep working in their current shape — the multi-line write to
   *  the booking happens at submit time via a separate field. */
  repairItems: RepairLine[];
  /** Upgrade ids the patient has ticked on the Upgrades step. The
   *  widget loads upgrades for the resolved catalogue row only when
   *  axes are complete enough to identify it; this set stays empty
   *  for services with no upgrades available. */
  upgradeIds: string[];
  slotIso: string | null;
  details: WidgetDetails;
  /** Picks one of three payment paths from the details footer CTAs;
   *  null while the patient hasn't decided yet. Free services stay
   *  null and submit via the single Book button.
   *
   *  • 'pay_full'        Charge the resolved full price now.
   *                      Includes the Payment step in activeSteps.
   *  • 'pay_deposit'     Charge service.depositPence now (legacy
   *                      Calendly-style "£25 today, balance on the
   *                      day"). Includes the Payment step.
   *  • 'pay_on_the_day'  Take nothing now; cart settles at the till.
   *                      Skips the Payment step.
   *
   *  Which CTAs surface is per-service: Footer reads
   *  service.depositPence and service.allowPayOnTheDay to decide. */
  paymentChoice: 'pay_full' | 'pay_deposit' | 'pay_on_the_day' | null;
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
    if (state.service.serviceType === 'denture_repair') {
      // Custom denture-repair flow: ask which denture needs fixing
      // first, then run one or two per-arch multi-select steps
      // depending on the answer. Kept off the generic axis registry
      // so the staff-app override system isn't disturbed.
      out.push('repair:arch');
      const arch = state.axes.arch;
      if (arch === 'upper' || arch === 'both') out.push('repair:top');
      if (arch === 'lower' || arch === 'both') out.push('repair:bottom');
    } else {
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
  }
  if (hasUpgrades) out.push('upgrades');
  out.push('time');
  // Identity capture (form). Strictly form fields — no summary, no
  // payment selector — so the customer is asked one focused thing
  // per screen.
  out.push('details');
  // Review screen carries the booking summary + payment-option
  // selector. Always present for non-zero-price bookings; for free
  // services the review still appears so the patient can confirm
  // what they're booking before committing. Free services route
  // straight from Review's "Book appointment" to submit (no Stripe).
  out.push('review');
  // Payment step is gated on the patient's choice from the review
  // selector. Either 'pay_full' or 'pay_deposit' enters the Stripe
  // step (the only difference being the amount the PI is created
  // for); 'pay_on_the_day' bypasses it. Free services stay
  // paymentless because the choice never surfaces.
  if (
    state.service &&
    (state.paymentChoice === 'pay_full' || state.paymentChoice === 'pay_deposit')
  ) {
    out.push('payment');
  }
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
      repairItems: [],
      upgradeIds: [],
      slotIso: null,
      // Prefill-supplied identity (Shopify customer email) wins over
      // localStorage — the host page knows who the logged-in customer
      // is, our localStorage is a guess based on a previous session
      // that may have ended on a different account.
      details: { ...EMPTY_DETAILS, ...(remembered ?? {}), ...prefill.details },
      paymentChoice: null,
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
        repairItems: state.repairItems,
        upgrades,
        selectedUpgradeIds: state.upgradeIds,
      }),
    [
      state.service,
      resolvedResult.data,
      state.axes.arch,
      state.repairItems,
      upgrades,
      state.upgradeIds,
    ],
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

  /** Pick the payment path. Sets state.paymentChoice and nothing
   *  else — navigation is decoupled now that the customer picks the
   *  option inside the details form and commits with the footer's
   *  single Next button. The Next handler reads state.paymentChoice
   *  to decide whether to advance to the Payment step (full /
   *  deposit) or submit directly (pay-on-the-day, free services).
   *
   *  • 'pay_full'        → footer Next reads "Continue to payment"
   *  • 'pay_deposit'     → footer Next reads "Continue to payment"
   *  • 'pay_on_the_day'  → footer Next reads "Book appointment" */
  const choosePayment = (choice: 'pay_full' | 'pay_deposit' | 'pay_on_the_day') => {
    setState((prev) => ({ ...prev, paymentChoice: choice }));
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
      repairItems: [],
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

  /** Set which denture(s) need fixing (the answer to repair:arch).
   *  Prunes repair lines that no longer belong to the chosen arch
   *  set — if the patient walks back and switches "Both" to "Top
   *  only", any bottom-arch lines they'd picked are dropped. The
   *  axes.repair_variant mirror is recomputed from the surviving
   *  first line so the downstream slot / upgrade queries don't
   *  point at a removed variant. */
  const setRepairArch = (arch: 'upper' | 'lower' | 'both') => {
    setState((prev) => {
      const keepUpper = arch === 'upper' || arch === 'both';
      const keepLower = arch === 'lower' || arch === 'both';
      const repairItems = prev.repairItems.filter(
        (r) =>
          (r.arch === 'upper' && keepUpper) ||
          (r.arch === 'lower' && keepLower),
      );
      const firstVariant = repairItems[0]?.repairVariant;
      return {
        ...prev,
        axes: { ...prev.axes, arch, repair_variant: firstVariant },
        repairItems,
        upgradeIds: [],
      };
    });
  };

  /** Toggle a repair on/off for a specific arch. Adds a new
   *  RepairLine when turning ON (with quantity = 1 and the line
   *  total resolved against the catalogue); removes the matching
   *  line when turning OFF. Mirrors the first line's repair_variant
   *  into axes so the legacy single-variant plumbing keeps working
   *  for slot resolution and upgrade gating. */
  const setRepairSelected = (params: {
    arch: 'upper' | 'lower';
    catalogueId: string;
    code: string;
    repairVariant: string;
    name: string;
    unitLabel: string | null;
    unitPricePence: number;
    bothArchesPricePence: number | null;
    selected: boolean;
  }) => {
    setState((prev) => {
      const existing = prev.repairItems.find(
        (r) => r.arch === params.arch && r.code === params.code,
      );
      if (params.selected && !existing) {
        const quantity = 1;
        const lineTotalPence = resolveLineTotal({
          unitLabel: params.unitLabel,
          unitPricePence: params.unitPricePence,
          bothArchesPricePence: params.bothArchesPricePence,
          arch: params.arch,
          quantity,
        });
        const next: RepairLine = {
          lineId: newLineId(),
          catalogueId: params.catalogueId,
          code: params.code,
          repairVariant: params.repairVariant,
          name: params.name,
          unitLabel: params.unitLabel,
          arch: params.arch,
          quantity,
          unitPricePence: params.unitPricePence,
          bothArchesPricePence: params.bothArchesPricePence,
          lineTotalPence,
        };
        const repairItems = [...prev.repairItems, next];
        return {
          ...prev,
          repairItems,
          axes: {
            ...prev.axes,
            repair_variant: repairItems[0]?.repairVariant,
          },
          upgradeIds: [],
        };
      }
      if (!params.selected && existing) {
        const repairItems = prev.repairItems.filter(
          (r) => r.lineId !== existing.lineId,
        );
        return {
          ...prev,
          repairItems,
          axes: {
            ...prev.axes,
            repair_variant: repairItems[0]?.repairVariant,
          },
          upgradeIds: [],
        };
      }
      return prev;
    });
  };

  /** Update the quantity on an existing repair line and recompute
   *  its line total. No-op when no matching line exists; the
   *  per-tooth stepper in RepairLinesStep guards this by only
   *  rendering when the tile is selected. */
  const setRepairQuantity = (
    arch: 'upper' | 'lower',
    code: string,
    quantity: number,
  ) => {
    setState((prev) => ({
      ...prev,
      repairItems: prev.repairItems.map((r) => {
        if (r.arch !== arch || r.code !== code) return r;
        const lineTotalPence = resolveLineTotal({
          unitLabel: r.unitLabel,
          unitPricePence: r.unitPricePence,
          bothArchesPricePence: r.bothArchesPricePence,
          arch: r.arch,
          quantity,
        });
        return { ...r, quantity, lineTotalPence };
      }),
    }));
  };

  return {
    state,
    setState,
    setService,
    setAxisPin,
    toggleUpgrade,
    setRepairArch,
    setRepairSelected,
    setRepairQuantity,
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
    choosePayment,
  };
}

/** Stable, unique line id for repair-line entries. Uses
 *  crypto.randomUUID() when available (every browser the widget
 *  targets, Safari 15.4+), falling back to a Date+Math composite
 *  for ancient WebViews so React keys never collide. */
function newLineId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `line_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Per-line price resolution. Per-tooth lines scale with quantity;
 *  per-arch and flat lines stay at unit price. The both-arches
 *  override only fires when arch='both' on a per-arch row, which the
 *  current arch-first flow never produces (each line is single-arch),
 *  but the branch stays so the helper is reusable if we ever surface
 *  a "both arches at once" affordance again. */
function resolveLineTotal(input: {
  unitLabel: string | null;
  unitPricePence: number;
  bothArchesPricePence: number | null;
  arch: 'upper' | 'lower' | 'both';
  quantity: number;
}): number {
  if (input.unitLabel === 'per tooth') {
    return input.quantity * input.unitPricePence;
  }
  if (input.unitLabel === 'per arch' && input.arch === 'both') {
    return input.bothArchesPricePence ?? input.unitPricePence * 2;
  }
  return input.unitPricePence;
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
    repairItems: [],
    upgradeIds: [],
    slotIso: null,
    details: { ...EMPTY_DETAILS, ...prefill.details },
    paymentChoice: null,
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
      if (axisKey === 'repair_variant' && prefill.axes.repair_variant) {
        return step;
      }
      return step;
    }
    if (step === 'repair:arch') {
      // A host-page trigger can pin the arch (top / bottom / both).
      // If it did, skip past this question and land on the per-arch
      // repair selection. If not, this is where the patient starts.
      if (prefill.axes.arch) continue;
      return step;
    }
    if (step === 'repair:top' || step === 'repair:bottom') {
      // No host-page mechanism for prefilling repair lines yet, so
      // these steps always ask. Future: a richer trigger could pin
      // specific repairs per arch and skip past these too.
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
    repairItems: [],
    upgradeIds: [],
    slotIso: null,
    details: { ...EMPTY_DETAILS, ...prefill.details },
    paymentChoice: null,
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
      return idx;
    }
    if (step === 'repair:arch') {
      // Locked when the trigger pinned arch — the back arrow can't
      // walk into a question the host page already answered.
      if (prefill.axes.arch) { idx++; continue; }
      return idx;
    }
    if (step === 'repair:top' || step === 'repair:bottom') {
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
    case 'review':
      return 'Booking summary';
    case 'payment':
      return copy.paymentTitle;
    case 'repair:arch':
      return 'Which denture needs fixing?';
    case 'repair:top':
      return 'What needs fixing on your top denture?';
    case 'repair:bottom':
      return 'What needs fixing on your bottom denture?';
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

// Title-case appliance nouns for headline contexts (success card,
// future confirmation email subject). Differs from productLabelFor
// above which serves running-prose ("Which retainer do you need?").
// Keep both — switching productLabelFor to title case would break
// the question copy.
const APPLIANCE_TITLE: Record<string, string> = {
  retainer: 'Retainer',
  night_guard: 'Night Guard',
  day_guard: 'Day Guard',
  click_in_veneers: 'Click-in Veneers',
  missing_tooth: 'Missing-tooth Appliance',
};

const ARCH_TITLE: Record<string, string> = {
  upper: 'Upper',
  lower: 'Lower',
  // Both arches reads naturally as a coordinated pair, not a count.
  // "Both Retainer" was confusing — a quantity-sounding word in
  // front of a singular noun. "Upper & Lower Retainers" reads as a
  // proper noun phrase and tells the patient exactly what they
  // booked. The pluralisation of the appliance happens inside
  // formatBookingSuccessTitle so the same map can drive both arches.
  both: 'Upper & Lower',
};

// Pluralise an appliance noun when arch=both. Catalogue labels are
// stored as singular ("Retainer", "Night Guard", "Missing-tooth
// Appliance") so we add 's' to the last word for the both-arches
// title. Labels that are already plural ("Click-in Veneers") pass
// through untouched. Mirrors the simple rule the staff app uses for
// staged-item labels; if a future appliance name needs irregular
// plural handling, special-case it here.
function pluraliseApplianceForBoth(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.endsWith('s') || trimmed.endsWith('S')) return trimmed;
  return `${trimmed}s`;
}

/**
 * Compose the headline service title shown on the success card.
 *
 * Examples:
 *   click_in_veneers + arch=upper                  → "Upper Click-in Veneers"
 *   click_in_veneers + arch=both                   → "Upper & Lower Click-in Veneers"
 *   same_day_appliance + product=retainer + lower  → "Lower Retainer"
 *   same_day_appliance + product=retainer + both   → "Upper & Lower Retainers"
 *   denture_repair + arch=upper                    → "Upper Denture repair"
 *   whitening_kit (no axes)                        → "Whitening kit"
 *
 * Two rules of thumb baked in:
 *   • arch='both' reads as "Upper & Lower" rather than "Both"
 *     so the headline is a noun phrase, not a count.
 *   • when arch='both' AND the appliance has a singular catalogue
 *     name (Retainer, Night Guard, Missing-tooth Appliance), the
 *     headline pluralises the appliance so subject/verb agreement
 *     reads correctly to the patient.
 *
 * Strips any HTML tags from the booking-type label before composing
 * — `lng_widget_booking_types.display_label` is rendered with
 * dangerouslySetInnerHTML elsewhere but the headline context wants
 * plain text only.
 */
export function formatBookingSuccessTitle(state: WidgetState): string {
  const svc = state.service;
  if (!svc) return '';
  const type = svc.serviceType;
  const archKey = state.axes.arch;
  const isBoth = archKey === 'both';
  const arch = archKey ? ARCH_TITLE[archKey] : null;

  if (type === 'click_in_veneers') {
    // Click-in Veneers is already plural in its singular form, so
    // pluralisation is a no-op. Arch first, name second.
    const parts: string[] = [];
    if (arch) parts.push(arch);
    parts.push('Click-in Veneers');
    return parts.join(' ');
  }

  if (type === 'same_day_appliance') {
    const baseAppliance = state.axes.product_key
      ? (APPLIANCE_TITLE[state.axes.product_key] ?? 'Appliance')
      : 'Appliance';
    const appliance = isBoth
      ? pluraliseApplianceForBoth(baseAppliance)
      : baseAppliance;
    const parts: string[] = [];
    if (arch) parts.push(arch);
    parts.push(appliance);
    return parts.join(' ');
  }

  // Everything else: strip HTML, prefix arch when set.
  const cleanLabel = svc.label.replace(/<[^>]*>/g, '').trim();
  if (arch) return `${arch} ${cleanLabel}`;
  return cleanLabel;
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

/** Strip the redundant "denture" token from a repair catalogue
 *  name when it's about to render under a "Your upper denture" /
 *  "Your lower denture" subheader. "Snapped Denture" → "Snapped",
 *  "Add tooth to denture" → "Add tooth", "Reline" → "Reline". Keeps
 *  the first letter capitalised so the line still reads as a
 *  proper noun phrase. Case-insensitive match; preserves the
 *  original casing of the surviving stem.
 *
 *  Mirrored byte-for-byte in supabase/functions/send-appointment-
 *  confirmation/index.ts (Deno can't import from src/). Update both
 *  if you change the rules. */
export function customerRepairLabel(name: string): string {
  let out = name.trim();
  // Drop a trailing " to denture" or " denture" so the catalogue
  // name reads naturally beneath the "Your upper denture" heading.
  out = out.replace(/\s+(?:to\s+)?denture\b\.?$/i, '').trim();
  // Some catalogue rows historically have "denture" mid-phrase
  // ("Cracked denture base") — strip the bare token if it's
  // grammatically optional (followed by a space + lowercase word).
  out = out.replace(/\bdenture\s+/i, '').trim();
  // Re-capitalise the first letter if the strip left it lower-case.
  if (out.length > 0) out = out.charAt(0).toUpperCase() + out.slice(1);
  // Defensive: if the strip left an empty string (e.g. the catalogue
  // row was literally "Denture"), fall back to the original.
  return out.length > 0 ? out : name;
}

const GBP_FORMATTER_SHORT = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** "£399" for whole pounds, "£399.50" otherwise. Thousand separators
 *  still apply. Used on the customer-facing pay buttons where
 *  trailing ".00" felt like visual noise on a primary CTA. */
export function formatPriceShort(pence: number): string {
  if (pence === 0) return 'Free';
  return GBP_FORMATTER_SHORT.format(pence / 100);
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
  /** Denture-repair cart. When non-empty AND the service is
   *  denture_repair, the service line is the sum of line totals
   *  instead of the single-row resolver — the resolver can only
   *  identify ONE repair at a time, which is meaningless for a
   *  multi-line cart. */
  repairItems: RepairLine[];
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

  // Denture-repair branch: the cart is the source of truth. Each
  // line's lineTotalPence was resolved against the catalogue at
  // add-time (with both_arches_price honoured for 'both' arch on
  // single-arch repairs), so we just sum.
  const isRepair = input.service?.serviceType === 'denture_repair';
  const serviceLinePence = isRepair
    ? input.repairItems.reduce((sum, r) => sum + r.lineTotalPence, 0)
    : input.resolvedRow
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
      // Denture-repair runs its own flow (repair:arch / repair:top /
      // repair:bottom) so this branch is only reached if a future
      // service ever declares the repair_variant axis.
      return !!api.state.axes.repair_variant;
    case 'repair:arch':
      return !!api.state.axes.arch;
    case 'repair:top':
      return api.state.repairItems.some((r) => r.arch === 'upper');
    case 'repair:bottom':
      return api.state.repairItems.some((r) => r.arch === 'lower');
    case 'upgrades':
      // Upgrades are optional — Next is always live so the customer
      // can pass through without picking anything.
      return true;
    case 'time':
      return !!api.state.slotIso;
    case 'details': {
      // Identity-only step. The four required fields must validate;
      // the booking summary + payment selector live on the next step
      // (Review) so the customer always sees the choice before
      // committing.
      const d = api.state.details;
      return (
        !validateFirstName(d.firstName) &&
        !validateLastName(d.lastName) &&
        !validateEmail(d.email) &&
        !validatePhone(d.phoneNumber, d.phoneCountry)
      );
    }
    case 'review': {
      // Review step. Free service → always commit-ready. Paid service
      // → requires a payment choice (PaymentChoiceCard auto-selects a
      // default on mount, so this guard usually trips only during the
      // brief render window before the effect lands).
      const total = api.priceBreakdown.subtotalPence;
      if (total === 0) return true;
      return api.state.paymentChoice !== null;
    }
    case 'payment':
      // Stripe owns submission via its own button inside the iframe.
      // The footer's Next button is hidden on this step.
      return false;
    default:
      return false;
  }
}

