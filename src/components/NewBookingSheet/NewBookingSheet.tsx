import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock,
  CalendarPlus,
  Clock,
  User,
} from 'lucide-react';
import {
  BottomSheet,
  Button,
  Checkbox,
  ConflictBlock,
  DatePicker,
  DropdownSelect,
  FieldTrigger,
  InlineHint,
  Input,
  ReturnSegmentHints,
  Section,
  StatusBanner,
  TimePicker,
  Toast,
} from '../index.ts';
import { PatientSearch } from '../PatientSearch/PatientSearch.tsx';
import { theme } from '../../theme/index.ts';
import {
  type BookingServiceType,
  type ResolvedBookingTypeConfig,
  BOOKING_SERVICE_TYPES,
  resolveBookingTypeConfig,
} from '../../lib/queries/bookingTypes.ts';
import {
  type AxisDef,
  type AxisKey,
  type AxisValueOption,
  type ArchValue,
  axesForService,
  axisValueLabel,
  loadAxisValues,
} from '../../lib/queries/bookingTypeAxes.ts';
import {
  type RescheduleConflict,
  RescheduleConflictError,
  checkBookingConflict,
} from '../../lib/queries/rescheduleAppointment.ts';
import { loadAvailableSlots } from '../../lib/queries/bookingAvailableSlots.ts';
import {
  useAvailableDates,
  useFirstAvailableSlot,
} from '../../lib/queries/bookingAvailability.ts';
import { dayHoursForDate, useClinicSettings } from '../../lib/queries/clinicSettings.ts';
import { todayIso } from '../../lib/calendarMonth.ts';
import { createAppointment } from '../../lib/queries/createAppointment.ts';
import { useMeetHosts } from '../../lib/queries/meetHosts.ts';
import { useCatalogueActive } from '../../lib/queries/catalogue.ts';
import { lookupShopifyOrder, type ShopifyOrderLookup } from '../../lib/queries/shopifyOrderLookup.ts';
import { formatPence } from '../../lib/queries/carts.ts';
import { type PatientRow, patientFullName } from '../../lib/queries/patients.ts';
import { supabase } from '../../lib/supabase.ts';

// NewBookingSheet — bottom-sheet UI for creating a brand-new
// native (non-Calendly) appointment. Opened from the Schedule when
// the operator taps an empty slot on the calendar grid.
//
// Flow:
//   1. Pre-fill date + time from the tapped slot.
//   2. Patient picker (search existing patients, scoped to current
//      location via RLS).
//   3. Service picker — drives duration, working hours, and
//      conflict-check pool list via lng_booking_type_resolve.
//   4. Optional staff member.
//   5. Live conflict check against lng_booking_check_conflict.
//      Inline banner: checking / free / outside-hours / pool-conflict.
//   6. Optional notes.
//   7. "Send confirmation email" toggle — defaults on if the
//      patient has an email on file; off otherwise (with a hint).
//   8. Save → createAppointment → onCreated callback closes the sheet.
//
// Save is disabled until: patient + service picked, slot in working
// hours, conflict-check returns no conflicts, no in-flight save.

export interface NewBookingSheetProps {
  open: boolean;
  onClose: () => void;
  // Pre-filled date + time from the tapped calendar slot.
  initialIso: string;
  // Current location — RLS scopes patient search to it; the row
  // gets inserted with this location_id.
  locationId: string;
  // Fired with the new appointment id after a successful insert.
  // Caller is responsible for closing the sheet (via onClose) and
  // refreshing the schedule.
  onCreated: (
    newAppointmentId: string,
    info: { emailSent: boolean; emailReason: string | null; meetCreateError?: string | null },
  ) => void;
}

