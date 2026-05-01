import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Loader2,
  Minus,
  Package,
  Pencil,
  Plus,
  ShieldCheck,
  ShoppingBag,
  UserRound,
  X,
} from 'lucide-react';
import {
  AddressAutocompleteField,
  Button,
  Card,
  Checkbox,
  DateOfBirthRow,
  Dialog,
  DropdownSelect,
  Input,
  Skeleton,
  Toast,
} from '../components/index.ts';
import { WaiverInline, type WaiverInlineHandle } from '../components/WaiverInline/WaiverInline.tsx';
import { MAX_TECH_NOTE_LENGTH } from '../lib/printLwo.ts';
import { CataloguePicker } from '../components/CataloguePicker/CataloguePicker.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useCurrentAccount } from '../lib/queries/currentAccount.ts';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { useKeyboardOpen } from '../lib/useKeyboardOpen.ts';
import { type ParsedAddress } from '../lib/useAddressAutocomplete.ts';
import { supabase } from '../lib/supabase.ts';
import {
  type CatalogueRow,
} from '../lib/queries/catalogue.ts';
import {
  addCatalogueItemsToCart,
  formatPence,
  type CatalogueAddOptions,
  type CartRow,
} from '../lib/queries/carts.ts';
import { totalForQtyWithArch } from '../lib/catalogueMatch.ts';
import { properCase } from '../lib/queries/appointments.ts';
import { patientFullName } from '../lib/queries/patients.ts';
import {
  appointmentRequiresJbRef,
  checkJbAvailability,
  readIntakeSnapshot,
  submitArrivalIntake,
  walkInServiceLabel,
  type ArrivalIntakeSnapshot,
  type JbAvailabilityResult,
} from '../lib/queries/arrivalIntake.ts';
import {
  inferServiceTypeFromEventLabel,
  requiredSectionsForCart,
  summariseWaiverFlag,
  useAllCatalogueWaiverRequirements,
  useWaiverSections,
  usePatientWaiverState,
  type WaiverFlag,
  type WaiverSection,
} from '../lib/queries/waiver.ts';
import {
  createWalkInVisit,
  markAppointmentArrived,
} from '../lib/queries/visits.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Arrival wizard. Four steps:
//
//   1. Service       — staff prep: JB + items + notes.
//   2. Customer      — patient confirms what's being worked on, fills any
//                      missing personal details. 2-col grid on tablet.
//   3. Consent       — inline waiver (terms + signature pad + witnessed-by).
//   4. Start         — staff confirm summary + Start appointment.
//
// Visual treatment:
//   - Steps 1 + 4 use back-office density.
//   - Steps 2 + 3 are patient-facing — generous padding, larger heading,
//     friendlier microcopy, on-file fields shown as muted readonly so
//     the patient sees we already have them and only confirms.
//
// All database writes happen on the step 4 submit. Abandoning earlier
// leaves nothing partially formed (waiver signatures are the lone
// exception — they're patient-axis and survive between visits, which
// is the desired behaviour).
//
// Two URL shapes:
//   /arrival/appointment/:id    booked-then-arrived
//   /arrival/walk-in/:patientId walk-in
// ─────────────────────────────────────────────────────────────────────────────

type Mode = 'appointment' | 'walk_in';
type Step = 'service' | 'customer' | 'consent' | 'start';

interface AppointmentContext {
  id: string;
  patient_id: string;
  location_id: string;
  event_type_label: string | null;
  start_at: string;
  // Calendly-collected deposit. Surfaced on the staff and customer
  // steps as a deduction from the staged total, so receptionists
  // and patients both see what's owed at the till. Null on
  // walk-ins and on free booking types.
  deposit_pence: number | null;
  deposit_status: 'paid' | 'failed' | null;
  deposit_provider: 'paypal' | 'stripe' | null;
}

interface PatientLite {
  id: string;
  first_name: string;
  last_name: string;
  location_id: string | null;
  // Truthy when this patient was synced from Shopify / has a One Click
  // online ordering profile. Edits to identity fields propagate there
  // too, which we tell the patient explicitly so they aren't
  // surprised by a profile sync on their next online visit.
  shopify_customer_id: string | null;
}

interface StagedItem {
  key: string;
  catalogue: CatalogueRow;
  qty: number;
  options: CatalogueAddOptions;
}

interface FormState {
  first_name: string;
  last_name: string;
  date_of_birth: string;
  sex: string;
  email: string;
  phone: string;
  portal_ship_line1: string;
  portal_ship_line2: string;
  portal_ship_city: string;
  portal_ship_postcode: string;
  portal_ship_country_code: string;
  allergies: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  // "How did you hear about us?" — captured once on first arrival
  // and never again. Drives Reports → Marketing attribution.
  referred_by: string;
}

const EMPTY_FORM: FormState = {
  first_name: '',
  last_name: '',
  date_of_birth: '',
  sex: '',
  email: '',
  phone: '',
  portal_ship_line1: '',
  portal_ship_line2: '',
  portal_ship_city: '',
  portal_ship_postcode: '',
  portal_ship_country_code: 'GB',
  allergies: '',
  emergency_contact_name: '',
  emergency_contact_phone: '',
  referred_by: '',
};

const SEX_OPTIONS = ['Female', 'Male', 'Other', 'Prefer not to say'] as const;

// Priority order for picking the primary service type when a walk-in
// basket spans multiple service categories. The visit row stores a
// single service_type (it gates JB ref, waivers, and clinic-board lane
// bucketing), so we pick the highest-priority value present. Repairs
// come first because they're JB- and time-sensitive; impression
// appointments next (they always need a JB); click-in veneers after
// (lab-coupled); same-day appliance after that; everything else falls
// through to "other".
// Address fields edited as one cluster — tapping any pencil
// unlocks all four so the Places autocomplete on line 1 can fill
// every cell from a single selection.
const ADDRESS_GROUP_FIELDS: (keyof FormState)[] = [
  'portal_ship_line1',
  'portal_ship_line2',
  'portal_ship_city',
  'portal_ship_postcode',
];

const SERVICE_TYPE_PRIORITY = [
  'denture_repair',
  'impression_appointment',
  'click_in_veneers',
  'same_day_appliance',
  'other',
] as const;

const SERVICE_TYPE_LABELS: Record<string, string> = {
  denture_repair: 'Denture repair',
  same_day_appliance: 'Same-day appliance',
  click_in_veneers: 'Click-in veneers',
  impression_appointment: 'Impression appointment',
  other: 'Other / consultation',
};

// Pence total for a staged line: arch-aware catalogue total + upgrade
// pence riding every quantity tick. Mirrors what addCatalogueItemsToCart
// will write — same formula in two places, but the cart writer rolls
// upgrades into unit_price_pence at insert and we reproduce it here so
// the staged subtotal matches the cart subtotal once the visit opens.
function stagedLineTotalPence(it: StagedItem): number {
  const upgradePerInstancePence = (it.options.upgrades ?? []).reduce(
    (sum, u) => sum + u.price_pence,
    0
  );
  const base = totalForQtyWithArch(it.catalogue, it.qty, it.options.arch ?? null);
  return Math.round(base * 100) + upgradePerInstancePence * it.qty;
}

