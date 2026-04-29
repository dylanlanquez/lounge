import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  Box,
  CheckCircle2,
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
  Button,
  Card,
  Skeleton,
  Toast,
  WaiverInline,
} from '../components/index.ts';
import { CataloguePicker } from '../components/CataloguePicker/CataloguePicker.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
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
import { totalForQtyPence } from '../lib/catalogueMatch.ts';
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
  requiredSectionsForServiceTypes,
  summariseWaiverFlag,
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
};

const SEX_OPTIONS = ['Female', 'Male', 'Other', 'Prefer not to say'] as const;

const SERVICE_OPTIONS: { id: string; label: string }[] = [
  { id: 'denture_repair', label: 'Denture repair' },
  { id: 'same_day_appliance', label: 'Same-day appliance' },
  { id: 'click_in_veneers', label: 'Click-in veneers' },
  { id: 'other', label: 'Other / consultation' },
];

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
  const isMobile = useIsMobile(640);

  const path = typeof window !== 'undefined' ? window.location.pathname : '';
  const mode: Mode = path.startsWith('/arrival/walk-in') ? 'walk_in' : 'appointment';

  const [step, setStep] = useState<Step>('service');
  const [appointment, setAppointment] = useState<AppointmentContext | null>(null);
  const [patient, setPatient] = useState<PatientLite | null>(null);
  const [snapshot, setSnapshot] = useState<ArrivalIntakeSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [serviceType, setServiceType] = useState<string>('denture_repair');
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
      return next;
    });
  };
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eventTypeLabel = useMemo(() => {
    if (mode === 'appointment') return appointment?.event_type_label ?? null;
    return walkInServiceLabel(serviceType);
  }, [mode, appointment, serviceType]);

  const jbRequired = useMemo(() => appointmentRequiresJbRef(eventTypeLabel), [eventTypeLabel]);

  const { sections: waiverSections } = useWaiverSections();
  const { latest: patientSignatures, refresh: refreshSignatures } =
    usePatientWaiverState(patient?.id);
  const requiredWaiverSections = useMemo<WaiverSection[]>(() => {
    if (waiverSections.length === 0) return [];
    const inferred = inferServiceTypeFromEventLabel(eventTypeLabel);
    return requiredSectionsForServiceTypes(inferred ? [inferred] : [], waiverSections);
  }, [waiverSections, eventTypeLabel]);
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
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        if (mode === 'appointment') {
          const { data: appt, error: apptErr } = await supabase
            .from('lng_appointments')
            .select('id, patient_id, location_id, event_type_label, start_at')
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
    need('Country', snapshot.portal_ship_country_code, form.portal_ship_country_code);
    if (form.allergies.trim() === '' && (snapshot.allergies ?? '') === '') {
      list.push('Allergies & sensitivities');
    }
    need('Emergency contact name', snapshot.emergency_contact_name, form.emergency_contact_name);
    need('Emergency contact phone', snapshot.emergency_contact_phone, form.emergency_contact_phone);
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
    () => stagedItems.reduce((sum, it) => sum + totalForQtyPence(it.catalogue, it.qty), 0),
    [stagedItems]
  );

  const handleStartAppointment = async () => {
    if (!patient) return;
    if (mode === 'appointment' && !appointment) return;
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
        },
        jbRef: jbRequired ? jbRef.trim() || null : null,
        editedKeys,
      });

      let visitId: string;
      if (mode === 'appointment') {
        const r = await markAppointmentArrived(appointment!.id);
        visitId = r.visit_id;
      } else {
        const r = await createWalkInVisit({
          patient_id: patient.id,
          location_id: patient.location_id ?? '',
          service_type: serviceType,
          appointment_ref: intakeResult.appointment_ref,
          jb_ref: jbRequired ? jbRef.trim() || null : null,
          notes: notes.trim() || undefined,
        });
        visitId = r.visit_id;
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

      navigate(`/visit/${visitId}`, { state: { from: 'arrival' } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start appointment');
      setSubmitting(false);
    }
  };

  // Render shell ───────────────────────────────────────────────────────
  const currentStepIndex = STEPS.findIndex((s) => s.id === step);
  const staffName = (user.user_metadata?.name as string | undefined) ?? user.email ?? 'Staff';

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
      <StepperBar
        steps={STEPS}
        currentIndex={currentStepIndex}
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
            appointment={appointment}
            serviceType={serviceType}
            onChangeServiceType={setServiceType}
            stagedItems={stagedItems}
            stagedTotalPence={stagedTotalPence}
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
          />
        ) : step === 'consent' ? (
          <ConsentStep
            patient={patient}
            sectionsToSign={sectionsToSign}
            staffName={staffName}
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
            : 'Next'
        }
        primaryDisabled={
          step === 'service'
            ? !serviceReady
            : step === 'customer'
              ? !customerReady
              : step === 'consent'
                ? !consentReady
                : submitting
        }
        primaryLoading={submitting && step === 'start'}
        primaryShowArrow={step !== 'start' || !submitting}
        statusMessage={statusFor(step, {
          service: serviceReady,
          customer: customerReady,
          consent: consentReady,
        }, customerMissing.length, stagedItems.length)}
        onPrimary={step === 'start' ? handleStartAppointment : onContinue}
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
  stagedCount: number
): string {
  if (step === 'service') {
    if (stagedCount === 0) return 'Add at least one item';
    if (!ready.service) return 'Complete all required fields';
    return '';
  }
  if (step === 'customer') {
    if (customerMissingCount > 0) return `${customerMissingCount} required ${customerMissingCount === 1 ? 'field' : 'fields'} remaining`;
    if (!ready.customer) return 'Confirm the items above';
    return '';
  }
  if (step === 'consent') {
    return ready.consent ? '' : 'Sign each section to continue';
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
}: {
  steps: { id: Step; label: string }[];
  currentIndex: number;
}) {
  return (
    <header
      style={{
        position: 'sticky',
        // Sit immediately below the KioskStatusBar so it never gets
        // clipped behind the device chrome row.
        top: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + env(safe-area-inset-top, 0px))`,
        zIndex: 20,
        background: theme.color.surface,
        borderBottom: `1px solid ${theme.color.border}`,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
      }}
    >
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
  appointment,
  serviceType,
  onChangeServiceType,
  stagedItems,
  stagedTotalPence,
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
  appointment: AppointmentContext | null;
  serviceType: string;
  onChangeServiceType: (v: string) => void;
  stagedItems: StagedItem[];
  stagedTotalPence: number;
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

      {mode === 'walk_in' ? (
        <Section title="Service type" sub="Pick what's being worked on today.">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: theme.space[2],
            }}
          >
            {SERVICE_OPTIONS.map((o) => {
              const selected = serviceType === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => onChangeServiceType(o.id)}
                  style={selectChipStyle(selected)}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </Section>
      ) : appointment?.event_type_label ? (
        <Section title="Booking">
          <p style={{ margin: 0, fontSize: theme.type.size.base, color: theme.color.ink }}>
            {appointment.event_type_label}
          </p>
        </Section>
      ) : null}

      {jbRequired ? (
        <Section
          title="Job box"
          sub="The number on the box where the impression sits. We check Checkpoint as you type."
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
          <button type="button" onClick={onOpenPicker} style={emptyItemsStyle}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 56,
                height: 56,
                borderRadius: theme.radius.pill,
                background: theme.color.accentBg,
                color: theme.color.accent,
                marginBottom: theme.space[3],
              }}
            >
              <Package size={24} />
            </span>
            <span style={{ fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
              Choose products
            </span>
            <span style={{ marginTop: theme.space[1], fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              Pick from the catalogue. The patient sees the list before they sign.
            </span>
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
        {stagedItems.length > 0 ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: theme.space[4],
              padding: `${theme.space[3]}px ${theme.space[4]}px`,
              background: theme.color.bg,
              borderRadius: theme.radius.input,
              border: `1px solid ${theme.color.border}`,
            }}
          >
            <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>Total</span>
            <span
              style={{
                fontSize: theme.type.size.lg,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatPence(stagedTotalPence)}
            </span>
          </div>
        ) : null}
      </Section>

      <Section title="Notes" sub="Special requirements, technician notes — staff only.">
        <textarea
          value={notes}
          onChange={(e) => onChangeNotes(e.currentTarget.value)}
          rows={3}
          placeholder="Anything the lab or clinician should know"
          style={textareaStyle}
        />
      </Section>
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
  children,
}: {
  title: string;
  sub?: string;
  action?: React.ReactNode;
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
          onChange={(e) => onChange(e.currentTarget.value)}
          inputMode="numeric"
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
}) {
  const isEditing = (k: keyof FormState) => editingFields.has(k);
  const itemsLine = stagedItems.length === 0
    ? 'No items added yet'
    : stagedItems
        .map((it) => `${it.qty > 1 ? `${it.qty} × ` : ''}${it.catalogue.name}${it.options.arch ? ` · ${capitalise(it.options.arch)}` : ''}`)
        .join(', ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[6] }}>
      <header>
        <p
          style={{
            margin: `0 0 ${theme.space[2]}px`,
            fontSize: theme.type.size.xs,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.accent,
            textTransform: 'uppercase',
            letterSpacing: theme.type.tracking.wide,
          }}
        >
          Welcome to Lounge
        </p>
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
          Check the items being worked on today, fill any missing details, and we'll be ready to begin.
        </p>
      </header>

      <ConfirmationBanner
        title="What's being worked on today"
        body={itemsLine}
        checked={itemsConfirmed}
        onChange={onConfirmItems}
        confirmLabel="I confirm the above details are correct"
      />

      <section>
        <SectionHeading title="Your details" sub="Just the missing pieces. Anything we already have is shown below." />

        {linkedToShopify ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: theme.space[3],
              padding: `${theme.space[3]}px ${theme.space[4]}px`,
              borderRadius: theme.radius.input,
              background: theme.color.accentBg,
              border: `1px solid ${theme.color.accent}`,
              marginBottom: theme.space[4],
            }}
          >
            <span style={{ display: 'inline-flex', color: theme.color.accent, marginTop: 2, flexShrink: 0 }}>
              <ShoppingBag size={18} />
            </span>
            <div style={{ minWidth: 0 }}>
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.sm,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.accent,
                }}
              >
                Linked to your Lounge online account
              </p>
              <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.ink, lineHeight: 1.5 }}>
                Anything you change here also updates your One Click profile on lounge.venneir.com — the same details we use for online ordering and shipping.
              </p>
            </div>
          </div>
        ) : null}

        <FormGrid isMobile={isMobile}>
          <FieldRow label="First name" current={snapshot.first_name} value={form.first_name} onChange={(v) => onUpdate('first_name', v)} editing={isEditing('first_name')} onBeginEdit={() => onBeginEdit('first_name')} />
          <FieldRow label="Last name" current={snapshot.last_name} value={form.last_name} onChange={(v) => onUpdate('last_name', v)} editing={isEditing('last_name')} onBeginEdit={() => onBeginEdit('last_name')} />
          <FieldRow label="Date of birth" current={snapshot.date_of_birth} value={form.date_of_birth} onChange={(v) => onUpdate('date_of_birth', v)} type="date" editing={isEditing('date_of_birth')} onBeginEdit={() => onBeginEdit('date_of_birth')} />
          <SexRow current={snapshot.sex} value={form.sex} onChange={(v) => onUpdate('sex', v)} editing={isEditing('sex')} onBeginEdit={() => onBeginEdit('sex')} />
          <FieldRow label="Address line 1" current={snapshot.portal_ship_line1} value={form.portal_ship_line1} onChange={(v) => onUpdate('portal_ship_line1', v)} fullSpan editing={isEditing('portal_ship_line1')} onBeginEdit={() => onBeginEdit('portal_ship_line1')} />
          <FieldRow label="Address line 2" current={snapshot.portal_ship_line2} value={form.portal_ship_line2} onChange={(v) => onUpdate('portal_ship_line2', v)} fullSpan editing={isEditing('portal_ship_line2')} onBeginEdit={() => onBeginEdit('portal_ship_line2')} />
          <FieldRow label="City" current={snapshot.portal_ship_city} value={form.portal_ship_city} onChange={(v) => onUpdate('portal_ship_city', v)} editing={isEditing('portal_ship_city')} onBeginEdit={() => onBeginEdit('portal_ship_city')} />
          <FieldRow label="Postcode" current={snapshot.portal_ship_postcode} value={form.portal_ship_postcode} onChange={(v) => onUpdate('portal_ship_postcode', v)} editing={isEditing('portal_ship_postcode')} onBeginEdit={() => onBeginEdit('portal_ship_postcode')} />
          <FieldRow label="Country" helper="ISO code, e.g. GB" current={snapshot.portal_ship_country_code} value={form.portal_ship_country_code} onChange={(v) => onUpdate('portal_ship_country_code', v)} fullSpan editing={isEditing('portal_ship_country_code')} onBeginEdit={() => onBeginEdit('portal_ship_country_code')} />
          <FieldRow label="Email" current={snapshot.email} value={form.email} onChange={(v) => onUpdate('email', v)} type="email" editing={isEditing('email')} onBeginEdit={() => onBeginEdit('email')} />
          <FieldRow label="Phone" current={snapshot.phone} value={form.phone} onChange={(v) => onUpdate('phone', v)} type="tel" editing={isEditing('phone')} onBeginEdit={() => onBeginEdit('phone')} />

          <SubsectionDivider title="Medical & emergency" />

          <AllergiesField
            current={snapshot.allergies}
            value={form.allergies}
            onChange={(v) => onUpdate('allergies', v)}
          />
          <FieldRow label="Emergency contact name" current={snapshot.emergency_contact_name} value={form.emergency_contact_name} onChange={(v) => onUpdate('emergency_contact_name', v)} editing={isEditing('emergency_contact_name')} onBeginEdit={() => onBeginEdit('emergency_contact_name')} />
          <FieldRow label="Emergency contact phone" current={snapshot.emergency_contact_phone} value={form.emergency_contact_phone} onChange={(v) => onUpdate('emergency_contact_phone', v)} type="tel" editing={isEditing('emergency_contact_phone')} onBeginEdit={() => onBeginEdit('emergency_contact_phone')} />
        </FormGrid>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — Consent (patient-facing)
// ─────────────────────────────────────────────────────────────────────────────

function ConsentStep({
  patient,
  sectionsToSign,
  staffName,
  onAllSigned,
}: {
  patient: PatientLite;
  sectionsToSign: WaiverSection[];
  staffName: string;
  onAllSigned: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <WaiverInline
        patientId={patient.id}
        visitId={null}
        sections={sectionsToSign}
        patientName={`${patient.first_name} ${patient.last_name}`.trim()}
        defaultWitnessName={staffName}
        onAllSigned={onAllSigned}
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
  jbRef,
  consentSigned,
}: {
  patient: PatientLite;
  stagedItems: StagedItem[];
  stagedTotalPence: number;
  jbRef: string | null;
  consentSigned: boolean;
}) {
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
        <SummaryRow
          icon={<ShoppingBag size={18} />}
          label="Items"
          value={
            stagedItems.length === 0
              ? 'None'
              : `${stagedItems.length} line${stagedItems.length === 1 ? '' : 's'} · ${formatPence(stagedTotalPence)}`
          }
        />
        {jbRef ? <SummaryRow icon={<Box size={18} />} label="Job box" value={`JB${jbRef}`} /> : null}
        <SummaryRow
          icon={<ShieldCheck size={18} />}
          label="Consent"
          value={consentSigned ? 'Signed' : 'Not required'}
          accent={consentSigned}
        />
        {stagedItems.length > 0 ? (
          <div style={{ marginTop: theme.space[5], paddingTop: theme.space[4], borderTop: `1px solid ${theme.color.border}`, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkSubtle, textTransform: 'uppercase', letterSpacing: theme.type.tracking.wide, fontWeight: theme.type.weight.semibold }}>
              Items
            </p>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
              {stagedItems.map((it) => (
                <li
                  key={it.key}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: theme.type.size.sm,
                    color: theme.color.ink,
                  }}
                >
                  <span>
                    {it.qty > 1 ? `${it.qty} × ` : ''}
                    {it.catalogue.name}
                    {it.options.arch ? ` · ${capitalise(it.options.arch)}` : ''}
                  </span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: theme.color.inkMuted }}>
                    {formatPence(totalForQtyPence(it.catalogue, it.qty))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
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
  const lineTotal = totalForQtyPence(item.catalogue, item.qty);
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
          {[item.options.arch ? capitalise(item.options.arch) : null, item.options.shade ? `Shade ${item.options.shade}` : null]
            .filter(Boolean)
            .join(' · ') || formatPence(Math.round(item.catalogue.unit_price * 100))}
        </p>
      </div>
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
}: {
  title: string;
  body: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  confirmLabel: string;
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
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: theme.space[3] }}>
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
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, fontWeight: theme.type.weight.medium }}>
            {title}
          </p>
          <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.base, color: theme.color.ink, lineHeight: 1.55 }}>
            {body}
          </p>
        </div>
      </div>
      <div style={{ marginTop: theme.space[4], paddingTop: theme.space[3], borderTop: `1px solid ${theme.color.border}` }}>
        <CheckRow checked={checked} onChange={onChange} label={confirmLabel} />
      </div>
    </div>
  );
}

function CheckRow({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[3],
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          borderRadius: 6,
          background: checked ? theme.color.ink : theme.color.surface,
          border: `1px solid ${checked ? theme.color.ink : theme.color.border}`,
          color: theme.color.surface,
          flexShrink: 0,
        }}
      >
        {checked ? <CheckCircle2 size={16} /> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }}
      />
      <span style={{ fontSize: theme.type.size.base, color: theme.color.ink, fontWeight: theme.type.weight.medium }}>
        {label}
      </span>
    </label>
  );
}

// Subsection break inside a FormGrid. Spans the whole row so the
// hairline runs full-width; sentence-case eyebrow above gives the
// next group a clear name without the all-caps shouting Dylan
// (rightly) flagged on the previous version.
function SubsectionDivider({ title }: { title: string }) {
  return (
    <div
      style={{
        gridColumn: '1 / -1',
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
        marginTop: theme.space[3],
        marginBottom: theme.space[1],
      }}
    >
      <h3
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.inkMuted,
          letterSpacing: 0,
        }}
      >
        {title}
      </h3>
      <span aria-hidden style={{ height: 1, background: theme.color.border }} />
    </div>
  );
}

// Allergies field. Lives in its own component so the multiline label
// rhythm matches the on-file tile language: muted sentence-case label,
// helper text below the input rather than competing with it. Always
// editable — even when the patient already has allergies on file we
// re-confirm so a new symptom can be captured without going back to
// patient profile.
function AllergiesField({
  current,
  value,
  onChange,
}: {
  current: string | null;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label
      style={{
        gridColumn: '1 / -1',
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
      }}
    >
      <span style={cardLabelStyle}>Allergies &amp; sensitivities</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        rows={3}
        placeholder={current ? '' : "Write 'None known' if not applicable"}
        style={{
          ...textareaStyle,
          minHeight: 96,
        }}
      />
      {current ? (
        <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
          On file: {current}
        </span>
      ) : null}
    </label>
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

function FieldRow({
  label,
  current,
  value,
  onChange,
  helper,
  type = 'text',
  multiline = false,
  alwaysEditable = false,
  fullSpan = false,
  editing = false,
  onBeginEdit,
}: {
  label: string;
  current: string | null;
  value: string;
  onChange: (v: string) => void;
  helper?: string;
  type?: string;
  multiline?: boolean;
  alwaysEditable?: boolean;
  fullSpan?: boolean;
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
          value={formatOnFileValue(label, current!)}
          onEdit={onBeginEdit}
        />
      </div>
    );
  }
  if (multiline) {
    return (
      <label style={{ ...wrapper, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        <span style={cardLabelStyle}>{label}</span>
        {helper ? <span style={helperStyle}>{helper}</span> : null}
        <textarea value={value} onChange={(e) => onChange(e.currentTarget.value)} rows={3} style={textareaStyle} />
      </label>
    );
  }
  return (
    <div style={wrapper}>
      <EditableFieldCard
        label={label}
        helper={helper}
        type={type}
        value={value}
        onChange={onChange}
      />
    </div>
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
  helper,
  type = 'text',
  value,
  onChange,
}: {
  label: string;
  helper?: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [focused, setFocused] = useState(false);
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
      <span style={cardLabelStyle}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
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
        }}
      />
      {helper ? <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>{helper}</span> : null}
    </label>
  );
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
        <OnFileCard label="Sex" value={current!} onEdit={onBeginEdit} />
      </div>
    );
  }
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <span style={cardLabelStyle}>Sex</span>
      <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
        {SEX_OPTIONS.map((opt) => {
          const selected = value === opt;
          return (
            <button key={opt} type="button" onClick={() => onChange(opt)} style={pillButton(selected)}>
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// On-file pair card. The patient sees a soft white tile per field
// they don't have to fill in — small sentence-case label, large bold
// value, framed with a subtle border so each pair is unambiguously
// one block. Pencil button in the top-right swaps the tile to edit
// mode so the patient can correct anything wrong on file.
function OnFileCard({
  label,
  value,
  onEdit,
}: {
  label: string;
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

function SectionHeading({ title, sub }: { title: string; sub?: string }) {
  return (
    <header style={{ marginBottom: theme.space[4] }}>
      <h2
        style={{
          margin: 0,
          fontSize: theme.type.size.lg,
          fontWeight: theme.type.weight.semibold,
          letterSpacing: theme.type.tracking.tight,
          color: theme.color.ink,
        }}
      >
        {title}
      </h2>
      {sub ? <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>{sub}</p> : null}
    </header>
  );
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
          gap: theme.space[3],
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

function pillButton(selected: boolean): CSSProperties {
  return {
    appearance: 'none',
    border: `1px solid ${selected ? theme.color.ink : theme.color.border}`,
    background: selected ? theme.color.ink : theme.color.surface,
    color: selected ? theme.color.surface : theme.color.ink,
    borderRadius: theme.radius.pill,
    padding: `${theme.space[2]}px ${theme.space[4]}px`,
    fontSize: theme.type.size.sm,
    fontWeight: theme.type.weight.medium,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
  };
}

// Selectable chip used by the service-type grid. Reads as a card-like
// affordance — taller, slightly more prominent than a pill — so it
// holds its weight in a 4-up grid without looking like a chiclet.
function selectChipStyle(selected: boolean): CSSProperties {
  return {
    appearance: 'none',
    border: `1px solid ${selected ? theme.color.ink : theme.color.border}`,
    background: selected ? theme.color.ink : theme.color.surface,
    color: selected ? theme.color.surface : theme.color.ink,
    borderRadius: theme.radius.input,
    padding: `${theme.space[3]}px ${theme.space[4]}px`,
    fontSize: theme.type.size.base,
    fontWeight: theme.type.weight.semibold,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
    transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
  };
}

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

const emptyItemsStyle: CSSProperties = {
  width: '100%',
  appearance: 'none',
  border: `1px dashed ${theme.color.border}`,
  borderRadius: theme.radius.card,
  background: theme.color.surface,
  padding: `${theme.space[8]}px ${theme.space[6]}px`,
  cursor: 'pointer',
  fontFamily: 'inherit',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  textAlign: 'center',
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

const helperStyle: CSSProperties = {
  fontSize: theme.type.size.sm,
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