export function NewBookingSheet({
  open,
  onClose,
  initialIso,
  locationId,
  onCreated,
}: NewBookingSheetProps) {
  // ── Form state ──────────────────────────────────────────────────
  const initial = useMemo(() => splitIso(initialIso), [initialIso]);
  const [date, setDate] = useState<string>(initial.date);
  const [time, setTime] = useState<string>(initial.time);
  const [patient, setPatient] = useState<PatientRow | null>(null);
  // Create-new-patient sub-flow inside the patient section. When
  // patientCreate is non-null the search box is replaced with a
  // form pre-seeded from the search term (matches NewWalkIn's
  // 'find' → 'create' step pattern, but kept inside this sheet so
  // staff don't lose their booking context). Cancelled or saved →
  // back to search / picked.
  const [patientCreate, setPatientCreate] = useState<NewPatientDraft | null>(null);
  const [creatingPatient, setCreatingPatient] = useState(false);
  const [createPatientError, setCreatePatientError] = useState<string | null>(null);
  const [serviceType, setServiceType] = useState<BookingServiceType | ''>('');
  // Axis pins for the picked service (e.g. denture variant, product key,
  // arch). Order is fixed per service via SERVICE_AXES; values are kept
  // in a single object so resetting on service change is one assignment.
  const [axisValues, setAxisValues] = useState<{
    repair_variant: string | null;
    product_key: string | null;
    arch: ArchValue | null;
  }>({ repair_variant: null, product_key: null, arch: null });
  // Loaded option lists per axis. Keyed by AxisKey so multi-axis
  // services (same_day_appliance, virtual_impression_appointment) can
  // share the cache without re-querying when a sibling axis changes.
  const [axisOptions, setAxisOptions] = useState<Partial<Record<AxisKey, AxisValueOption[]>>>({});
  const [axisOptionsLoading, setAxisOptionsLoading] = useState<boolean>(false);
  const [notes, setNotes] = useState<string>('');
  // Per-host Google Meet integration. Only relevant when the picked
  // service is virtual_impression_appointment — for everything else
  // we leave this null and skip the dropdown entirely. createAppointment
  // routes virtual bookings through the new per-host edge function
  // when meetHostId is set; otherwise it falls back to the legacy
  // service-account flow (used by Calendly imports).
  const [meetHostId, setMeetHostId] = useState<string | null>(null);
  const { hosts: meetHosts, loading: meetHostsLoading } = useMeetHosts({ activeOnly: true });

  // Shopify-paid services (admin flag on lwo_catalogue.sold_on_shopify
  // makes the opt-in available). Most customers walking into a sold-
  // on-shopify service haven't bought online — only ~10% have — so
  // the input is hidden behind an explicit checkbox. Receptionist
  // ticks "Coming in from an online order", then types the number and
  // hits Look up. Without the tick the booking saves with no order
  // attached, like any normal in-person booking. Whole bundle resets
  // on close so a stray order can't leak into the next booking.
  const [shopifyOrderApplies, setShopifyOrderApplies] = useState<boolean>(false);
  const [shopifyOrderInput, setShopifyOrderInput] = useState<string>('');
  const [shopifyOrder, setShopifyOrder] = useState<ShopifyOrderLookup | null>(null);
  const [shopifyLookupBusy, setShopifyLookupBusy] = useState<boolean>(false);
  const [shopifyLookupError, setShopifyLookupError] = useState<string | null>(null);
  const { rows: catalogueRows } = useCatalogueActive();
  // Default sendEmail to true, then re-derive once a patient is
  // picked (it stays on if they have an email, off if not). The
  // operator can flip it manually either way.
  const [sendEmail, setSendEmail] = useState<boolean>(true);
  const [sendEmailUserOverride, setSendEmailUserOverride] = useState<boolean>(false);

  // ── Booking-type config + conflict state ───────────────────────
  const [config, setConfig] = useState<ResolvedBookingTypeConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<RescheduleConflict[]>([]);
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string; description?: string } | null>(null);

  // In-app date / time pickers replace the native <input type="date">
  // and <input type="time"> so the experience matches the rest of the
  // form and respects the no-system-UI-dropdowns rule.
  const dateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const timeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);

  // True while we're waiting on lng_widget_first_available to tell
  // us where the first bookable slot lives. The single round-trip
  // pre-pins date+time to a settled value, so the operator never
  // sees the form in a half-resolved state and we don't need any
  // client-side day-by-day probing. Reset to false the moment the
  // RPC returns (with a hit OR with nothing in the 60-day window).
  const [searchingFirstSlot, setSearchingFirstSlot] = useState(false);

  // Reset form when the sheet opens at a fresh slot. We don't reset
  // on close so the operator's last patient pick survives a
  // backdrop-mistap. Date + time are deliberately blanked here; the
  // useFirstAvailableSlot hook below populates them from the
  // server's "first bookable slot" answer once the service is
  // picked. Clamping or seeding from initialIso would leak a stale
  // date into the form for a flash before the live answer arrived.
  useEffect(() => {
    if (!open) return;
    setDate('');
    setTime('');
    setSearchingFirstSlot(true);
    setPatient(null);
    setPatientCreate(null);
    setCreatePatientError(null);
    setServiceType('');
    setAxisValues({ repair_variant: null, product_key: null, arch: null });
    setAxisOptions({});
    setAxisOptionsLoading(false);
    setNotes('');
    setMeetHostId(null);
    setShopifyOrderApplies(false);
    setShopifyOrderInput('');
    setShopifyOrder(null);
    setShopifyLookupBusy(false);
    setShopifyLookupError(null);
    setSendEmail(true);
    setSendEmailUserOverride(false);
    setConfig(null);
    setConfigError(null);
    setConflicts([]);
    setConflictError(null);
  }, [open, initialIso]);

  // Re-derive sendEmail default from patient's email on file, but
  // only if the operator hasn't flipped it manually yet.
  useEffect(() => {
    if (sendEmailUserOverride) return;
    setSendEmail(!!patient?.email);
  }, [patient, sendEmailUserOverride]);

  // ── Reset axis pins whenever the service changes ───────────────
  // The pins for "same_day_appliance" don't carry over to
  // "denture_repair", so any switch wipes the previously chosen
  // axes. Options for the new service load in the next effect.
  useEffect(() => {
    setAxisValues({ repair_variant: null, product_key: null, arch: null });
    setAxisOptions({});
  }, [serviceType]);

  // Does the picked service have sold_on_shopify=true on its catalogue
  // row? Matched on service_type + (product_key / repair_variant when
  // pinned) so admin can configure the flag at the appropriate level.
  // True even if any matching row has the flag set — admin should
  // keep variants consistent, but this is lenient so a half-configured
  // catalogue still surfaces the order input.
  const isShopifyService = useMemo(() => {
    if (!serviceType) return false;
    return catalogueRows.some((r) => {
      if (!r.sold_on_shopify) return false;
      if (r.service_type !== serviceType) return false;
      if (axisValues.product_key && r.product_key && r.product_key !== axisValues.product_key) return false;
      if (axisValues.repair_variant && r.repair_variant && r.repair_variant !== axisValues.repair_variant) return false;
      return true;
    });
  }, [serviceType, axisValues.product_key, axisValues.repair_variant, catalogueRows]);

  // Wipe the staged order details when the service flips away from
  // sold_on_shopify — never let a stale order leak onto a non-Shopify
  // booking. Same wipe fires when the receptionist unticks the
  // checkbox after pasting in an order: the staged state goes too,
  // so a later re-tick starts from a clean slate.
  useEffect(() => {
    if (!isShopifyService || !shopifyOrderApplies) {
      setShopifyOrderInput('');
      setShopifyOrder(null);
      setShopifyLookupError(null);
    }
  }, [isShopifyService, shopifyOrderApplies]);

  // Reset the opt-in flag whenever the service flips away. Without
  // this a receptionist who toggled it on for an Impression booking
  // and then changed the service would carry the tick across.
  useEffect(() => {
    if (!isShopifyService) setShopifyOrderApplies(false);
  }, [isShopifyService]);

  // Re-resolve the order whenever the input changes after a previous
  // resolve — the receptionist might tweak the number; we want stale
  // matches gone the moment the value drifts from what was looked up.
  useEffect(() => {
    if (shopifyOrder && shopifyOrderInput.trim() !== shopifyOrder.name && shopifyOrderInput.trim() !== `#${shopifyOrder.name}`) {
      setShopifyOrder(null);
    }
  }, [shopifyOrderInput, shopifyOrder]);

  const handleShopifyLookup = async () => {
    setShopifyLookupBusy(true);
    setShopifyLookupError(null);
    try {
      const result = await lookupShopifyOrder(shopifyOrderInput);
      if (result.ok) {
        setShopifyOrder(result.order);
      } else {
        setShopifyOrder(null);
        setShopifyLookupError(result.message);
      }
    } catch (e) {
      setShopifyOrder(null);
      setShopifyLookupError(e instanceof Error ? e.message : 'Could not look up the order.');
    } finally {
      setShopifyLookupBusy(false);
    }
  };

  // Auto-pick the top-priority host as soon as a virtual service is
  // chosen so the receptionist sees the most common selection
  // pre-filled. Wipe back to null whenever the service flips away
  // from virtual — we never want a stale host id leaking into a
  // non-virtual booking row.
  const isVirtualService = serviceType === 'virtual_impression_appointment';
  useEffect(() => {
    if (!isVirtualService) {
      setMeetHostId(null);
      return;
    }
    if (meetHostId) return;
    if (meetHosts.length > 0) setMeetHostId(meetHosts[0]!.id);
  }, [isVirtualService, meetHosts, meetHostId]);

  // ── Load axis option lists for the picked service ──────────────
  useEffect(() => {
    if (!open || !serviceType) {
      setAxisOptionsLoading(false);
      return;
    }
    const axes = axesForService(serviceType);
    if (axes.length === 0) {
      setAxisOptionsLoading(false);
      return;
    }
    let cancelled = false;
    setAxisOptionsLoading(true);
    (async () => {
      const entries = await Promise.all(
        axes.map(async (a) => [a.key, await loadAxisValues(a)] as const),
      );
      if (cancelled) return;
      const next: Partial<Record<AxisKey, AxisValueOption[]>> = {};
      for (const [k, v] of entries) next[k] = v;
      setAxisOptions(next);
      setAxisOptionsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, serviceType]);

  // ── Effective axes for the current pick ────────────────────────
  // SERVICE_AXES declares what *could* apply for a service. We drop
  // the arch axis when the picked product's catalogue row has
  // arch_match='any' (e.g. whitening kit), so the receptionist isn't
  // asked an arch question that doesn't apply to that product.
  const effectiveAxes = useMemo<readonly AxisDef[]>(() => {
    if (!serviceType) return [];
    const axes = axesForService(serviceType);
    const productAxis = axes.find((a) => a.key === 'product_key');
    if (!productAxis || !axisValues.product_key) return axes;
    const productOptions = axisOptions.product_key ?? [];
    const picked = productOptions.find((o) => o.key === axisValues.product_key);
    if (picked?.archMatch === 'any') {
      return axes.filter((a) => a.key !== 'arch');
    }
    return axes;
  }, [serviceType, axisOptions.product_key, axisValues.product_key]);

  // Clear an arch pin that's no longer relevant (e.g. user picked
  // whitening_kit after picking aligner). Without this the row would
  // persist a stale arch that's hidden from the UI.
  useEffect(() => {
    const archIsEffective = effectiveAxes.some((a) => a.key === 'arch');
    if (!archIsEffective && axisValues.arch !== null) {
      setAxisValues((v) => ({ ...v, arch: null }));
    }
  }, [effectiveAxes, axisValues.arch]);

  const allAxesPinned = effectiveAxes.every((a) => {
    const v = axisValues[a.key];
    return v != null && v !== '';
  });

  // ── Resolve booking-type config when service / pins change ─────
  useEffect(() => {
    if (!open || !serviceType || !allAxesPinned) {
      setConfig(null);
      setConfigError(null);
      return;
    }
    let cancelled = false;
    setConfig(null);
    setConfigError(null);
    (async () => {
      try {
        const c = await resolveBookingTypeConfig({
          service_type: serviceType,
          repair_variant: axisValues.repair_variant,
          product_key: axisValues.product_key,
          arch: axisValues.arch,
        });
        if (cancelled) return;
        if (!c) {
          setConfigError(
            `No booking config for "${serviceType}". Set the parent defaults in Admin, Booking types first.`,
          );
          return;
        }
        setConfig(c);
      } catch (e) {
        if (cancelled) return;
        setConfigError(e instanceof Error ? e.message : 'Could not load booking config.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    serviceType,
    allAxesPinned,
    axisValues.repair_variant,
    axisValues.product_key,
    axisValues.arch,
  ]);

  // ── Live conflict check — debounced 250ms ──────────────────────
  useEffect(() => {
    if (!open || !config || !serviceType) return;
    const newStart = composeIso(date, time);
    if (!newStart) {
      setConflicts([]);
      setConflictError(null);
      return;
    }
    const newEnd = new Date(
      new Date(newStart).getTime() + config.duration_default * 60_000,
    ).toISOString();
    let cancelled = false;
    setCheckingConflicts(true);
    const t = setTimeout(async () => {
      try {
        const result = await checkBookingConflict({
          locationId,
          serviceType: serviceType as BookingServiceType,
          startAt: newStart,
          endAt: newEnd,
          repairVariant: axisValues.repair_variant,
          productKey: axisValues.product_key,
          arch: axisValues.arch,
        });
        if (cancelled) return;
        setConflicts(result);
        setConflictError(null);
      } catch (e) {
        if (cancelled) return;
        setConflictError(e instanceof Error ? e.message : 'Could not check the slot.');
      } finally {
        if (!cancelled) setCheckingConflicts(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [
    open,
    config,
    date,
    time,
    locationId,
    serviceType,
    axisValues.repair_variant,
    axisValues.product_key,
    axisValues.arch,
  ]);

  // ── First-available slot lookup (one round-trip, server-side) ──
  // Once the operator picks a service (and any required axes), ask
  // the server for the very first bookable date+time. Pre-pinning
  // the form to that result means the operator never sees a
  // "Closed on this day" / "no free times" intermediate state and
  // we don't need a client-side day-by-day probe loop.
  //
  // The hook only fires when serviceType is set, so the sheet stays
  // empty (mask up) until the service step is complete. When the
  // RPC returns null (no availability in the 60-day window), we
  // drop out of the searching state and fall back to the operator
  // picking manually — the date picker's available-dates whitelist
  // (also empty in that case) means every cell is dimmed, which is
  // an honest "nothing here" signal.
  const firstAvailable = useFirstAvailableSlot({
    locationId,
    serviceType: serviceType || null,
    repairVariant: axisValues.repair_variant,
    productKey: axisValues.product_key,
    arch: axisValues.arch,
  });
  useEffect(() => {
    if (!open) return;
    if (!searchingFirstSlot) return;
    if (firstAvailable.loading) return;
    if (firstAvailable.data) {
      setDate(firstAvailable.data.dateIso);
      setTime(firstAvailable.data.timeHm);
    }
    setSearchingFirstSlot(false);
  }, [open, searchingFirstSlot, firstAvailable.loading, firstAvailable.data]);

  // ── Available dates for the visible calendar month ─────────────
  // Drives the DatePicker's per-cell enabled state so closed days
  // (clinic shut) and empty days (everything booked / outside
  // working hours) can't be tapped. The DatePicker tells us which
  // window it's currently rendering via onVisibleMonthChange; we
  // ask the server for that window's bookable set and feed it back.
  const [calendarWindow, setCalendarWindow] = useState<{
    fromIso: string | null;
    toIso: string | null;
  }>({ fromIso: null, toIso: null });
  const monthAvailability = useAvailableDates({
    locationId,
    serviceType: serviceType || null,
    repairVariant: axisValues.repair_variant,
    productKey: axisValues.product_key,
    arch: axisValues.arch,
    fromIso: calendarWindow.fromIso,
    toIso: calendarWindow.toIso,
  });

  // ── Available slots for the picked day/service ─────────────────
  // The TimePicker is fed an explicit allow-list of HH:MM strings
  // so the operator can only land on slots that pass the same
  // conflict check the Save button runs. Refetched when any input
  // that changes the answer changes: date, location, service, the
  // service's resolved duration, and the axis pins that select a
  // child override. Until the fetch returns the picker renders a
  // soft "Checking availability..." placeholder rather than the
  // full grid, so we don't flash unavailable slots in then yank
  // them out.
  const [availableSlots, setAvailableSlots] = useState<string[] | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState<boolean>(false);
  useEffect(() => {
    if (!open || !config || !serviceType || !date) {
      setAvailableSlots(null);
      setAvailabilityLoading(false);
      return;
    }
    let cancelled = false;
    setAvailabilityLoading(true);
    (async () => {
      try {
        const rawSlots = await loadAvailableSlots({
          locationId,
          serviceType: serviceType as BookingServiceType,
          date,
          repairVariant: axisValues.repair_variant,
          productKey: axisValues.product_key,
          arch: axisValues.arch,
        });
        if (cancelled) return;
        // Strip past times when the picked date is today. The
        // server returns every working slot regardless of clock
        // time; the widget filters past slots client-side and we
        // mirror the same behaviour here so an operator on the
        // schedule late in the day can't accidentally book into a
        // 10:00 slot when it's already 14:30.
        const isToday = date === todayIso();
        const slots = isToday
          ? rawSlots.filter((slot) => {
              const iso = composeIso(date, slot);
              if (!iso) return false;
              return new Date(iso).getTime() > Date.now();
            })
          : rawSlots;
        setAvailableSlots(slots);
        // Operator-driven date change snap. Initial open is
        // handled by useFirstAvailableSlot which pre-pins date+time
        // server-side. Here we just keep the time field consistent
        // when the operator picks a different day from the
        // calendar — if their previous time doesn't fit the new
        // day's allow-list, snap to that day's first free slot.
        const first = slots[0];
        if (!searchingFirstSlot && first && !slots.includes(time)) {
          setTime(first);
        }
      } catch {
        // Soft fall back to the full grid on a fetch error rather
        // than locking the receptionist out — the live conflict
        // banner still catches a bad pick on Save.
        if (!cancelled) setAvailableSlots(null);
      } finally {
        if (!cancelled) setAvailabilityLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    config,
    date,
    locationId,
    serviceType,
    axisValues.repair_variant,
    axisValues.product_key,
    axisValues.arch,
  ]);

  // ── Working-hours check ────────────────────────────────────────
  // Single source of truth: lng_settings.clinic.opening_hours
  // (edited in Admin → Branding → Opening times). Per-service
  // working_hours is no longer read.
  const clinic = useClinicSettings();
  const hoursForDate = useMemo(() => {
    if (!date) return null;
    return dayHoursForDate(clinic.data.openingHours, date);
  }, [date, clinic.data.openingHours]);

  const inWorkingHours = useMemo(() => {
    if (!hoursForDate || !time) return false;
    if (time < hoursForDate.open || time >= hoursForDate.close) return false;
    const lunch = hoursForDate.break ?? null;
    if (lunch && lunch.end > lunch.start && time >= lunch.start && time < lunch.end) {
      return false;
    }
    return true;
  }, [hoursForDate, time]);

  // Defensive end-vs-close check covering the case where a stale
  // time survives in state — picker can't surface a past-close start
  // anymore, but a typed value or a race could still slip through.
  // GREATEST of appointment block and phase sum mirrors the RPC's
  // extent so the JS gate agrees with the SQL gate.
  const fitsBeforeClose = useMemo(() => {
    if (!config || !hoursForDate || !time) return false;
    const extent = Math.max(
      config.duration_default,
      config.block_duration_minutes ?? config.duration_default,
    );
    const [openH, openM] = hoursForDate.open.split(':').map(Number);
    const [closeH, closeM] = hoursForDate.close.split(':').map(Number);
    const [startH, startM] = time.split(':').map(Number);
    if ([openH, openM, closeH, closeM, startH, startM].some((n) => !Number.isFinite(n))) {
      return false;
    }
    const startMin = (startH ?? 0) * 60 + (startM ?? 0);
    const closeMin = (closeH ?? 0) * 60 + (closeM ?? 0);
    return startMin + extent <= closeMin;
  }, [config, hoursForDate, time]);

  // Past-time guard. Mirrors the customer widget's behaviour
  // (widget-create-appointment + state.ts both refuse past slots).
  // The DatePicker is also clamped via minIso so the operator can't
  // select a date earlier than today, but a same-day pick can still
  // land on a time that's now in the past while the receptionist
  // was typing — re-checked here so the Save button stays disabled
  // and the inline status banner explains why.
  const isPastSlot = useMemo(() => {
    if (!date || !time) return false;
    const iso = composeIso(date, time);
    if (!iso) return false;
    return new Date(iso).getTime() <= Date.now();
  }, [date, time]);

  const slotIsValid =
    !!config && !!date && !!time && inWorkingHours && fitsBeforeClose && !isPastSlot;
  // Virtual services require a Meet host. The dropdown auto-picks
  // the first one when hosts exist, so this guard mostly trips when
  // no host has been connected yet — Save stays disabled until
  // someone runs the OAuth flow in Admin > Services.
  const meetHostPicked = !isVirtualService || !!meetHostId;
  // Shopify order is opt-in per booking. The gate only fires when the
  // receptionist explicitly ticks "Coming in from an online order"
  // AND we don't have a resolved order yet — a half-typed number
  // can't slip through to Save. Untickets passes Save freely.
  const shopifyOrderAttached = !shopifyOrderApplies || !!shopifyOrder;
  const canSave =
    !!patient &&
    !!serviceType &&
    allAxesPinned &&
    slotIsValid &&
    conflicts.length === 0 &&
    !checkingConflicts &&
    !saving &&
    !configError &&
    !conflictError &&
    meetHostPicked &&
    shopifyOrderAttached;

  // Build the human-readable event_type_label that goes onto the row.
  // Receptionists see this on schedule cards, patients see it on
  // confirmation emails, and the catalogue picker on visit detail
  // re-infers from it. Including the axis labels (e.g. "Same-day
  // appliance · Whitening Tray · Upper") keeps every downstream
  // surface aligned with what the receptionist actually picked.
  const eventTypeLabel = useMemo(() => {
    if (!serviceType) return undefined;
    const base = BOOKING_SERVICE_TYPES.find((s) => s.value === serviceType)?.label ?? null;
    const axisLabels: string[] = [];
    for (const axis of effectiveAxes) {
      const value = axisValues[axis.key];
      if (!value) continue;
      const opts = axisOptions[axis.key] ?? [];
      const opt = opts.find((o) => o.key === value);
      axisLabels.push(opt?.label ?? axisValueLabel(axis, value));
    }
    return [base, ...axisLabels].filter(Boolean).join(' · ') || undefined;
  }, [serviceType, effectiveAxes, axisValues, axisOptions]);

  const onSave = async () => {
    if (!canSave || !patient || !serviceType) return;
    const newStart = composeIso(date, time);
    if (!newStart) return;
    // Last-line past-time guard. canSave already excludes isPastSlot
    // via slotIsValid, but the user could conceivably leave the
    // sheet open across midnight and tap Save against a now-stale
    // slot. Refuse the write rather than create a booking in the
    // past.
    if (new Date(newStart).getTime() <= Date.now()) {
      setSaving(false);
      return;
    }
    setSaving(true);
    try {
      const result = await createAppointment({
        patientId: patient.id,
        locationId,
        serviceType: serviceType as BookingServiceType,
        startAt: newStart,
        notes,
        sendEmail,
        eventTypeLabel,
        repairVariant: axisValues.repair_variant,
        productKey: axisValues.product_key,
        arch: axisValues.arch,
        meetHostId: isVirtualService ? meetHostId : null,
        shopifyOrder:
          shopifyOrderApplies && shopifyOrder
            ? {
                id: shopifyOrder.id,
                name: shopifyOrder.name,
                totalPricePence: shopifyOrder.total_price_pence,
                currency: shopifyOrder.currency,
              }
            : null,
      });
      onCreated(result.appointmentId, {
        emailSent: result.emailSent,
        emailReason: result.emailReason,
        meetCreateError: result.meetCreateError ?? null,
      });
    } catch (e) {
      if (e instanceof RescheduleConflictError) {
        setConflicts(e.conflicts);
        setToast({ tone: 'error', title: 'Slot just became unavailable' });
      } else {
        setToast({
          tone: 'error',
          title: e instanceof Error ? e.message : 'Could not create the booking',
        });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <BottomSheet
        open={open}
        onClose={onClose}
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[3] }}>
            <span
              aria-hidden
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 32,
                height: 32,
                borderRadius: theme.radius.pill,
                background: theme.color.accentBg,
                color: theme.color.accent,
                flexShrink: 0,
              }}
            >
              <CalendarPlus size={18} aria-hidden />
            </span>
            New booking
          </span>
        }
        footer={
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: theme.space[3],
            }}
          >
            <div style={{ minWidth: 0 }}>
              {patient ? (
                <ConfirmationToggle
                  patient={patient}
                  checked={sendEmail}
                  onChange={(v) => {
                    setSendEmail(v);
                    setSendEmailUserOverride(true);
                  }}
                />
              ) : null}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: theme.space[2],
              }}
            >
              <Button variant="tertiary" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" onClick={onSave} disabled={!canSave} loading={saving}>
                {saving ? 'Saving…' : 'Book it'}
              </Button>
            </div>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          <Section
            title="Patient"
            info="Search existing patients by phone, name, or email. Also includes Venneir.com customers who haven't been seen at this clinic yet. If there's no match, you can create the patient inline without leaving this sheet."
          >
            {patient ? (
              <PickedPatient patient={patient} onClear={() => setPatient(null)} />
            ) : patientCreate ? (
              <NewPatientForm
                draft={patientCreate}
                onChange={setPatientCreate}
                seedTerm={patientCreate.seedTerm}
                busy={creatingPatient}
                error={createPatientError}
                onCancel={() => {
                  setPatientCreate(null);
                  setCreatePatientError(null);
                }}
                onSave={async () => {
                  setCreatePatientError(null);
                  setCreatingPatient(true);
                  try {
                    const created = await createPatient({
                      locationId,
                      first_name: patientCreate.first_name,
                      last_name: patientCreate.last_name,
                      email: patientCreate.email,
                      phone: patientCreate.phone,
                    });
                    setPatient(created);
                    setPatientCreate(null);
                  } catch (e) {
                    setCreatePatientError(
                      e instanceof Error ? e.message : 'Could not create patient',
                    );
                  } finally {
                    setCreatingPatient(false);
                  }
                }}
              />
            ) : (
              <PatientSearch
                onPick={setPatient}
                onCreateNew={(term) => {
                  setPatientCreate(seedDraftFromTerm(term));
                }}
                placeholder="Phone, name, or email"
                enableShopifyLookup={Boolean(locationId)}
                registerLocationId={locationId}
              />
            )}
          </Section>

          <Section
            title="Service"
            required
            info="The service drives the booking's duration and which resources (chair, lab bench, room) it consumes. Working hours and conflict rules come from Admin, Booking types and Conflicts."
          >
            <DropdownSelect<BookingServiceType>
              ariaLabel="Service"
              value={serviceType}
              onChange={(v) => setServiceType(v)}
              options={BOOKING_SERVICE_TYPES}
              placeholder="Choose a service"
            />
            {configError ? (
              <div style={{ marginTop: theme.space[3] }}>
                <StatusBanner tone="error" title="Couldn't load booking config">
                  {configError}
                </StatusBanner>
              </div>
            ) : null}
          </Section>

          {pairAxesForLayout(effectiveAxes).map((row) => {
            const renderAxis = (axis: AxisDef) => {
              const options = axisOptions[axis.key] ?? [];
              const value = axisValues[axis.key] ?? '';
              return (
                <Section
                  key={axis.key}
                  title={axis.label}
                  required
                  info={infoForAxis(axis.key)}
                >
                  <DropdownSelect<string>
                    ariaLabel={axis.label}
                    value={value}
                    onChange={(v) => {
                      setAxisValues((prev) => ({
                        ...prev,
                        [axis.key]: axis.key === 'arch' ? (v as ArchValue) : v,
                      }));
                    }}
                    options={options.map((o) => ({ value: o.key, label: o.label }))}
                    placeholder={
                      axisOptionsLoading && options.length === 0
                        ? 'Loading…'
                        : placeholderForAxis(axis.key)
                    }
                    disabled={axisOptionsLoading && options.length === 0}
                  />
                </Section>
              );
            };
            if (row.length === 2) {
              return (
                <div
                  key={`${row[0]!.key}+${row[1]!.key}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: theme.space[5],
                  }}
                >
                  {renderAxis(row[0]!)}
                  {renderAxis(row[1]!)}
                </div>
              );
            }
            return renderAxis(row[0]!);
          })}

          {isVirtualService ? (
            <Section
              title="Meeting host"
              required
              info="Whose Google account owns the Meet room for this appointment. The host's calendar reflects the booking and attendance data is pulled from the same Google account after the meeting ends."
            >
              {meetHosts.length === 0 ? (
                <div
                  style={{
                    padding: `${theme.space[4]}px ${theme.space[4]}px`,
                    borderRadius: theme.radius.input,
                    background: theme.color.bg,
                    border: `1px dashed ${theme.color.border}`,
                  }}
                >
                  <p
                    style={{
                      margin: 0,
                      fontSize: theme.type.size.sm,
                      color: theme.color.ink,
                      lineHeight: 1.5,
                      fontWeight: theme.type.weight.semibold,
                    }}
                  >
                    No Meet hosts connected yet.
                  </p>
                  <p
                    style={{
                      margin: `${theme.space[1]}px 0 ${theme.space[3]}px`,
                      fontSize: theme.type.size.xs,
                      color: theme.color.inkMuted,
                      lineHeight: 1.5,
                    }}
                  >
                    Connect a Google account in Admin so this booking has a host whose calendar owns the Meet room and whose attendance you can read back.
                  </p>
                  <a
                    href="/admin?tab=services"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: `${theme.space[2]}px ${theme.space[3]}px`,
                      borderRadius: theme.radius.pill,
                      border: `1px solid ${theme.color.border}`,
                      background: theme.color.surface,
                      color: theme.color.accent,
                      fontSize: theme.type.size.xs,
                      fontWeight: theme.type.weight.semibold,
                      textDecoration: 'none',
                    }}
                  >
                    Open Admin, Services
                  </a>
                </div>
              ) : (
                <DropdownSelect<string>
                  ariaLabel="Meeting host"
                  value={meetHostId ?? ''}
                  onChange={(v) => setMeetHostId(v || null)}
                  options={meetHosts.map((h) => ({
                    value: h.id,
                    label: `${h.display_name} (${h.google_email})`,
                  }))}
                  placeholder={meetHostsLoading ? 'Loading hosts' : 'Pick a host'}
                  disabled={meetHostsLoading}
                />
              )}
            </Section>
          ) : null}

          {isShopifyService ? (
            <Section
              title="Online order"
              info="Tick this when the patient is coming in to redeem something they bought on venneir.com. The amount they already paid online credits against the bill at checkout, so they only owe anything extra on the day. Leave it unticked for normal walk-in bookings of this service."
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: theme.space[3],
                }}
              >
                <Checkbox
                  checked={shopifyOrderApplies}
                  onChange={(v) => setShopifyOrderApplies(v)}
                  label="Coming in to redeem an online order from venneir.com"
                />

                {shopifyOrderApplies ? (
                  <>
                    <div style={{ display: 'flex', gap: theme.space[2], alignItems: 'stretch' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Input
                          aria-label="Shopify order number"
                          value={shopifyOrderInput}
                          // Force uppercase as the receptionist types
                          // — Shopify order numbers are always
                          // uppercased (VEN70933, PSG-991630) and
                          // typing "ven" then seeing "VEN" rerender
                          // is cleaner than letting mixed case sit
                          // in the field. The RPC is already case-
                          // insensitive so this is purely visual.
                          onChange={(e) => setShopifyOrderInput(e.target.value.toUpperCase())}
                          style={{ textTransform: 'uppercase' }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              if (!shopifyLookupBusy && shopifyOrderInput.trim().length > 0) {
                                void handleShopifyLookup();
                              }
                            }
                          }}
                          placeholder="Order number, e.g. VEN73520"
                          autoComplete="off"
                          autoFocus
                        />
                      </div>
                      <Button
                        variant="secondary"
                        onClick={handleShopifyLookup}
                        disabled={shopifyLookupBusy || shopifyOrderInput.trim().length === 0 || !!shopifyOrder}
                        loading={shopifyLookupBusy}
                      >
                        Look up
                      </Button>
                    </div>

                    {shopifyOrder ? (
                      <ShopifyOrderCard
                        order={shopifyOrder}
                        onClear={() => {
                          setShopifyOrder(null);
                          setShopifyOrderInput('');
                          setShopifyLookupError(null);
                        }}
                      />
                    ) : shopifyLookupError ? (
                      <p
                        role="alert"
                        style={{
                          margin: 0,
                          fontSize: theme.type.size.sm,
                          color: theme.color.alert,
                          lineHeight: 1.5,
                        }}
                      >
                        {shopifyLookupError}
                      </p>
                    ) : (
                      <p
                        style={{
                          margin: 0,
                          fontSize: theme.type.size.xs,
                          color: theme.color.inkSubtle,
                          lineHeight: 1.5,
                        }}
                      >
                        The order's total will credit against the bill at checkout, so the patient only pays for anything extra on the day.
                      </p>
                    )}
                  </>
                ) : null}
              </div>
            </Section>
          ) : null}

          {config ? (
          <Section
            title="When"
            info="The slot is checked live against the service's working hours and any other bookings claiming the same resources. Save is disabled until the slot is in hours and conflict-free."
          >
            {searchingFirstSlot ? (
              /* Auto-search placeholder. The slots-load effect is
                 walking forward day-by-day looking for the first
                 free slot; without this mask the date FieldTrigger
                 flashed through every probed day, reading as
                 glitchy. Single skeleton row in place of the
                 date+time pair while the search settles. */
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: theme.space[3],
                  padding: `${theme.space[3]}px ${theme.space[4]}px`,
                  borderRadius: theme.radius.input,
                  border: `1px solid ${theme.color.border}`,
                  background: theme.color.surface,
                  color: theme.color.inkMuted,
                  fontSize: theme.type.size.sm,
                  fontWeight: theme.type.weight.medium,
                  minHeight: 44,
                }}
                aria-live="polite"
              >
                <span
                  aria-hidden
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    border: `2px solid ${theme.color.border}`,
                    borderTopColor: theme.color.accent,
                    animation: 'lng-newbooking-search-spin 0.9s linear infinite',
                    flexShrink: 0,
                  }}
                />
                Finding the next available slot…
                <style>{`
                  @keyframes lng-newbooking-search-spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                  }
                `}</style>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: theme.space[3] }}>
                <FieldTrigger
                  ref={dateTriggerRef}
                  icon={<CalendarClock size={16} aria-hidden />}
                  value={date ? formatDateLong(date) : ''}
                  placeholder="Pick a date"
                  open={dateOpen}
                  onClick={() => {
                    setTimeOpen(false);
                    setDateOpen((v) => !v);
                  }}
                />
                <FieldTrigger
                  ref={timeTriggerRef}
                  icon={<Clock size={16} aria-hidden />}
                  value={time}
                  placeholder="Pick a time"
                  open={timeOpen}
                  onClick={() => {
                    setDateOpen(false);
                    setTimeOpen((v) => !v);
                  }}
                />
              </div>
            )}
            <DatePicker
              open={dateOpen}
              onClose={() => setDateOpen(false)}
              value={date}
              onChange={(iso) => setDate(iso)}
              anchorRef={dateTriggerRef}
              title="Pick the booking date"
              // Whitelist drives every cell's enabled state. Closed
              // days and empty days dim from the moment the picker
              // opens — the operator can't tap a dead cell, so the
              // "Outside working hours" / "Closed on this day"
              // warnings that used to surface after the fact are
              // structurally impossible to reach. minIso=today is
              // a defence-in-depth backstop for the moment between
              // mount and the first available-dates fetch.
              minIso={todayIso()}
              availableDates={
                monthAvailability.loading ? undefined : monthAvailability.dates
              }
              onVisibleMonthChange={(fromIso, toIso) =>
                setCalendarWindow({ fromIso, toIso })
              }
            />
            <TimePicker
              open={timeOpen}
              onClose={() => setTimeOpen(false)}
              value={time}
              onChange={(t) => setTime(t)}
              anchorRef={timeTriggerRef}
              title="Pick the start time"
              startHour={hoursForDate ? clampHour(hoursForDate.open) : 6}
              endHour={hoursForDate ? clampHour(hoursForDate.close, true) : 22}
              availableSlots={availableSlots ?? undefined}
              availabilityLoading={availabilityLoading}
              emptyMessage={
                hoursForDate
                  ? 'No free times that day.'
                  : 'Closed on this day.'
              }
            />
            {config && !searchingFirstSlot ? (
              <InlineHint
                tone={hoursForDate || !date ? 'muted' : 'alert'}
              >
                {config.duration_default}-minute slot
                {hoursForDate
                  ? `. Hours that day: ${hoursForDate.open} to ${hoursForDate.close}${
                      hoursForDate.break && hoursForDate.break.end > hoursForDate.break.start
                        ? `, minus lunch ${hoursForDate.break.start} to ${hoursForDate.break.end}`
                        : ''
                    }.`
                  : date
                  ? '. The clinic is closed on this day.'
                  : '.'}
              </InlineHint>
            ) : null}
            {config && date && time && !searchingFirstSlot ? (
              <ReturnSegmentHints
                phases={config.phases}
                startIso={composeIso(date, time)}
              />
            ) : null}
            {/* Warning banners that used to surface here ("Outside
                working hours" / "That time has already passed") are
                now structurally impossible to reach: the date
                picker's whitelist hides closed/empty days, and the
                time picker's allow-list omits past times on
                today's date. Conflicts (last-millisecond race
                with another concurrent booking) still flow through
                the ConflictBlock below. */}
            {searchingFirstSlot ? null : (
              <div style={{ marginTop: theme.space[3] }}>
                <ConflictBlock
                  checking={checkingConflicts}
                  conflicts={conflicts}
                  error={conflictError}
                  slotIsValid={slotIsValid}
                  durationMinutes={config?.duration_default ?? null}
                  /* silentChecking hides the in-flight "Checking
                   * availability… (X min slot)" banner — the picker
                   * already restricts to free times so the flash on
                   * every input edit reads as noise. The check
                   * still runs and gates Save via checkingConflicts.
                   * No freeBody — re-confirming "free" beneath the
                   * date row would also be redundant. Conflicts
                   * (last-millisecond race against another
                   * concurrent edit) and RPC errors always surface. */
                  silentChecking
                />
              </div>
            )}
          </Section>
          ) : null}

          <Section
            title="Notes"
            info="Optional. Anything the team should know going in. Visible on the schedule card and on the patient profile."
          >
            <Input
              aria-label="Notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. wheelchair access; bringing a translator; allergic to latex."
            />
          </Section>

        </div>
      </BottomSheet>
      {toast ? (
        <Toast
          tone={toast.tone}
          title={toast.title}
          description={toast.description}
          onDismiss={() => setToast(null)}
        />
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

interface NewPatientDraft {
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  // The original search term — kept around so we can show "Seeded
  // from your search for …" microcopy and so undo would be easy if
  // we ever wanted that.
  seedTerm: string;
}

// Inline create-new-patient form rendered inside the Patient
// Section when no match exists for the search. Same field set as
// NewWalkIn's create step (first / last / phone / email), seeded
// intelligently from the search term so the receptionist isn't
// re-typing what they already typed.
function NewPatientForm({
  draft,
  onChange,
  seedTerm,
  busy,
  error,
  onCancel,
  onSave,
}: {
  draft: NewPatientDraft;
  onChange: (next: NewPatientDraft) => void;
  seedTerm: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      {seedTerm ? (
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.xs,
            color: theme.color.inkSubtle,
          }}
        >
          Seeded from your search for &ldquo;{seedTerm}&rdquo;.
        </p>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
        <Input
          label="First name"
          required
          autoFocus={!draft.first_name}
          value={draft.first_name}
          onChange={(e) => onChange({ ...draft, first_name: e.target.value })}
          disabled={busy}
        />
        <Input
          label="Last name"
          required
          value={draft.last_name}
          onChange={(e) => onChange({ ...draft, last_name: e.target.value })}
          disabled={busy}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
        <Input
          label="Phone"
          type="tel"
          value={draft.phone}
          onChange={(e) => onChange({ ...draft, phone: e.target.value })}
          disabled={busy}
        />
        <Input
          label="Email"
          type="email"
          value={draft.email}
          onChange={(e) => onChange({ ...draft, email: e.target.value })}
          disabled={busy}
        />
      </div>
      {error ? (
        <StatusBanner tone="error" title="Couldn't create patient">
          {error}
        </StatusBanner>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: theme.space[2] }}>
        <Button type="button" variant="tertiary" onClick={onCancel} disabled={busy}>
          Back to search
        </Button>
        <Button type="button" variant="primary" onClick={onSave} loading={busy} disabled={busy}>
          {busy ? 'Creating…' : 'Create patient'}
        </Button>
      </div>
    </div>
  );
}

function PickedPatient({
  patient,
  onClear,
}: {
  patient: PatientRow;
  onClear: () => void;
}) {
  const name = patientFullName(patient);
  const sub = patient.email ?? patient.phone ?? patient.internal_ref;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: theme.color.bg,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: theme.color.surface,
          color: theme.color.inkMuted,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <User size={16} aria-hidden />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </p>
        <p
          style={{
            margin: `2px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {sub}
        </p>
      </div>
      <Button variant="tertiary" size="sm" onClick={onClear}>
        Change
      </Button>
    </div>
  );
}

function ConfirmationToggle({
  patient,
  checked,
  onChange,
}: {
  patient: PatientRow | null;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const hasEmail = !!patient?.email;
  return (
    <Checkbox
      checked={hasEmail && checked}
      onChange={onChange}
      disabled={!hasEmail}
      label={
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.ink, fontWeight: theme.type.weight.medium }}>
          Send confirmation email
        </span>
      }
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirmation card shown when a Shopify order resolves successfully.
// Same visual language as the Meet-host-empty callout below (rounded
// surface with dashed/accent edge) so the receptionist reads it as
// "this is staged on the booking" — and the Remove button lets them
// pull it off if they typed the wrong number.
function ShopifyOrderCard({
  order,
  onClear,
}: {
  order: ShopifyOrderLookup;
  onClear: () => void;
}) {
  const customerLine = order.customer_name?.trim()
    ? order.customer_name.trim()
    : null;
  return (
    <div
      style={{
        padding: `${theme.space[4]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: theme.color.accentBg,
        border: `1px solid ${theme.color.accent}`,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[3],
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: theme.space[3] }}>
        <div style={{ minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
            }}
          >
            {order.name}
          </p>
          {customerLine ? (
            <p
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                lineHeight: 1.4,
              }}
            >
              {customerLine}
            </p>
          ) : null}
        </div>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.accent,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {formatPence(order.total_price_pence)} paid
        </p>
      </div>

      {order.items.length > 0 ? (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: `${theme.space[3]}px 0 0`,
            borderTop: `1px solid ${theme.color.accent}`,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[1],
          }}
        >
          {order.items.map((item, i) => (
            <li
              key={`${item.sku ?? 'noSku'}|${i}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: theme.space[3],
                fontSize: theme.type.size.sm,
                color: theme.color.ink,
                lineHeight: 1.4,
              }}
            >
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                  flex: 1,
                }}
              >
                {item.title ?? item.sku ?? 'Item'}
              </span>
              <span
                style={{
                  color: theme.color.inkMuted,
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                ×{item.quantity}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
          lineHeight: 1.5,
        }}
      >
        Paid online on{' '}
        {new Date(order.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
      </p>
      <button
        type="button"
        onClick={onClear}
        style={{
          alignSelf: 'flex-start',
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          padding: 0,
          color: theme.color.inkMuted,
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.medium,
          textDecoration: 'underline',
          textUnderlineOffset: 3,
          fontFamily: 'inherit',
          cursor: 'pointer',
        }}
      >
        Remove order
      </button>
    </div>
  );
}

// Helpers (local copies of the small ISO splitters used by RescheduleSheet —
// duplicated rather than extracted because the two sheets evolve independently
// and the helpers are 5 lines each)
// ─────────────────────────────────────────────────────────────────────────────

function splitIso(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${mi}` };
}

function composeIso(date: string, time: string): string | null {
  if (!date || !time) return null;
  const d = new Date(`${date}T${time}:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Working hours come back as 'HH:MM' strings; bound them to whole
// hours for the TimePicker's startHour / endHour scrollable range.
// `endRoundUp` rounds 18:30 → 19 so the last in-hours slot is
// reachable.
function formatDateLong(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// Per-axis copy. Kept inline rather than moved to the registry because
// the wording is specific to the new-booking flow's tone (other axis
// surfaces, like the admin override picker, use shorter labels).
function infoForAxis(key: AxisKey): string {
  if (key === 'repair_variant') {
    return 'Which type of repair the patient is in for. Drives slot length and resources.';
  }
  if (key === 'product_key') {
    return 'Which appliance the patient is in for. Drives slot length and which arch options apply.';
  }
  return 'Which arch the patient is having work on.';
}

function placeholderForAxis(key: AxisKey): string {
  if (key === 'repair_variant') return 'Choose a repair type';
  if (key === 'product_key') return 'Choose a product';
  return 'Choose an arch';
}

// Group product_key + arch into a single 2-up row when both are
// active (same-day appliance + virtual impression today; in-person
// impression will join once its product axis is added). Every other
// axis renders on its own row.
function pairAxesForLayout(axes: readonly AxisDef[]): AxisDef[][] {
  const rows: AxisDef[][] = [];
  for (let i = 0; i < axes.length; i++) {
    const a = axes[i]!;
    const b = axes[i + 1];
    if (a.key === 'product_key' && b && b.key === 'arch') {
      rows.push([a, b]);
      i++;
      continue;
    }
    rows.push([a]);
  }
  return rows;
}

function clampHour(hhmm: string, endRoundUp = false): number {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h)) return endRoundUp ? 22 : 6;
  if (endRoundUp && m > 0) return Math.min(23, h + 1);
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────
// Patient creation (mirrors NewWalkIn's two-step pattern)
// ─────────────────────────────────────────────────────────────────────────────

// Classify a search term so the create form gets seeded into the
// right field. Anything with @ → email; phone-like digits → phone;
// otherwise treat as a name and split on whitespace.
function classifySearchTerm(term: string): 'email' | 'phone' | 'name' {
  const trimmed = term.trim();
  if (trimmed.includes('@')) return 'email';
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length >= 7 && digits.length <= 15 && /^[\d\s+()\-]+$/.test(trimmed)) {
    return 'phone';
  }
  return 'name';
}

function seedDraftFromTerm(term: string): NewPatientDraft {
  const trimmed = term.trim();
  const draft: NewPatientDraft = {
    first_name: '',
    last_name: '',
    phone: '',
    email: '',
    seedTerm: term,
  };
  const kind = classifySearchTerm(trimmed);
  if (kind === 'email') {
    draft.email = trimmed;
  } else if (kind === 'phone') {
    draft.phone = trimmed;
  } else {
    const parts = trimmed.split(/\s+/);
    draft.first_name = parts[0] ?? '';
    draft.last_name = parts.slice(1).join(' ');
  }
  return draft;
}

function humanizePatientSaveError(err: { message?: string; code?: string } | null): string {
  const msg = err?.message ?? '';
  const code = err?.code;
  if (code === '23505' || /duplicate key|unique constraint/i.test(msg)) {
    if (/email/i.test(msg)) {
      return 'A patient with this email is already on file at this location. Use the search to find them.';
    }
    if (/phone/i.test(msg)) {
      return 'A patient with this phone number is already on file at this location. Use the search to find them.';
    }
    return 'This person is already on file at this location. Use the search to find them.';
  }
  return msg || 'Could not create patient.';
}

async function createPatient(args: {
  locationId: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
}): Promise<PatientRow> {
  if (!args.first_name.trim() || !args.last_name.trim()) {
    throw new Error('First name and last name are required.');
  }
  // patients.account_id is a legacy NOT NULL column — resolve from
  // the signed-in user. Same path NewWalkIn uses.
  const { data: accountId, error: accErr } = await supabase.rpc('auth_account_id');
  if (accErr || !accountId) {
    throw new Error(
      accErr?.message ??
        'Could not resolve your account. Make sure your accounts row is set up in Meridian.',
    );
  }
  const { data, error } = await supabase
    .from('patients')
    .insert({
      account_id: accountId,
      location_id: args.locationId,
      first_name: args.first_name.trim(),
      last_name: args.last_name.trim(),
      email: args.email.trim() || null,
      phone: args.phone.trim() || null,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(humanizePatientSaveError(error));
  return data as PatientRow;
}