function recognisedServiceTypes(items: StagedItem[]): string[] {
  const set = new Set<string>();
  for (const it of items) {
    const t = it.catalogue.service_type;
    if (t) set.add(t);
  }
  return [...set].sort((a, b) => {
    const ia = (SERVICE_TYPE_PRIORITY as readonly string[]).indexOf(a);
    const ib = (SERVICE_TYPE_PRIORITY as readonly string[]).indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

function primaryServiceType(items: StagedItem[]): string | null {
  return recognisedServiceTypes(items)[0] ?? null;
}

const STEPS: { id: Step; label: string }[] = [
  { id: 'service', label: 'Service' },
  { id: 'customer', label: 'Customer details' },
  { id: 'consent', label: 'Consent' },
  { id: 'start', label: 'Start' },
];

export function Arrival() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { account: currentAccount } = useCurrentAccount();
  const isMobile = useIsMobile(640);

  const path = typeof window !== 'undefined' ? window.location.pathname : '';
  const mode: Mode = path.startsWith('/arrival/walk-in') ? 'walk_in' : 'appointment';

  const [step, setStep] = useState<Step>('service');
  // Reset scroll on every step transition. The Arrival route doesn't
  // change URL between steps (it's all internal state) so the App-level
  // ScrollToTop doesn't fire here — handle it ourselves. The page
  // scroll lives on #root (body is pinned to the viewport for iOS
  // rubber-band), so window.scrollTo would be a no-op.
  useEffect(() => {
    document.getElementById('root')?.scrollTo(0, 0);
  }, [step]);
  const [appointment, setAppointment] = useState<AppointmentContext | null>(null);
  const [patient, setPatient] = useState<PatientLite | null>(null);
  const [snapshot, setSnapshot] = useState<ArrivalIntakeSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [stagedItems, setStagedItems] = useState<StagedItem[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [jbRef, setJbRef] = useState('');
  const [jbCheck, setJbCheck] = useState<JbAvailabilityResult | null>(null);
  const [jbChecking, setJbChecking] = useState(false);
  const [jbError, setJbError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [itemsConfirmed, setItemsConfirmed] = useState(false);
  // Fields the patient has tapped the pencil on. These bypass the
  // fill-blanks rule at submit time — whatever's in the form gets
  // written, overwriting what's on file. Bypassing only happens for
  // the explicit edit gesture, not for typing in initially-blank
  // inputs (those still flow through fill-blanks).
  const [editingFields, setEditingFields] = useState<Set<keyof FormState>>(new Set());

  const beginEditField = (key: keyof FormState) => {
    setEditingFields((s) => {
      const next = new Set(s);
      next.add(key);
      // Address fields are edited as a cluster: tapping any one of
      // the four pencils unlocks all of them at once. The patient
      // then types into Address line 1, picks a Places suggestion,
      // and the full set (line 1 / line 2 / city / postcode)
      // populates from the parsed result. Splitting the unlock
      // would force four separate gestures for one logical action.
      if (ADDRESS_GROUP_FIELDS.includes(key)) {
        for (const grouped of ADDRESS_GROUP_FIELDS) next.add(grouped);
      }
      return next;
    });
  };
  const [submitting, setSubmitting] = useState(false);
  // Synchronous re-entry guard. setSubmitting(true) is batched and the
  // button's disabled prop doesn't paint until React commits, leaving
  // a small window where a double-tap could fire handleStartAppointment
  // twice and spawn two walk-in rows + two lng_appointments markers
  // (no idempotency in createWalkInVisit). The ref blocks the second
  // call before any await.
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // Waiver step is driven from the persistent footer instead of an
  // inline button. We mirror the WaiverInline's readiness + busy
  // state into Arrival so ActionBar can render "Sign and continue"
  // with the right disabled/loading attributes.
  const waiverRef = useRef<WaiverInlineHandle | null>(null);
  const [waiverReady, setWaiverReady] = useState(false);
  const [waiverBusy, setWaiverBusy] = useState(false);

  // Walk-ins: derive the service type from whatever's been staged in the
  // bag. The primary type drives JB ref / waiver gating; the full set is
  // surfaced in the UI so the receptionist can see when a basket spans
  // multiple categories.
  const inferredServiceType = useMemo(
    () => primaryServiceType(stagedItems),
    [stagedItems]
  );
  const recognisedTypes = useMemo(
    () => recognisedServiceTypes(stagedItems),
    [stagedItems]
  );

  const eventTypeLabel = useMemo(() => {
    if (mode === 'appointment') return appointment?.event_type_label ?? null;
    return walkInServiceLabel(inferredServiceType);
  }, [mode, appointment, inferredServiceType]);

  const jbRequired = useMemo(() => {
    // Once items are staged, the catalogue rows are the source of
    // truth: any item flagged allocate_job_box requires a JB. The
    // legacy event-label heuristic only kicks in pre-staging so the
    // intake form doesn't briefly hide the JB field on a fresh load
    // of an impression appointment with no items yet.
    if (stagedItems.length > 0) return stagedItems.some((it) => it.catalogue.allocate_job_box);
    return appointmentRequiresJbRef(eventTypeLabel);
  }, [stagedItems, eventTypeLabel]);

  const { sections: waiverSections } = useWaiverSections();
  const { byCatalogueId: explicitWaiverByCatalogueId } = useAllCatalogueWaiverRequirements();
  const { latest: patientSignatures, refresh: refreshSignatures } =
    usePatientWaiverState(patient?.id);
  const requiredWaiverSections = useMemo<WaiverSection[]>(() => {
    if (waiverSections.length === 0) return [];
    // Per-cart resolution: explicit per-item waiver links (when set)
    // win over service_type inference; items without explicit links
    // fall back to the inference rule. Calendly-inferred type still
    // counts as a "phantom" item so the consent step doesn't lose
    // the appointment-level signal before any catalogue row is added.
    const cartItems: Array<{ catalogue_id: string | null; service_type: string | null }> =
      stagedItems.map((it) => ({
        catalogue_id: it.catalogue.id,
        service_type: it.catalogue.service_type,
      }));
    const calendlyInferred = inferServiceTypeFromEventLabel(eventTypeLabel);
    if (calendlyInferred) {
      cartItems.push({ catalogue_id: null, service_type: calendlyInferred });
    }
    return requiredSectionsForCart(cartItems, waiverSections, explicitWaiverByCatalogueId);
  }, [waiverSections, explicitWaiverByCatalogueId, eventTypeLabel, stagedItems]);
  const waiverFlag: WaiverFlag | null = patient
    ? summariseWaiverFlag(requiredWaiverSections, patientSignatures)
    : null;
  const sectionsToSign = useMemo<WaiverSection[]>(() => {
    if (!waiverFlag) return [];
    return [...waiverFlag.missingSections, ...waiverFlag.staleSections];
  }, [waiverFlag]);
  const consentReady = sectionsToSign.length === 0 || waiverFlag?.status === 'ready';

  // Load context. Booked → lng_appointments. Walk-in → patients.
  useEffect(() => {
    if (!id) return;
    // Don't reset loading=true here on a refresh tick — that flicks
    // the wizard back to a skeleton mid-flow when an upstream realtime
    // change re-fires the effect. The id is stable per route mount,
    // so the initial useState(true) handles the first paint and any
    // subsequent run keeps the previously-loaded context visible.
    let cancelled = false;
    setLoadError(null);
    (async () => {
      try {
        if (mode === 'appointment') {
          const { data: appt, error: apptErr } = await supabase
            .from('lng_appointments')
            .select(
              'id, patient_id, location_id, event_type_label, start_at, deposit_pence, deposit_status, deposit_provider'
            )
            .eq('id', id)
            .maybeSingle();
          if (apptErr || !appt) throw new Error(apptErr?.message ?? 'Appointment not found');
          if (cancelled) return;
          const a = appt as AppointmentContext;
          setAppointment(a);
          const { data: p } = await supabase
            .from('patients')
            .select('id, first_name, last_name, location_id, shopify_customer_id')
            .eq('id', a.patient_id)
            .maybeSingle();
          if (cancelled) return;
          setPatient((p as PatientLite | null) ?? null);
          const snap = await readIntakeSnapshot(a.patient_id);
          if (cancelled) return;
          setSnapshot(snap);
          hydrateForm(snap, setForm);
        } else {
          const { data: p, error: pe } = await supabase
            .from('patients')
            .select('id, first_name, last_name, location_id, shopify_customer_id')
            .eq('id', id)
            .maybeSingle();
          if (pe || !p) throw new Error(pe?.message ?? 'Patient not found');
          if (cancelled) return;
          setPatient(p as PatientLite);
          const snap = await readIntakeSnapshot(id);
          if (cancelled) return;
          setSnapshot(snap);
          hydrateForm(snap, setForm);
        }
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : 'Could not load arrival');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, mode]);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;
  if (!id) return <Navigate to="/schedule" replace />;

  const updateField = (key: keyof FormState, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const onExit = () => {
    navigate(mode === 'appointment' ? '/schedule' : '/walk-in/new');
  };

  // Cancel-confirmation dialog. The flow doesn't commit anything
  // to the database until the final Start step (markAppointment-
  // Arrived / createWalkInVisit), so cancelling at any earlier
  // step just throws away the in-memory drafts. Waiver
  // signatures collected on step 3 do persist (they're stored
  // against the patient regardless of arrival), and there's no
  // legitimate reason to "undo" a real signature — the dialog
  // copy is honest about what gets discarded vs kept.
  const [cancelOpen, setCancelOpen] = useState(false);
  const onCancelConfirm = () => {
    setStagedItems([]);
    setForm(EMPTY_FORM);
    setEditingFields(new Set());
    setItemsConfirmed(false);
    setNotes('');
    setJbRef('');
    setJbCheck(null);
    setJbError(null);
    setCancelOpen(false);
    onExit();
  };

  const goBack = () => {
    const idx = STEPS.findIndex((s) => s.id === step);
    if (idx > 0) setStep(STEPS[idx - 1]!.id);
    else onExit();
  };

  // Step gating ───────────────────────────────────────────────────────
  const serviceReady = (() => {
    if (stagedItems.length === 0) return false;
    if (jbRequired) {
      if (!jbRef.trim()) return false;
      if (!jbCheck || !jbCheck.available) return false;
    }
    return true;
  })();

  const customerMissing = useMemo(() => {
    if (!snapshot) return [] as string[];
    const list: string[] = [];
    const need = (label: string, current: string | null, value: string) => {
      if ((current === null || current === '') && value.trim() === '') list.push(label);
    };
    need('First name', snapshot.first_name, form.first_name);
    need('Last name', snapshot.last_name, form.last_name);
    need('Date of birth', snapshot.date_of_birth, form.date_of_birth);
    need('Sex', snapshot.sex, form.sex);
    need('Email', snapshot.email, form.email);
    need('Phone', snapshot.phone, form.phone);
    need('Address line 1', snapshot.portal_ship_line1, form.portal_ship_line1);
    need('City', snapshot.portal_ship_city, form.portal_ship_city);
    need('Postcode', snapshot.portal_ship_postcode, form.portal_ship_postcode);
    if (form.allergies.trim() === '' && (snapshot.allergies ?? '') === '') {
      list.push('Allergies & sensitivities');
    }
    need('Emergency contact name', snapshot.emergency_contact_name, form.emergency_contact_name);
    need('Emergency contact phone', snapshot.emergency_contact_phone, form.emergency_contact_phone);
    // "How did you hear about us?" — required only when not already
    // on file. The ReferralSourceSection itself only renders when
    // snapshot.referred_by is empty, so the same condition gates
    // whether the answer is required to advance.
    if ((snapshot.referred_by ?? '') === '' && form.referred_by.trim() === '') {
      list.push('How did you hear about us?');
    }
    return list;
  }, [snapshot, form]);

  const customerReady = customerMissing.length === 0 && itemsConfirmed;

  const onContinue = () => {
    if (step === 'service' && serviceReady) setStep('customer');
    else if (step === 'customer' && customerReady) setStep('consent');
    else if (step === 'consent' && consentReady) setStep('start');
  };

  const runJbCheck = async (raw: string) => {
    if (!raw) return;
    setJbChecking(true);
    setJbError(null);
    try {
      const res = await checkJbAvailability(raw);
      setJbCheck(res);
    } catch (e) {
      setJbError(e instanceof Error ? e.message : 'Could not check JB');
    } finally {
      setJbChecking(false);
    }
  };

  // Debounced auto-check. Fires 400ms after the receptionist stops
  // typing in the JB input, mirroring Meridian's checkpoint-lookup
  // pattern. No manual "Check availability" button — the indicator
  // next to the input is the affordance.
  const jbDebounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!jbRequired) return;
    const trimmed = jbRef.trim();
    if (!trimmed) return;
    // Skip if we already have a fresh result for this exact value.
    if (jbCheck && jbCheck.digits === trimmed) return;

    if (jbDebounceRef.current) window.clearTimeout(jbDebounceRef.current);
    jbDebounceRef.current = window.setTimeout(() => {
      void runJbCheck(trimmed);
    }, 400);
    return () => {
      if (jbDebounceRef.current) window.clearTimeout(jbDebounceRef.current);
    };
  }, [jbRef, jbRequired, jbCheck]);

  const stagedTotalPence = useMemo(
    () => stagedItems.reduce((sum, it) => sum + stagedLineTotalPence(it), 0),
    [stagedItems]
  );

  // Only PAID deposits credit the till. A failed deposit is shown
  // visually elsewhere; the bill still sums to the full subtotal.
  // Walk-ins and unpaid bookings → 0.
  const depositPence =
    appointment?.deposit_status === 'paid' ? appointment.deposit_pence ?? 0 : 0;
  const depositProvider =
    depositPence > 0 ? appointment?.deposit_provider ?? null : null;

  const handleStartAppointment = async () => {
    if (!patient) return;
    if (mode === 'appointment' && !appointment) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      // Filter the editingFields set down to keys that exist on the
      // patient input shape (drop jb_ref etc which aren't patient
      // columns). The cast is safe because FormState's patient-row
      // keys overlap exactly with ArrivalIntakePatientInput.
      const editedKeys = new Set(
        Array.from(editingFields).filter((k) =>
          [
            'first_name',
            'last_name',
            'date_of_birth',
            'sex',
            'email',
            'phone',
            'portal_ship_line1',
            'portal_ship_line2',
            'portal_ship_city',
            'portal_ship_postcode',
            'portal_ship_country_code',
            'allergies',
            'emergency_contact_name',
            'emergency_contact_phone',
          ].includes(k as string)
        )
      ) as Set<keyof typeof form & string> as unknown as Set<
        Parameters<typeof submitArrivalIntake>[0]['editedKeys'] extends Set<infer K> ? K : never
      >;

      const intakeResult = await submitArrivalIntake({
        appointmentId: mode === 'appointment' ? appointment!.id : undefined,
        patientId: patient.id,
        patient: {
          first_name: form.first_name,
          last_name: form.last_name,
          date_of_birth: form.date_of_birth,
          sex: form.sex,
          email: form.email,
          phone: form.phone,
          portal_ship_line1: form.portal_ship_line1,
          portal_ship_line2: form.portal_ship_line2,
          portal_ship_city: form.portal_ship_city,
          portal_ship_postcode: form.portal_ship_postcode,
          portal_ship_country_code: form.portal_ship_country_code,
          allergies: form.allergies,
          emergency_contact_name: form.emergency_contact_name,
          emergency_contact_phone: form.emergency_contact_phone,
          referred_by: form.referred_by,
        },
        jbRef: jbRequired ? jbRef.trim() || null : null,
        editedKeys,
      });

      let visitId: string;
      let visitOpenedAt: string;
      if (mode === 'appointment') {
        const r = await markAppointmentArrived(appointment!.id);
        visitId = r.visit_id;
        visitOpenedAt = r.opened_at;
      } else {
        const r = await createWalkInVisit({
          patient_id: patient.id,
          location_id: patient.location_id ?? '',
          service_type: inferredServiceType ?? 'other',
          appointment_ref: intakeResult.appointment_ref,
          jb_ref: jbRequired ? jbRef.trim() || null : null,
          notes: notes.trim() || undefined,
        });
        visitId = r.visit_id;
        visitOpenedAt = r.opened_at;
      }

      if (stagedItems.length > 0) {
        const { data: cart, error: cartErr } = await supabase
          .from('lng_carts')
          .insert({ visit_id: visitId })
          .select('*')
          .single();
        if (cartErr || !cart) throw new Error(cartErr?.message ?? 'Could not open cart');
        const cartRow = cart as CartRow;
        for (const item of stagedItems) {
          await addCatalogueItemsToCart(cartRow.id, item.catalogue, item.qty, item.options);
        }
      }

      // Pass the visit's opened_at and the patient's name through
      // router state so VisitDetail's breadcrumb renders the full
      // "Schedule › Ewa Deb › Appointment, 29 Apr, 17:41" trail on
      // first paint, with no shimmer transition for either crumb.
      // 'from' maps to the user's *origin* before arrival: appointment
      // arrivals came from /schedule, walk-ins came from /in-clinic.
      navigate(`/visit/${visitId}`, {
        state: {
          from: mode === 'appointment' ? 'schedule' : 'in_clinic',
          patientName: patientFullName({
            first_name: form.first_name,
            last_name: form.last_name,
          }),
          visitOpenedAt,
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start appointment');
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  // Render shell ───────────────────────────────────────────────────────
  const currentStepIndex = STEPS.findIndex((s) => s.id === step);
  // Witness default for any waiver signed during arrival. Pulls from
  // the staff member's accounts row (first_name + last_name) so the
  // name on every signature is the real human's, not the auth email.
  // Falls back to email if the accounts row hasn't loaded yet.
  const staffName = currentAccount?.display_name ?? user.email ?? 'Staff';

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        // Reserve space below the always-visible KioskStatusBar so the
        // stepper isn't clipped under it. Bottom space mirrors the
        // sticky action bar height + iOS safe area.
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + env(safe-area-inset-top, 0px))`,
        paddingBottom: 'calc(96px + env(safe-area-inset-bottom, 0px))',
        position: 'relative',
      }}
    >
      {/* Sticky chrome row: stepper + (when on staff steps) the staff-only
          announcement, both glued together so they stay pinned under the
          KioskStatusBar as the receptionist scrolls. */}
      <div
        style={{
          position: 'sticky',
          top: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + env(safe-area-inset-top, 0px))`,
          zIndex: 20,
        }}
      >
        <StepperBar
          steps={STEPS}
          currentIndex={currentStepIndex}
          onCancel={() => setCancelOpen(true)}
        />

        {patient && (step === 'service' || step === 'start') ? (
          <StaffOnlyBanner
            subtitle={
              step === 'service'
                ? `Set up ${patient.first_name}'s appointment, then hand the device over.`
                : 'Final check. Tap Start appointment to open the till for this patient.'
            }
          />
        ) : null}
      </div>

      <div
        // Re-keying on step makes React remount the children, which
        // both restarts the fade-in keyframe and resets focus to the
        // top of the new step (browsers default focus to body on
        // remount). The end result is a calm "next page" feel without
        // a router transition.
        key={step}
        style={{
          maxWidth: theme.layout.pageMaxWidth,
          margin: '0 auto',
          padding: isMobile
            ? `${theme.space[6]}px ${theme.space[4]}px ${theme.space[6]}px`
            : `${theme.space[8]}px ${theme.space[6]}px ${theme.space[8]}px`,
          animation: `lng-arrival-fade ${theme.motion.duration.base}ms ${theme.motion.easing.spring} both`,
        }}
      >
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
            <Skeleton height={56} radius={14} />
            <Skeleton height={240} radius={18} />
            <Skeleton height={120} radius={18} />
          </div>
        ) : loadError || !patient ? (
          <Card padding="lg">
            <p style={{ margin: 0, color: theme.color.alert }}>{loadError ?? 'Could not load arrival.'}</p>
          </Card>
        ) : step === 'service' ? (
          <ServiceStep
            mode={mode}
            recognisedTypes={recognisedTypes}
            stagedItems={stagedItems}
            stagedTotalPence={stagedTotalPence}
            depositPence={depositPence}
            depositProvider={depositProvider}
            onIncrement={(key) =>
              setStagedItems((s) =>
                s.map((it) => (it.key === key ? { ...it, qty: it.qty + 1 } : it))
              )
            }
            onDecrement={(key) =>
              setStagedItems((s) =>
                s
                  .map((it) => (it.key === key ? { ...it, qty: Math.max(0, it.qty - 1) } : it))
                  .filter((it) => it.qty > 0)
              )
            }
            onRemoveItem={(key) => setStagedItems((s) => s.filter((it) => it.key !== key))}
            onOpenPicker={() => setPickerOpen(true)}
            jbRequired={jbRequired}
            jbRef={jbRef}
            onChangeJbRef={(v) => {
              setJbRef(v);
              setJbCheck(null);
              setJbError(null);
            }}
            jbCheck={jbCheck}
            jbChecking={jbChecking}
            jbError={jbError}
            notes={notes}
            onChangeNotes={setNotes}
          />
        ) : step === 'customer' ? (
          <CustomerStep
            patient={patient}
            snapshot={snapshot!}
            form={form}
            onUpdate={updateField}
            stagedItems={stagedItems}
            itemsConfirmed={itemsConfirmed}
            onConfirmItems={setItemsConfirmed}
            missing={customerMissing}
            isMobile={isMobile}
            editingFields={editingFields}
            onBeginEdit={beginEditField}
            linkedToShopify={!!patient.shopify_customer_id}
            depositPence={depositPence}
            depositProvider={depositProvider}
          />
        ) : step === 'consent' ? (
          <ConsentStep
            patient={patient}
            sectionsToSign={sectionsToSign}
            staffName={staffName}
            waiverRef={waiverRef}
            onReadyChange={setWaiverReady}
            onBusyChange={setWaiverBusy}
            onAllSigned={() => {
              refreshSignatures();
              setStep('start');
            }}
          />
        ) : (
          <StartStep
            patient={patient}
            stagedItems={stagedItems}
            stagedTotalPence={stagedTotalPence}
            depositPence={depositPence}
            depositProvider={depositProvider}
            jbRef={jbRequired ? jbRef.trim() : null}
            consentSigned={consentReady}
          />
        )}
      </div>

      <ActionBar
        step={step}
        backLabel={currentStepIndex === 0 ? 'Exit' : 'Back'}
        onBack={goBack}
        primaryLabel={
          step === 'start'
            ? submitting
              ? 'Starting…'
              : 'Start appointment'
            : step === 'consent'
              ? sectionsToSign.length === 0
                ? 'Next'
                : waiverBusy
                  ? 'Saving…'
                  : 'Sign and continue'
              : 'Next'
        }
        primaryDisabled={
          step === 'service'
            ? !serviceReady
            : step === 'customer'
              ? !customerReady
              : step === 'consent'
                ? sectionsToSign.length === 0
                  ? !consentReady
                  : !waiverReady || waiverBusy
                : submitting
        }
        primaryLoading={(submitting && step === 'start') || (step === 'consent' && waiverBusy)}
        primaryShowArrow={step === 'consent' ? sectionsToSign.length === 0 : step !== 'start' || !submitting}
        statusMessage={statusFor(
          step,
          {
            service: serviceReady,
            customer: customerReady,
            consent: consentReady,
          },
          customerMissing.length,
          stagedItems.length,
          sectionsToSign.length
        )}
        onPrimary={
          step === 'start'
            ? handleStartAppointment
            : step === 'consent' && sectionsToSign.length > 0
              ? () => {
                  void waiverRef.current?.submit();
                }
              : onContinue
        }
      />

      <CataloguePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        intake={null}
        eventTypeLabel={eventTypeLabel}
        onStage={(cat, qty, opts) =>
          setStagedItems((s) => [
            ...s,
            { key: `${cat.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, catalogue: cat, qty, options: opts },
          ])
        }
        onItemAdded={() => {}}
      />

      {error ? (
        <div style={{ position: 'fixed', bottom: 120, left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone="error" title="Could not start appointment" description={error} duration={6000} onDismiss={() => setError(null)} />
        </div>
      ) : null}

      <Dialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Discard arrival progress?"
        width={420}
        dismissable
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[3] }}>
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              Keep going
            </Button>
            <Button variant="primary" onClick={onCancelConfirm}>
              Discard and exit
            </Button>
          </div>
        }
      >
        <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm, lineHeight: theme.type.leading.snug }}>
          The cart, customer details and notes you've added so far will be cleared. Any waiver signatures the patient has already saved are kept against their record — those don't depend on this arrival.
        </p>
      </Dialog>

      <style>{`
        @keyframes lng-arrival-fade {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes lng-arrival-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </main>
  );
}

function statusFor(
  step: Step,
  ready: { service: boolean; customer: boolean; consent: boolean },
  customerMissingCount: number,
  stagedCount: number,
  // Number of waiver sections still needing a fresh signature on
  // step 3. Drives the audience-specific Next-button hint on step
  // 2 (review the waiver vs pass back to staff).
  sectionsToSignCount: number
): string {
  if (step === 'service') {
    if (stagedCount === 0) return 'Add at least one item';
    if (!ready.service) return 'Complete all required fields';
    // Step 1 is staff-only; once the cart and JB are filled the
    // device hands off to the patient for steps 2 and 3.
    return 'Pass to the patient for steps 2 and 3';
  }
  if (step === 'customer') {
    if (customerMissingCount > 0) return `${customerMissingCount} required ${customerMissingCount === 1 ? 'field' : 'fields'} remaining`;
    if (!ready.customer) return 'Confirm the items above';
    // Patient is on the device. The Next-button hint tells them
    // what to expect on step 3: a waiver to read and sign, or
    // nothing for them to do — in which case staff takes over.
    return sectionsToSignCount > 0
      ? 'Tap Next to review and sign the waiver'
      : 'Tap Next, then pass back to staff';
  }
  if (step === 'consent') {
    if (!ready.consent) return 'Sign each section to continue';
    // Waiver done (or none was needed) — patient hands the device
    // back so staff can confirm and start the appointment.
    return 'Pass back to staff to start';
  }
  return '';
}

function hydrateForm(snap: ArrivalIntakeSnapshot, setForm: (f: FormState) => void): void {
  setForm({
    first_name: snap.first_name ?? '',
    last_name: snap.last_name ?? '',
    date_of_birth: snap.date_of_birth ?? '',
    sex: snap.sex ?? '',
    email: snap.email ?? '',
    phone: snap.phone ?? '',
    portal_ship_line1: snap.portal_ship_line1 ?? '',
    portal_ship_line2: snap.portal_ship_line2 ?? '',
    portal_ship_city: snap.portal_ship_city ?? '',
    portal_ship_postcode: snap.portal_ship_postcode ?? '',
    portal_ship_country_code: snap.portal_ship_country_code ?? 'GB',
    allergies: snap.allergies ?? '',
    emergency_contact_name: snap.emergency_contact_name ?? '',
    emergency_contact_phone: snap.emergency_contact_phone ?? '',
    referred_by: snap.referred_by ?? '',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stepper bar — sticky top. Pill numbers connected by lines, checkmarks
// for completed, labels below. Exit lives on the bottom action bar so
// receptionists can't accidentally trigger it from the chrome row.
// ─────────────────────────────────────────────────────────────────────────────

function StepperBar({
  steps,
  currentIndex,
  onCancel,
}: {
  steps: { id: Step; label: string }[];
  currentIndex: number;
  // Click handler for the Cancel affordance on the right of the
  // bar. Parent owns the confirmation dialog so this is a thin
  // pass-through.
  onCancel: () => void;
}) {
  return (
    <header
      style={{
        // Sticky positioning lives on the parent chrome wrapper in
        // Arrival's main return, so this element sits in normal flow
        // and just paints the row.
        background: theme.color.surface,
        borderBottom: `1px solid ${theme.color.border}`,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
      }}
    >
      {/* Spacer mirrors the Cancel button on the right so the
          centred step list stays optically centred. */}
      <span aria-hidden style={{ width: 64 }} />
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
        <ol
          aria-label="Arrival progress"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[1],
          }}
        >
          {steps.map((s, i) => {
            const past = i < currentIndex;
            const current = i === currentIndex;
            return (
              <li key={s.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
                <span
                  aria-current={current ? 'step' : undefined}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: theme.space[2],
                    paddingRight: theme.space[2],
                  }}
                >
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 28,
                      height: 28,
                      borderRadius: theme.radius.pill,
                      background: past
                        ? theme.color.accent
                        : current
                          ? theme.color.ink
                          : theme.color.surface,
                      color: past || current ? theme.color.surface : theme.color.inkSubtle,
                      border: past || current ? 'none' : `1px solid ${theme.color.border}`,
                      fontSize: theme.type.size.sm,
                      fontWeight: theme.type.weight.semibold,
                    }}
                  >
                    {past ? <CheckCircle2 size={16} strokeWidth={2.4} /> : i + 1}
                  </span>
                  <span
                    style={{
                      fontSize: theme.type.size.sm,
                      fontWeight: current ? theme.type.weight.semibold : theme.type.weight.medium,
                      color: current ? theme.color.ink : past ? theme.color.inkMuted : theme.color.inkSubtle,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {s.label}
                  </span>
                </span>
                {i < steps.length - 1 ? (
                  <span
                    aria-hidden
                    style={{
                      display: 'inline-block',
                      width: 24,
                      height: 1,
                      background: theme.color.border,
                      margin: `0 ${theme.space[1]}px`,
                    }}
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
      {/* Cancel sits on the right edge so it's reachable on every
          step. Tertiary chrome keeps it from competing with the
          Next / primary actions in the bottom action bar; the
          parent gates the actual abandon behind a confirm dialog. */}
      <Button variant="tertiary" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Action bar — fixed bottom. Back left, status text + primary right.
// Height matches BottomNav so the surface keeps its rhythm even though
// BottomNav is hidden on this route.
// ─────────────────────────────────────────────────────────────────────────────

function ActionBar({
  step: _step,
  backLabel,
  onBack,
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  primaryLoading = false,
  primaryShowArrow = false,
  statusMessage,
}: {
  step: Step;
  backLabel: string;
  onBack: () => void;
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  primaryShowArrow?: boolean;
  statusMessage?: string;
}) {
  // Hide the bar while the iPad soft keyboard is up. Without this
  // the visual-viewport-anchored fixed bottom would float above
  // the keyboard and obscure the input the patient is typing in.
  // Same signal used by BottomNav.
  const keyboardOpen = useKeyboardOpen();
  if (keyboardOpen) return null;

  return (
    <footer
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 20,
        height: 96,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        background: theme.color.surface,
        borderTop: `1px solid ${theme.color.border}`,
        display: 'flex',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          flex: 1,
          maxWidth: theme.layout.pageMaxWidth,
          margin: '0 auto',
          padding: `0 ${theme.space[5]}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[4],
          height: '100%',
        }}
      >
        <Button variant="tertiary" onClick={onBack}>
          {backLabel}
        </Button>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4] }}>
          {statusMessage ? (
            <span
              aria-live="polite"
              style={{
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                fontWeight: theme.type.weight.medium,
              }}
            >
              {statusMessage}
            </span>
          ) : null}
          <Button
            variant="primary"
            onClick={onPrimary}
            disabled={primaryDisabled}
            loading={primaryLoading}
            showArrow={primaryShowArrow && !primaryLoading}
          >
            {primaryLabel}
          </Button>
        </div>
      </div>
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — Service (staff)
// ─────────────────────────────────────────────────────────────────────────────

function ServiceStep({
  mode,
  recognisedTypes,
  stagedItems,
  stagedTotalPence,
  depositPence,
  depositProvider,
  onIncrement,
  onDecrement,
  onRemoveItem,
  onOpenPicker,
  jbRequired,
  jbRef,
  onChangeJbRef,
  jbCheck,
  jbChecking,
  jbError,
  notes,
  onChangeNotes,
}: {
  mode: Mode;
  recognisedTypes: string[];
  stagedItems: StagedItem[];
  stagedTotalPence: number;
  depositPence: number;
  depositProvider: 'paypal' | 'stripe' | null;
  onIncrement: (key: string) => void;
  onDecrement: (key: string) => void;
  onRemoveItem: (key: string) => void;
  onOpenPicker: () => void;
  jbRequired: boolean;
  jbRef: string;
  onChangeJbRef: (v: string) => void;
  jbCheck: JbAvailabilityResult | null;
  jbChecking: boolean;
  jbError: string | null;
  notes: string;
  onChangeNotes: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[6] }}>
      <h1
        style={{
          margin: 0,
          fontSize: theme.type.size.xxl,
          fontWeight: theme.type.weight.semibold,
          letterSpacing: theme.type.tracking.tight,
          color: theme.color.ink,
          lineHeight: 1.1,
        }}
      >
        Service details
      </h1>

      {/* The Calendly booking type used to render here as a "Booking"
          section, auto-populated from appointment.event_type_label.
          Per design: don't auto-add it to the arrival form — the
          receptionist chooses what's actually being worked on via
          the picker below. The label still drives JB-ref + waiver
          inference behind the scenes (eventTypeLabel above), but
          isn't surfaced as a form field. */}
      <Section
        title="Items"
        sub={stagedItems.length === 0 ? 'What are we doing today?' : undefined}
        action={
          stagedItems.length > 0 ? (
            <button type="button" onClick={onOpenPicker} style={subtleLinkStyle}>
              <Plus size={14} /> Add another
            </button>
          ) : null
        }
      >
        {stagedItems.length === 0 ? (
          // List-cell CTA. Earlier this was a full-width dashed-
          // border block which read as a drop-zone, not a button —
          // staff weren't sure they could tap it. Now it has a
          // solid hairline, a left avatar, a chevron on the right,
          // and a max-width so it sits as a discrete "tap me" card
          // rather than a row-spanning placeholder. Pattern matches
          // the navigable list rows used elsewhere in the app.
          <button type="button" onClick={onOpenPicker} style={emptyItemsStyle}>
            <span
              aria-hidden
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 44,
                height: 44,
                borderRadius: theme.radius.pill,
                background: theme.color.accentBg,
                color: theme.color.accent,
                flexShrink: 0,
              }}
            >
              <Package size={20} />
            </span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: theme.space[1],
                textAlign: 'left',
              }}
            >
              <span
                style={{
                  fontSize: theme.type.size.base,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.ink,
                }}
              >
                Choose products or services
              </span>
              <span
                style={{
                  fontSize: theme.type.size.sm,
                  color: theme.color.inkMuted,
                  lineHeight: theme.type.leading.snug,
                }}
              >
                Pick from the catalogue. The patient sees the list before they sign.
              </span>
            </span>
            <ChevronRight
              size={18}
              color={theme.color.inkSubtle}
              aria-hidden
              style={{ flexShrink: 0 }}
            />
          </button>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            {stagedItems.map((it) => (
              <ItemRow
                key={it.key}
                item={it}
                onIncrement={() => onIncrement(it.key)}
                onDecrement={() => onDecrement(it.key)}
                onRemove={() => onRemoveItem(it.key)}
              />
            ))}
          </ul>
        )}
        {mode === 'walk_in' && recognisedTypes.length > 0 ? (
          <div
            style={{
              marginTop: theme.space[3],
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: theme.space[2],
            }}
          >
            <span
              style={{
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
                fontWeight: theme.type.weight.medium,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
              }}
            >
              Recognised as
            </span>
            {recognisedTypes.map((t) => (
              <span key={t} style={recognisedChipStyle}>
                {SERVICE_TYPE_LABELS[t] ?? t}
              </span>
            ))}
          </div>
        ) : null}
        {stagedItems.length > 0 ? (
          <TotalsBlock
            subtotalPence={stagedTotalPence}
            depositPence={depositPence}
            depositProvider={depositProvider}
          />
        ) : null}
      </Section>

      {jbRequired ? (
        <Section
          title="Job box"
          required
          sub="The number on the box where the impression sits. If the patient hasn't given you the impression yet, still grab a fresh job box now and put its number here. This is the only point we can pin a JB to this appointment. We check Checkpoint as you type."
        >
          <JbBoxInput
            value={jbRef}
            onChange={onChangeJbRef}
            checking={jbChecking}
            check={jbCheck}
            error={jbError}
          />
        </Section>
      ) : null}

      <Section title="Notes" sub="Special requirements and technician notes. These will be added to the Lab Work Order (LWO). Staff only.">
        <textarea
          value={notes}
          onChange={(e) => onChangeNotes(e.currentTarget.value)}
          rows={3}
          // The note prints in the LWO's small Notes box on a 4.13in
          // label. Capping at MAX_TECH_NOTE_LENGTH stops staff
          // accidentally writing more than the label can show — the
          // edit-in-place dialog on VisitDetail enforces the same
          // ceiling so an arrival note can't grow past it later.
          maxLength={MAX_TECH_NOTE_LENGTH}
          placeholder="Anything the lab or clinician should know"
          style={textareaStyle}
        />
        <div
          aria-live="polite"
          style={{
            marginTop: theme.space[1],
            display: 'flex',
            justifyContent: 'flex-end',
            fontSize: theme.type.size.xs,
            fontVariantNumeric: 'tabular-nums',
            color:
              notes.length >= MAX_TECH_NOTE_LENGTH
                ? theme.color.alert
                : notes.length >= MAX_TECH_NOTE_LENGTH * 0.9
                  ? theme.color.warn
                  : theme.color.inkMuted,
            fontWeight:
              notes.length >= MAX_TECH_NOTE_LENGTH * 0.9
                ? theme.type.weight.semibold
                : theme.type.weight.regular,
          }}
        >
          {notes.length} / {MAX_TECH_NOTE_LENGTH}
        </div>
      </Section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Totals — staged subtotal, deposit deduction (when one was paid),
// and the resulting balance to collect at the till. Shared between
// the service-step cart preview and the customer-step confirmation
// banner so the same numbers carry through every surface from
// arrival -> visit page -> Pay screen. Walk-ins and unpaid bookings
// pass depositPence=0 and the deposit row collapses.
// ─────────────────────────────────────────────────────────────────────────────

function depositLabel(provider: 'paypal' | 'stripe' | null): string {
  if (provider === 'stripe') return 'Deposit (Stripe via Calendly)';
  if (provider === 'paypal') return 'Deposit (PayPal via Calendly)';
  return 'Deposit';
}

function TotalsBlock({
  subtotalPence,
  depositPence,
  depositProvider,
}: {
  subtotalPence: number;
  depositPence: number;
  depositProvider: 'paypal' | 'stripe' | null;
}) {
  const balancePence = Math.max(0, subtotalPence - depositPence);
  const showBreakdown = depositPence > 0;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
        marginTop: theme.space[4],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        background: theme.color.bg,
        borderRadius: theme.radius.input,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <TotalsRow label="Subtotal" valuePence={subtotalPence} />
      {showBreakdown ? (
        <TotalsRow label={depositLabel(depositProvider)} valuePence={-depositPence} accent />
      ) : null}
      <TotalsRow
        label={showBreakdown ? 'To collect' : 'Total'}
        valuePence={balancePence}
        emphasis
      />
    </div>
  );
}

// Same numbers, different chrome. The customer-step banner already
// has card padding around it, so the totals here render as a flat
// list with a hairline above (mirrors the previous single-row
// "Total" treatment).
function ConfirmationTotals({
  subtotalPence,
  depositPence,
  depositProvider,
}: {
  subtotalPence: number;
  depositPence: number;
  depositProvider: 'paypal' | 'stripe' | null;
}) {
  const balancePence = Math.max(0, subtotalPence - depositPence);
  const showBreakdown = depositPence > 0;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
        paddingTop: theme.space[2],
        borderTop: `1px solid ${theme.color.border}`,
      }}
    >
      <TotalsRow label="Subtotal" valuePence={subtotalPence} />
      {showBreakdown ? (
        <TotalsRow label={depositLabel(depositProvider)} valuePence={-depositPence} accent />
      ) : null}
      <TotalsRow
        label={showBreakdown ? 'To collect' : 'Total'}
        valuePence={balancePence}
        emphasis
      />
    </div>
  );
}

function TotalsRow({
  label,
  valuePence,
  emphasis = false,
  accent = false,
}: {
  label: string;
  valuePence: number;
  emphasis?: boolean;
  accent?: boolean;
}) {
  const sign = valuePence < 0 ? '-' : '';
  const magnitude = Math.abs(valuePence);
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span
        style={{
          fontSize: emphasis ? theme.type.size.base : theme.type.size.sm,
          color: emphasis ? theme.color.ink : theme.color.inkMuted,
          fontWeight: emphasis ? theme.type.weight.semibold : theme.type.weight.regular,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: emphasis ? theme.type.size.lg : theme.type.size.base,
          fontWeight: emphasis ? theme.type.weight.semibold : theme.type.weight.regular,
          color: accent ? theme.color.accent : theme.color.ink,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {sign}{formatPence(magnitude)}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section — proper h2 heading + optional sub + optional right-aligned
// action. Replaces the all-caps eyebrow label pattern that read as
// institutional and hid the hierarchy.
// ─────────────────────────────────────────────────────────────────────────────

function Section({
  title,
  sub,
  action,
  required = false,
  children,
}: {
  title: string;
  sub?: string;
  action?: React.ReactNode;
  // Renders a small red asterisk after the title — same affordance
  // as the Your details fields use, so a section that gates progress
  // (Job box) reads as required at a glance.
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: theme.space[3],
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
          <h2
            style={{
              margin: 0,
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
              color: theme.color.ink,
            }}
          >
            {title}
            {required ? <RequiredMark /> : null}
          </h2>
          {sub ? (
            <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              {sub}
            </p>
          ) : null}
        </div>
        {action ? <div>{action}</div> : null}
      </header>
      <div>{children}</div>
    </section>
  );
}

// JB box input with inline async status. Auto-checks 400ms after the
// last keystroke (debounced in the parent), so the receptionist never
// has to tap a "Check" button. The right side shows a spinner while
// checking, a green tick when free, an alert tone when taken — the
// Meridian checkpoint-lookup pattern, condensed.
function JbBoxInput({
  value,
  onChange,
  checking,
  check,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  checking: boolean;
  check: JbAvailabilityResult | null;
  error: string | null;
}) {
  const trimmed = value.trim();
  const showStatus = trimmed.length > 0 || checking;
  const taken = check && !check.available;
  const free = check && check.available && check.digits === trimmed;

  const fieldStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    height: theme.layout.inputHeight,
    background: theme.color.surface,
    borderRadius: theme.radius.input,
    paddingLeft: theme.space[5],
    paddingRight: theme.space[3],
    boxShadow: error || taken
      ? `inset 0 0 0 1px ${theme.color.alert}`
      : free
        ? `inset 0 0 0 1px ${theme.color.accent}`
        : `inset 0 0 0 1px ${theme.color.border}`,
    transition: `box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
    gap: theme.space[3],
    maxWidth: 280,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      <div style={fieldStyle}>
        <span
          aria-hidden
          style={{
            fontSize: theme.type.size.base,
            color: theme.color.inkMuted,
            fontVariantNumeric: 'tabular-nums',
            fontWeight: theme.type.weight.medium,
          }}
        >
          JB
        </span>
        <input
          type="text"
          value={value}
          onChange={(e) => {
            // Canonicalise to digits-only with no leading zeros. The
            // Checkpoint side compares JB refs as decimals, so "09"
            // and "9" are the same job box — we strip the zero on the
            // way in so the lookup hits and so the field can never
            // hold letters or whitespace.
            const digits = e.currentTarget.value.replace(/\D/g, '');
            const canonical = digits.replace(/^0+/, '');
            onChange(canonical);
          }}
          inputMode="numeric"
          autoComplete="off"
          placeholder="33"
          aria-label="Job box number"
          style={{
            flex: 1,
            border: 'none',
            background: 'transparent',
            outline: 'none',
            fontFamily: 'inherit',
            fontSize: theme.type.size.base,
            color: theme.color.ink,
            minWidth: 0,
            fontVariantNumeric: 'tabular-nums',
          }}
        />
        {showStatus ? <JbStatusIndicator checking={checking} taken={!!taken} free={!!free} /> : null}
      </div>

      {taken ? (
        <div
          role="alert"
          style={{
            padding: `${theme.space[3]}px ${theme.space[4]}px`,
            borderRadius: theme.radius.input,
            border: `1px solid ${theme.color.alert}`,
            background: 'rgba(184, 58, 42, 0.06)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: theme.space[3],
          }}
        >
          <AlertTriangle size={18} color={theme.color.alert} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: theme.color.alert }}>
              {check!.formatted} is taken
            </p>
            <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.ink }}>
              {check!.conflict?.customer_name ?? 'Another patient'}
              {check!.conflict?.order_name ? ` · ${check!.conflict.order_name}` : ''}
              . Pick a different box.
            </p>
          </div>
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.alert,
          }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function JbStatusIndicator({
  checking,
  taken,
  free,
}: {
  checking: boolean;
  taken: boolean;
  free: boolean;
}) {
  if (checking) {
    return (
      <span
        aria-label="Checking availability"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[1],
          color: theme.color.inkMuted,
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.medium,
        }}
      >
        <Loader2 size={16} style={{ animation: 'lng-arrival-spin 900ms linear infinite' }} />
        <span>Checking…</span>
      </span>
    );
  }
  if (taken) {
    return (
      <span aria-label="Taken" style={{ color: theme.color.alert, display: 'inline-flex' }}>
        <X size={20} strokeWidth={2.4} />
      </span>
    );
  }
  if (free) {
    return (
      <span
        aria-label="Available"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[1],
          color: theme.color.accent,
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
        }}
      >
        <CheckCircle2 size={18} strokeWidth={2.4} />
        <span>Free</span>
      </span>
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — Customer details (patient-facing)
// ─────────────────────────────────────────────────────────────────────────────

function CustomerStep({
  patient,
  snapshot,
  form,
  onUpdate,
  stagedItems,
  itemsConfirmed,
  onConfirmItems,
  missing: _missing,
  isMobile,
  editingFields,
  onBeginEdit,
  linkedToShopify,
  depositPence,
  depositProvider,
}: {
  patient: PatientLite;
  snapshot: ArrivalIntakeSnapshot;
  form: FormState;
  onUpdate: (key: keyof FormState, v: string) => void;
  stagedItems: StagedItem[];
  itemsConfirmed: boolean;
  onConfirmItems: (v: boolean) => void;
  missing: string[];
  isMobile: boolean;
  editingFields: Set<keyof FormState>;
  onBeginEdit: (key: keyof FormState) => void;
  linkedToShopify: boolean;
  depositPence: number;
  depositProvider: 'paypal' | 'stripe' | null;
}) {
  const isEditing = (k: keyof FormState) => editingFields.has(k);
  const stagedTotalPence = stagedItems.reduce(
    (sum, it) => sum + stagedLineTotalPence(it),
    0
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[6] }}>
      <header>
        <h1
          style={{
            margin: 0,
            fontSize: theme.type.size.xxl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
            lineHeight: 1.1,
          }}
        >
          {patient.first_name}, please confirm your visit.
        </h1>
        <p
          style={{
            margin: `${theme.space[3]}px 0 0`,
            color: theme.color.inkMuted,
            fontSize: theme.type.size.base,
            lineHeight: 1.55,
            maxWidth: 560,
          }}
        >
          Fill any missing details, confirm what's being worked on today, and we'll be ready to begin.
        </p>
      </header>

      <section>
        <FormGrid isMobile={isMobile}>
          <FieldRow required kind="name" label="First name" current={snapshot.first_name} value={form.first_name} onChange={(v) => onUpdate('first_name', v)} editing={isEditing('first_name')} onBeginEdit={() => onBeginEdit('first_name')} />
          <FieldRow required kind="name" label="Last name" current={snapshot.last_name} value={form.last_name} onChange={(v) => onUpdate('last_name', v)} editing={isEditing('last_name')} onBeginEdit={() => onBeginEdit('last_name')} />
          <DateOfBirthFieldRow
            current={snapshot.date_of_birth}
            value={form.date_of_birth}
            editing={isEditing('date_of_birth')}
            onChange={(v) => onUpdate('date_of_birth', v)}
            onBeginEdit={() => onBeginEdit('date_of_birth')}
          />
          <SexRow current={snapshot.sex} value={form.sex} onChange={(v) => onUpdate('sex', v)} editing={isEditing('sex')} onBeginEdit={() => onBeginEdit('sex')} />
          {/* Address line 1 hosts the Google Places autocomplete
              when the address cluster is being edited. Selecting a
              suggestion fills line 1 / line 2 / city / postcode in
              one shot via onSelectPlace. While the field is "on
              file" (snapshot value present and not editing),
              FieldRow renders the read-only OnFileCard pencil and
              autocomplete is dormant. */}
          <AddressLine1Row
            snapshot={snapshot.portal_ship_line1}
            value={form.portal_ship_line1}
            editing={isEditing('portal_ship_line1')}
            onChange={(v) => onUpdate('portal_ship_line1', v)}
            onSelectPlace={(parsed) => {
              onUpdate('portal_ship_line1', parsed.address1);
              onUpdate('portal_ship_line2', parsed.address2);
              onUpdate('portal_ship_city', parsed.city);
              onUpdate('portal_ship_postcode', parsed.postcode);
            }}
            onBeginEdit={() => onBeginEdit('portal_ship_line1')}
          />
          <FieldRow label="Address line 2" current={snapshot.portal_ship_line2} value={form.portal_ship_line2} onChange={(v) => onUpdate('portal_ship_line2', v)} fullSpan editing={isEditing('portal_ship_line2')} onBeginEdit={() => onBeginEdit('portal_ship_line2')} />
          <FieldRow required kind="name" label="City" current={snapshot.portal_ship_city} value={form.portal_ship_city} onChange={(v) => onUpdate('portal_ship_city', v)} editing={isEditing('portal_ship_city')} onBeginEdit={() => onBeginEdit('portal_ship_city')} />
          <FieldRow required kind="postcode" label="Postcode" current={snapshot.portal_ship_postcode} value={form.portal_ship_postcode} onChange={(v) => onUpdate('portal_ship_postcode', v)} editing={isEditing('portal_ship_postcode')} onBeginEdit={() => onBeginEdit('portal_ship_postcode')} />
          <FieldRow required kind="email" label="Email" current={snapshot.email} value={form.email} onChange={(v) => onUpdate('email', v)} editing={isEditing('email')} onBeginEdit={() => onBeginEdit('email')} />
          <FieldRow required kind="phone" label="Phone" current={snapshot.phone} value={form.phone} onChange={(v) => onUpdate('phone', v)} editing={isEditing('phone')} onBeginEdit={() => onBeginEdit('phone')} />

          <FieldRow
            required
            label="Allergies & sensitivities"
            multiline
            fullSpan
            current={snapshot.allergies}
            value={form.allergies}
            onChange={(v) => onUpdate('allergies', v)}
            editing={isEditing('allergies')}
            onBeginEdit={() => onBeginEdit('allergies')}
          />
          <FieldRow required kind="name" label="Emergency contact name" current={snapshot.emergency_contact_name} value={form.emergency_contact_name} onChange={(v) => onUpdate('emergency_contact_name', v)} editing={isEditing('emergency_contact_name')} onBeginEdit={() => onBeginEdit('emergency_contact_name')} />
          <FieldRow required kind="phone" label="Emergency contact phone" current={snapshot.emergency_contact_phone} value={form.emergency_contact_phone} onChange={(v) => onUpdate('emergency_contact_phone', v)} editing={isEditing('emergency_contact_phone')} onBeginEdit={() => onBeginEdit('emergency_contact_phone')} />
        </FormGrid>
      </section>

      {/* "How did you hear about us?" — first-time only. The
          fill-blanks rule in submitArrivalIntake protects existing
          answers, but we also hide the question entirely when the
          patient already has one on file so returning patients
          never see it. Optional field, no required-field gate. */}
      {!snapshot.referred_by ? (
        <ReferralSourceSection
          value={form.referred_by}
          onChange={(v) => onUpdate('referred_by', v)}
          isMobile={isMobile}
        />
      ) : null}

      <ConfirmationBanner
        title="What's being worked on today"
        body={
          stagedItems.length === 0 ? (
            <p style={{ margin: 0, fontSize: theme.type.size.base, color: theme.color.inkMuted }}>
              No items added yet.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: theme.space[1],
                }}
              >
                {stagedItems.map((it) => (
                  <li
                    key={it.key}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: theme.space[3],
                      fontSize: theme.type.size.base,
                      color: theme.color.ink,
                      lineHeight: 1.5,
                    }}
                  >
                    <span>{formatItemDescriptor(it)}</span>
                    <span
                      style={{
                        fontSize: theme.type.size.sm,
                        fontVariantNumeric: 'tabular-nums',
                        color: theme.color.inkMuted,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {formatPence(stagedLineTotalPence(it))}
                    </span>
                  </li>
                ))}
              </ul>
              <ConfirmationTotals
                subtotalPence={stagedTotalPence}
                depositPence={depositPence}
                depositProvider={depositProvider}
              />
              <div
                style={{
                  marginTop: theme.space[1],
                  padding: `${theme.space[3]}px ${theme.space[3]}px`,
                  borderRadius: theme.radius.input,
                  background: theme.color.accentBg,
                  display: 'flex',
                  alignItems: 'center',
                  gap: theme.space[3],
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    color: theme.color.accent,
                    flexShrink: 0,
                  }}
                >
                  <ShoppingBag size={22} />
                </span>
                <p
                  style={{
                    margin: 0,
                    fontSize: theme.type.size.sm,
                    color: theme.color.ink,
                    lineHeight: 1.5,
                  }}
                >
                  {linkedToShopify
                    ? "Changes here update your venneir.com account, the One Click app, and any future orders. A new delivery address applies to your next online order; a new email changes how you sign in everywhere."
                    : 'Once this appointment is created, your venneir.com profile is set up. Your details then flow across venneir.com, the One Click app, and any future orders.'}
                </p>
              </div>
            </div>
          )
        }
        checked={itemsConfirmed}
        onChange={onConfirmItems}
        confirmLabel="I confirm the items above and understand my details sync across Venneir."
        required
      />
    </div>
  );
}

// Marketing channels for the "How did you hear about us?" question
// on step 2 (Customer details). Stored as Title Case strings on
// patients.referred_by — the value normaliser in reports.ts groups
// them for the Marketing tab. "Other" reveals a free-text input so
// niche channels (a specific influencer, a local poster, etc.) can
// still be captured without polluting the predefined set.
const REFERRAL_CHANNELS: { value: string; label: string }[] = [
  { value: 'Google', label: 'Google search' },
  { value: 'Instagram', label: 'Instagram' },
  { value: 'Facebook', label: 'Facebook' },
  { value: 'TikTok', label: 'TikTok' },
  { value: 'Taxi signage', label: 'Taxi signage' },
  { value: 'Friend or family', label: 'Friend or family' },
  { value: 'Saw the sign', label: 'Saw the sign / walked past' },
  { value: 'Returning customer', label: 'I have been before' },
  { value: 'Other', label: 'Other' },
];

const REFERRAL_PRESET_VALUES = new Set(
  REFERRAL_CHANNELS.filter((c) => c.value !== 'Other').map((c) => c.value),
);

function ReferralSourceSection({
  value,
  onChange,
  isMobile,
}: {
  value: string;
  onChange: (next: string) => void;
  isMobile: boolean;
}) {
  // The dropdown's "selected" option and the saved value are
  // related but distinct. If the saved value matches a preset, the
  // dropdown shows that preset and there's no free-text box. If
  // the saved value is anything else, the dropdown shows "Other"
  // and a free-text box appears pre-filled with the value.
  const isOther = value !== '' && !REFERRAL_PRESET_VALUES.has(value);
  const dropdownValue = value === '' ? '' : isOther ? 'Other' : value;
  const otherText = isOther ? value : '';

  const handleChannel = (next: string) => {
    if (next === 'Other') {
      // Clear so the input renders empty; user types their own.
      onChange('');
    } else {
      onChange(next);
    }
  };

  return (
    <section
      style={{
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: isMobile ? theme.space[4] : theme.space[5],
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[3],
      }}
    >
      <div>
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          How did you hear about us?
        </h2>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: 1.5,
          }}
        >
          Helps us figure out which channels are working. Optional, only asked once.
        </p>
      </div>
      <DropdownSelect<string>
        label="Channel"
        required
        value={dropdownValue}
        options={REFERRAL_CHANNELS}
        placeholder="Pick the closest one"
        onChange={handleChannel}
      />
      {dropdownValue === 'Other' ? (
        <Input
          label="Tell us a bit more"
          required
          value={otherText}
          maxLength={30}
          onChange={(e) => onChange(e.target.value.slice(0, 30))}
          placeholder="e.g. influencer name, magazine, local poster"
        />
      ) : null}
    </section>
  );
}

// Render a staged cart item as a human-readable phrase: quantity (when
// >1), arch as adjective, catalogue name pluralised when natural,
// shade in parentheses. "2 × Upper Retainers (BL1)" rather than
// "2 × Retainer · Upper · BL1". Pluralisation is intentionally simple:
// strip the obvious cases (already-plural names; "tooth" → "teeth")
// and add "s" otherwise. Edge cases (irregular plurals beyond tooth)
// can be addressed by renaming the catalogue row.
function formatItemDescriptor(item: StagedItem): string {
  const archAdj =
    item.options.arch === 'both'
      ? 'Upper and lower '
      : item.options.arch === 'upper'
        ? 'Upper '
        : item.options.arch === 'lower'
          ? 'Lower '
          : '';
  let name = `${archAdj}${item.catalogue.name}`;
  if (item.qty > 1) {
    const lower = name.toLowerCase();
    if (lower.endsWith('tooth')) {
      name = `${name.slice(0, -5)}teeth`;
    } else if (!lower.endsWith('s')) {
      name = `${name}s`;
    }
  }
  const shade = item.options.shade ? ` (${item.options.shade})` : '';
  const qtyPrefix = item.qty > 1 ? `${item.qty} × ` : '';
  const upgrades = (item.options.upgrades ?? []).map((u) => u.name).join(', ');
  const upgradeSuffix = upgrades ? ` + ${upgrades}` : '';
  return `${qtyPrefix}${name}${shade}${upgradeSuffix}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — Consent (patient-facing)
// ─────────────────────────────────────────────────────────────────────────────

function ConsentStep({
  patient,
  sectionsToSign,
  staffName,
  waiverRef,
  onReadyChange,
  onBusyChange,
  onAllSigned,
}: {
  patient: PatientLite;
  sectionsToSign: WaiverSection[];
  staffName: string;
  waiverRef: React.RefObject<WaiverInlineHandle | null>;
  onReadyChange: (ready: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onAllSigned: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <WaiverInline
        ref={waiverRef}
        patientId={patient.id}
        visitId={null}
        sections={sectionsToSign}
        patientName={`${patient.first_name} ${patient.last_name}`.trim()}
        defaultWitnessName={staffName}
        onAllSigned={onAllSigned}
        onReadyChange={onReadyChange}
        onBusyChange={onBusyChange}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — Start (staff)
// ─────────────────────────────────────────────────────────────────────────────

function StartStep({
  patient,
  stagedItems,
  stagedTotalPence,
  depositPence,
  depositProvider,
  jbRef,
  consentSigned,
}: {
  patient: PatientLite;
  stagedItems: StagedItem[];
  stagedTotalPence: number;
  depositPence: number;
  depositProvider: 'paypal' | 'stripe' | null;
  jbRef: string | null;
  consentSigned: boolean;
}) {
  const totalPence = Math.max(0, stagedTotalPence - depositPence);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <h1
        style={{
          margin: 0,
          fontSize: theme.type.size.xl,
          fontWeight: theme.type.weight.semibold,
          letterSpacing: theme.type.tracking.tight,
          color: theme.color.ink,
        }}
      >
        Ready to start
      </h1>

      <Card padding="lg">
        <SummaryRow
          icon={<UserRound size={18} />}
          label="Patient"
          value={`${patient.first_name} ${patient.last_name}`.trim()}
          first
        />
        {jbRef ? <SummaryRow icon={<Box size={18} />} label="Job box" value={`JB${jbRef}`} /> : null}
        <SummaryRow
          icon={<ShieldCheck size={18} />}
          label="Consent"
          value={consentSigned ? 'Signed' : 'Not required'}
          accent={consentSigned}
        />
        {stagedItems.length > 0 ? (
          <div
            style={{
              marginTop: theme.space[5],
              paddingTop: theme.space[4],
              borderTop: `1px solid ${theme.color.border}`,
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[2],
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
              <ShoppingBag size={18} aria-hidden style={{ color: theme.color.inkMuted }} />
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkSubtle,
                  textTransform: 'uppercase',
                  letterSpacing: theme.type.tracking.wide,
                  fontWeight: theme.type.weight.semibold,
                }}
              >
                Items
              </p>
            </div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {stagedItems.map((it) => (
                <li
                  key={it.key}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: theme.space[3],
                    fontSize: theme.type.size.base,
                    color: theme.color.ink,
                    lineHeight: 1.5,
                  }}
                >
                  <span>{formatItemDescriptor(it)}</span>
                  <span
                    style={{
                      fontSize: theme.type.size.sm,
                      fontVariantNumeric: 'tabular-nums',
                      color: theme.color.inkMuted,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {formatPence(stagedLineTotalPence(it))}
                  </span>
                </li>
              ))}
            </ul>
            <div
              style={{
                marginTop: theme.space[2],
                paddingTop: theme.space[3],
                borderTop: `1px solid ${theme.color.border}`,
                display: 'flex',
                flexDirection: 'column',
                gap: theme.space[1],
              }}
            >
              <TotalsRow
                label="Subtotal"
                valuePence={stagedTotalPence}
                emphasis={depositPence === 0}
              />
              {depositPence > 0 ? (
                <>
                  <TotalsRow
                    label={`Deposit (${depositProvider === 'stripe' ? 'Stripe' : 'PayPal'} via Calendly)`}
                    valuePence={-depositPence}
                  />
                  <TotalsRow label="Total" valuePence={totalPence} emphasis />
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <SummaryRow icon={<ShoppingBag size={18} />} label="Items" value="None" />
        )}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reusable bits
// ─────────────────────────────────────────────────────────────────────────────

function ItemRow({
  item,
  onIncrement,
  onDecrement,
  onRemove,
}: {
  item: StagedItem;
  onIncrement: () => void;
  onDecrement: () => void;
  onRemove: () => void;
}) {
  const lineTotal = stagedLineTotalPence(item);
  const subtitleParts = [
    item.options.arch ? capitalise(item.options.arch) : null,
    item.options.shade ? `Shade ${item.options.shade}` : null,
    ...(item.options.upgrades ?? []).map((u) => u.name),
  ].filter(Boolean) as string[];
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: theme.space[3],
        borderRadius: theme.radius.input,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
      }}
    >
      <Thumb src={item.catalogue.image_url} alt={item.catalogue.name} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.catalogue.name}
        </p>
        <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
          {subtitleParts.length > 0
            ? subtitleParts.join(' · ')
            : formatPence(Math.round(item.catalogue.unit_price * 100))}
        </p>
      </div>
      {item.catalogue.quantity_enabled ? (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
          <button type="button" onClick={onDecrement} style={qtyButton} aria-label="Decrease quantity">
            <Minus size={14} />
          </button>
          <span style={{ minWidth: 24, textAlign: 'center', fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, fontVariantNumeric: 'tabular-nums' }}>
            {item.qty}
          </span>
          <button type="button" onClick={onIncrement} style={qtyButton} aria-label="Increase quantity">
            <Plus size={14} />
          </button>
        </div>
      ) : null}
      <span style={{ minWidth: 72, textAlign: 'right', fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.ink, fontVariantNumeric: 'tabular-nums' }}>
        {formatPence(lineTotal)}
      </span>
      <button type="button" onClick={onRemove} aria-label="Remove" style={{ ...qtyButton, color: theme.color.inkSubtle, border: 'none' }}>
        <X size={16} />
      </button>
    </li>
  );
}

function Thumb({ src, alt }: { src: string | null; alt: string }) {
  if (!src) {
    return (
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: theme.radius.input,
          background: theme.color.bg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: theme.color.inkSubtle,
          flexShrink: 0,
        }}
      >
        <Package size={20} />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      style={{
        width: 56,
        height: 56,
        borderRadius: theme.radius.input,
        objectFit: 'cover',
        background: theme.color.bg,
        flexShrink: 0,
      }}
    />
  );
}

function ConfirmationBanner({
  title,
  body,
  checked,
  onChange,
  confirmLabel,
  required = false,
}: {
  title: string;
  body: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  confirmLabel: string;
  // When true, a small red asterisk is appended to the checkbox
  // label so the gating tick reads as required at a glance — same
  // affordance as the per-field RequiredMark on the form above.
  required?: boolean;
}) {
  return (
    <div
      style={{
        padding: `${theme.space[5]}px ${theme.space[5]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.card,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        boxShadow: theme.shadow.card,
      }}
    >
      {/* Header row — icon + title vertically centred against each
          other. The body wraps below, full width, so the items list
          aligns with the start of the card chrome rather than
          inheriting the icon's left offset. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: theme.radius.pill,
            background: theme.color.accentBg,
            color: theme.color.accent,
            flexShrink: 0,
          }}
        >
          <ClipboardList size={18} />
        </span>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            fontWeight: theme.type.weight.medium,
          }}
        >
          {title}
        </p>
      </div>
      <div style={{ marginTop: theme.space[4] }}>{body}</div>
      <div style={{ marginTop: theme.space[4], paddingTop: theme.space[3], borderTop: `1px solid ${theme.color.border}` }}>
        <Checkbox
          checked={checked}
          onChange={onChange}
          label={
            required ? (
              <>
                {confirmLabel}
                <RequiredMark />
              </>
            ) : (
              confirmLabel
            )
          }
        />
      </div>
    </div>
  );
}

function FormGrid({ children, isMobile }: { children: React.ReactNode; isMobile: boolean }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
        columnGap: theme.space[4],
        rowGap: theme.space[4],
      }}
    >
      {children}
    </div>
  );
}

// FieldKind drives the per-input keyboard, sanitizer and autocomplete
// hints. Names accept letters, hyphens and apostrophes only. Phones
// accept digits with the conventional dial-pad separators. Postcodes
// uppercase and strip anything that isn't alphanumeric or a space.
// Emails get the email keyboard with no auto-capitalisation. Free
// text passes through untouched. Adding a new field type here is
// the single place to wire input behaviour.
type FieldKind = 'text' | 'email' | 'phone' | 'name' | 'postcode';

function sanitizeForKind(kind: FieldKind, value: string): string {
  switch (kind) {
    case 'name':
      // Letters from any script (incl. accented), plus space, hyphen,
      // and apostrophe (covers O'Brien, Smith-Jones). Strips digits.
      return value.replace(/[^\p{L} '\-]/gu, '');
    case 'phone':
      // Digits + the dial-pad separators. The submit-time canonicaliser
      // collapses the rest.
      return value.replace(/[^0-9+()\- ]/g, '');
    case 'postcode':
      // UK postcodes are alphanumeric, optionally separated by a
      // single space. Force-uppercase as the receptionist types.
      return value.toUpperCase().replace(/[^A-Z0-9 ]/g, '');
    case 'email':
      // Drop leading whitespace; trust type=email + the submit-time
      // checks for everything else.
      return value.replace(/^\s+/, '');
    default:
      return value;
  }
}

function inputAttributesForKind(kind: FieldKind): {
  type: string;
  inputMode?: 'text' | 'email' | 'tel' | 'numeric' | 'search';
  autoCapitalize?: 'off' | 'none' | 'on' | 'sentences' | 'words' | 'characters';
  autoComplete?: string;
  spellCheck?: boolean;
  maxLength?: number;
} {
  switch (kind) {
    case 'email':
      return {
        type: 'email',
        inputMode: 'email',
        autoCapitalize: 'none',
        autoComplete: 'email',
        spellCheck: false,
        // RFC 5321 caps the local-part at 64 + the domain at 255 + '@'
        // = 320, but in practice nobody types past 100 — clamp here
        // so a stuck key can't fill the box.
        maxLength: 254,
      };
    case 'phone':
      return {
        type: 'tel',
        inputMode: 'tel',
        autoComplete: 'tel',
        spellCheck: false,
        // E.164 caps at 15 digits. With country code, dial separators
        // (+, spaces, parens, hyphens) we floor at 20 chars total —
        // more than enough for "+44 7700 900 000" and country codes,
        // but stops the 23-digit junk Dylan saw.
        maxLength: 20,
      };
    case 'postcode':
      return {
        type: 'text',
        autoCapitalize: 'characters',
        autoComplete: 'postal-code',
        spellCheck: false,
        // UK postcodes are at most 8 chars (e.g. "SW1W 0NY"). Allow
        // a couple of extra for pasted variants with stray spaces.
        maxLength: 10,
      };
    case 'name':
      return {
        type: 'text',
        autoCapitalize: 'words',
        autoComplete: 'name',
        spellCheck: false,
        maxLength: 60,
      };
    default:
      return { type: 'text' };
  }
}

function FieldRow({
  label,
  current,
  value,
  onChange,
  helper,
  kind = 'text',
  multiline = false,
  alwaysEditable = false,
  fullSpan = false,
  required = false,
  editing = false,
  onBeginEdit,
}: {
  label: string;
  current: string | null;
  value: string;
  onChange: (v: string) => void;
  helper?: string;
  kind?: FieldKind;
  multiline?: boolean;
  alwaysEditable?: boolean;
  fullSpan?: boolean;
  required?: boolean;
  editing?: boolean;
  onBeginEdit?: () => void;
}) {
  const onFile = !alwaysEditable && current !== null && current !== '' && !editing;
  const wrapper: CSSProperties = fullSpan ? { gridColumn: '1 / -1' } : {};
  if (onFile) {
    return (
      <div style={wrapper}>
        <OnFileCard
          label={label}
          required={required}
          value={formatOnFileValue(label, current!)}
          onEdit={onBeginEdit}
        />
      </div>
    );
  }
  if (multiline) {
    return (
      <div style={wrapper}>
        <EditableFieldCard
          label={label}
          required={required}
          helper={helper}
          kind={kind}
          value={value}
          onChange={onChange}
          multiline
        />
      </div>
    );
  }
  return (
    <div style={wrapper}>
      <EditableFieldCard
        label={label}
        required={required}
        helper={helper}
        kind={kind}
        value={value}
        onChange={(v) => onChange(sanitizeForKind(kind, v))}
      />
    </div>
  );
}

// Address line 1 row. Mirrors FieldRow's on-file/edit split but
// swaps the EditableFieldCard for AddressAutocompleteField in the
// edit branch so the patient gets a Places dropdown. Always full-
// span in the FormGrid because the dropdown needs the row width.
function AddressLine1Row({
  snapshot,
  value,
  editing,
  onChange,
  onSelectPlace,
  onBeginEdit,
}: {
  snapshot: string | null;
  value: string;
  editing: boolean;
  onChange: (v: string) => void;
  onSelectPlace: (parsed: ParsedAddress) => void;
  onBeginEdit: () => void;
}) {
  const onFile = snapshot !== null && snapshot !== '' && !editing;
  const wrapper: CSSProperties = { gridColumn: '1 / -1' };
  if (onFile) {
    return (
      <div style={wrapper}>
        <OnFileCard
          label="Address line 1"
          required
          value={formatOnFileValue('Address line 1', snapshot!)}
          onEdit={onBeginEdit}
        />
      </div>
    );
  }
  return (
    <div style={wrapper}>
      <AddressAutocompleteField
        label="Address line 1"
        required
        value={value}
        onChange={onChange}
        onSelectPlace={onSelectPlace}
      />
    </div>
  );
}

// Subtle red asterisk, used by every required-field label across the
// arrival customer step. aria-hidden because the underlying input also
// gets aria-required (or, for dropdowns, the field-level required is
// communicated structurally via the surrounding required label).
function RequiredMark() {
  return (
    <span
      aria-hidden
      style={{
        color: theme.color.alert,
        marginLeft: 4,
        fontWeight: theme.type.weight.semibold,
      }}
    >
      *
    </span>
  );
}

// Editable field rendered as a card matching OnFileCard's silhouette —
// muted sentence-case label, large semibold value-as-input — so the
// edit and on-file states share one visual language. Replaces the
// generic <Input> for the customer step where the design system's
// input chrome (bold ink label) reads as a different surface from the
// on-file tiles either side of it.
function EditableFieldCard({
  label,
  required = false,
  helper,
  kind = 'text',
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  required?: boolean;
  helper?: string;
  kind?: FieldKind;
  value: string;
  onChange: (v: string) => void;
  // When true, swaps the inner <input> for a <textarea> while
  // keeping the same chrome. Used by the Allergies & sensitivities
  // field on the customer step so it sits in a bordered card
  // matching the rest of the form rather than a separate textarea
  // outside any container.
  multiline?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const inputAttrs = inputAttributesForKind(kind);
  // Shared text styling for the inner input / textarea so both
  // surfaces look identical aside from element type.
  const innerStyle: CSSProperties = {
    appearance: 'none',
    border: 'none',
    background: 'transparent',
    outline: 'none',
    padding: 0,
    fontFamily: 'inherit',
    fontSize: theme.type.size.md,
    fontWeight: theme.type.weight.semibold,
    color: theme.color.ink,
    letterSpacing: theme.type.tracking.tight,
    width: '100%',
    minWidth: 0,
  };
  const handleBlur = () => {
    setFocused(false);
    // Title-case names + cities on blur. Doing this on blur (not
    // every keystroke) lets the receptionist type freely without
    // fighting in-progress edits — the cleanup happens when the
    // field commits. Skipped for multiline since paragraph text
    // doesn't title-case sensibly.
    if (!multiline && kind === 'name' && value) {
      const cased = properCase(value);
      if (cased !== value) onChange(cased);
    }
  };
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        border: `1px solid ${focused ? theme.color.ink : theme.color.border}`,
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        cursor: 'text',
      }}
    >
      <span style={cardLabelStyle}>
        {label}
        {required ? <RequiredMark /> : null}
      </span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          onFocus={() => setFocused(true)}
          onBlur={handleBlur}
          rows={3}
          aria-required={required || undefined}
          style={{
            ...innerStyle,
            // Paragraph text is comfortable at lighter weight + a
            // bit of leading. Keeps the card's silhouette identical
            // to the single-line variant; just relaxes the body.
            fontWeight: theme.type.weight.regular,
            lineHeight: theme.type.leading.snug,
            resize: 'vertical',
          }}
        />
      ) : (
        <input
          {...inputAttrs}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          onFocus={() => setFocused(true)}
          onBlur={handleBlur}
          aria-required={required || undefined}
          style={innerStyle}
        />
      )}
      {helper ? <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>{helper}</span> : null}
    </label>
  );
}

// Date-of-birth slot in the customer details FormGrid. Uses the same
// on-file / edit split as FieldRow: when the patient already has a
// DOB on file the row collapses to OnFileCard with a pencil; when the
// receptionist is editing or the field is blank it expands to the
// three-dropdown DateOfBirthRow.
function DateOfBirthFieldRow({
  current,
  value,
  editing,
  onChange,
  onBeginEdit,
}: {
  current: string | null;
  value: string;
  editing: boolean;
  onChange: (v: string) => void;
  onBeginEdit: () => void;
}) {
  const onFile = current !== null && current !== '' && !editing;
  if (onFile) {
    return (
      <div>
        <OnFileCard
          label="Date of birth"
          required
          value={formatOnFileValue('Date of birth', current!)}
          onEdit={onBeginEdit}
        />
      </div>
    );
  }
  return <DateOfBirthRow value={value} onChange={onChange} />;
}

function SexRow({
  current,
  value,
  onChange,
  editing = false,
  onBeginEdit,
}: {
  current: string | null;
  value: string;
  onChange: (v: string) => void;
  editing?: boolean;
  onBeginEdit?: () => void;
}) {
  const showOnFile = current !== null && current !== '' && !editing;
  if (showOnFile) {
    return (
      <div>
        <OnFileCard label="Sex" required value={current!} onEdit={onBeginEdit} />
      </div>
    );
  }
  return (
    <DropdownSelect
      label="Sex"
      required
      value={value}
      options={SEX_OPTIONS}
      onChange={onChange}
    />
  );
}

// On-file pair card. The patient sees a soft white tile per field
// they don't have to fill in — small sentence-case label, large bold
// value, framed with a subtle border so each pair is unambiguously
// one block. Pencil button in the top-right swaps the tile to edit
// mode so the patient can correct anything wrong on file.
function OnFileCard({
  label,
  required = false,
  value,
  onEdit,
}: {
  label: string;
  required?: boolean;
  value: string;
  onEdit?: () => void;
}) {
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        paddingRight: onEdit ? 56 : theme.space[4],
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <span
        style={{
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.medium,
          color: theme.color.inkMuted,
          letterSpacing: 0,
        }}
      >
        {label}
        {required ? <RequiredMark /> : null}
      </span>
      <span
        style={{
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          letterSpacing: theme.type.tracking.tight,
          wordBreak: 'break-word',
          lineHeight: 1.3,
        }}
      >
        {value}
      </span>
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${label.toLowerCase()}`}
          style={{
            position: 'absolute',
            top: theme.space[2],
            right: theme.space[2],
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            padding: theme.space[2],
            color: theme.color.inkSubtle,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: theme.radius.pill,
            fontFamily: 'inherit',
            transition: `color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.color = theme.color.ink;
            (e.currentTarget as HTMLElement).style.background = theme.color.bg;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.color = theme.color.inkSubtle;
            (e.currentTarget as HTMLElement).style.background = 'transparent';
          }}
        >
          <Pencil size={16} />
        </button>
      ) : null}
    </div>
  );
}

// Format on-file values for human reading. Date of birth lands as a
// raw ISO string from the patients row — render it as "25 Feb 1992"
// so the patient confirms a value that matches the format on their
// driver's licence rather than a database string.
function formatOnFileValue(label: string, raw: string): string {
  if (label === 'Date of birth') {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    }
  }
  return raw;
}

function SummaryRow({
  icon,
  label,
  value,
  first = false,
  accent = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  first?: boolean;
  accent?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[4],
        padding: `${theme.space[3]}px 0`,
        borderTop: first ? 'none' : `1px solid ${theme.color.border}`,
      }}
    >
      <span style={{ display: 'inline-flex', color: accent ? theme.color.accent : theme.color.inkSubtle }}>{icon}</span>
      <span style={{ flex: 1, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>{label}</span>
      <span style={{ fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: accent ? theme.color.accent : theme.color.ink }}>
        {value}
      </span>
    </div>
  );
}

function StaffOnlyBanner({ subtitle }: { subtitle: string }) {
  return (
    <div
      role="note"
      aria-label="Staff only"
      style={{
        background: theme.color.ink,
        borderBottom: `1px solid ${theme.color.border}`,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
      }}
    >
      <div
        style={{
          maxWidth: theme.layout.pageMaxWidth,
          width: '100%',
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.space[3],
          textAlign: 'center',
        }}
      >
        <span
          style={{
            padding: `${theme.space[1]}px ${theme.space[2]}px`,
            borderRadius: theme.radius.pill,
            background: theme.color.surface,
            color: theme.color.ink,
            fontSize: theme.type.size.xs,
            fontWeight: theme.type.weight.semibold,
            textTransform: 'uppercase',
            letterSpacing: theme.type.tracking.wide,
            // Letter-spacing adds trailing space after the last glyph; offset
            // the leading edge by the same amount so the text reads as
            // geometrically centred inside the pill.
            textIndent: theme.type.tracking.wide,
            flexShrink: 0,
          }}
        >
          Staff only
        </span>
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.medium,
            color: theme.color.surface,
            lineHeight: theme.type.leading.snug,
          }}
        >
          {subtitle}
        </span>
      </div>
    </div>
  );
}

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

// Selectable chip used by the service-type grid. Reads as a card-like
// affordance — taller, slightly more prominent than a pill — so it
// holds its weight in a 4-up grid without looking like a chiclet.
const recognisedChipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: `${theme.space[1]}px ${theme.space[2]}px`,
  borderRadius: theme.radius.pill,
  background: theme.color.accentBg,
  color: theme.color.accent,
  fontSize: theme.type.size.xs,
  fontWeight: theme.type.weight.semibold,
};

const subtleLinkStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: theme.space[1],
  fontFamily: 'inherit',
  fontSize: theme.type.size.sm,
  fontWeight: theme.type.weight.semibold,
  color: theme.color.ink,
  padding: 0,
};

// List-cell button. Solid hairline (not dashed), max-width capped
// so it doesn't span the row, and a horizontal layout (avatar +
// text + chevron) that reads instantly as tappable.
const emptyItemsStyle: CSSProperties = {
  width: '100%',
  maxWidth: 520,
  appearance: 'none',
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.card,
  background: theme.color.surface,
  padding: `${theme.space[4]}px ${theme.space[5]}px`,
  cursor: 'pointer',
  fontFamily: 'inherit',
  display: 'flex',
  alignItems: 'center',
  gap: theme.space[4],
  WebkitTapHighlightColor: 'transparent',
};

const qtyButton: CSSProperties = {
  appearance: 'none',
  width: 32,
  height: 32,
  borderRadius: theme.radius.pill,
  border: `1px solid ${theme.color.border}`,
  background: theme.color.surface,
  color: theme.color.ink,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'inherit',
};

// Shared label style for the customer-step card-shaped fields. Muted
// sentence-case mirrors the OnFileCard label so editable + on-file
// states present one consistent visual rhythm.
const cardLabelStyle: CSSProperties = {
  fontSize: theme.type.size.sm,
  fontWeight: theme.type.weight.medium,
  color: theme.color.inkMuted,
};

const textareaStyle: CSSProperties = {
  width: '100%',
  minHeight: 80,
  padding: `${theme.space[3]}px ${theme.space[4]}px`,
  borderRadius: theme.radius.input,
  border: 'none',
  boxShadow: `inset 0 0 0 1px ${theme.color.border}`,
  fontSize: theme.type.size.base,
  fontFamily: 'inherit',
  color: theme.color.ink,
  background: theme.color.surface,
  resize: 'vertical',
  outline: 'none',
};

