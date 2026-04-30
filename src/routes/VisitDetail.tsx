import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  Ban,
  Box,
  CalendarCheck,
  CheckCircle2,
  CheckCircle,
  ChevronRight,
  Circle,
  CircleSlash,
  CreditCard,
  FileText,
  Hash,
  Loader2,
  Plus,
  Printer,
  ShoppingCart,
  StickyNote,
  UserPlus,
  X,
} from 'lucide-react';
import {
  BeforeAfterGallery,
  BottomSheet,
  Breadcrumb,
  Button,
  Card,
  EmptyState,
  MarketingGallery,
  MultiSelectDropdown,
  Skeleton,
  StatusPill,
  Toast,
  VisitTimeline,
  WaiverSheet,
} from '../components/index.ts';
import { Dialog } from '../components/Dialog/Dialog.tsx';
import { WaiverViewerDialog } from '../components/WaiverViewerDialog/WaiverViewerDialog.tsx';
import { supabase } from '../lib/supabase.ts';
import { useSignedWaivers } from '../lib/queries/waiver.ts';
import type { WaiverDocInput, WaiverDocItem, WaiverDocSection } from '../lib/waiverDocument.ts';
import { usePatientProfileFiles } from '../lib/queries/patientProfile.ts';
import { CartLineItem } from '../components/CartLineItem/CartLineItem.tsx';
import { CataloguePicker } from '../components/CataloguePicker/CataloguePicker.tsx';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { formatVisitCrumb, recordUnsuitability, useVisitDetail } from '../lib/queries/visits.ts';
import { patientFullName } from '../lib/queries/patients.ts';
import {
  formatPence,
  removeCartItem,
  updateCartItemQuantity,
  useCart,
} from '../lib/queries/carts.ts';
import { useCatalogueActive } from '../lib/queries/catalogue.ts';
import {
  composeUpgradeLabel,
  useUpgradesActive,
  type UpgradeDisplayPosition,
} from '../lib/queries/upgrades.ts';
import {
  inferServiceTypeFromEventLabel,
  requiredSectionsForCart,
  sectionSignatureState,
  summariseWaiverFlag,
  useAllCatalogueWaiverRequirements,
  useWaiverSections,
  usePatientWaiverState,
  type WaiverSection,
} from '../lib/queries/waiver.ts';
import { printLwo, MAX_TECH_NOTE_LENGTH, type PrintableLwoItem } from '../lib/printLwo.ts';

export function VisitDetail() {
  const { id } = useParams<{ id: string }>();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { visit, patient, deposit, appointment, receptionistName, loading } = useVisitDetail(id);
  const { data: galleryFiles, loading: galleryFilesLoading, refresh: refreshGalleryFiles } =
    usePatientProfileFiles(patient?.id ?? null);
  const { cart, items, loading: cartLoading, refresh, ensureOpen } = useCart(id);
  // Catalogue is the source of truth for include_on_lwo. Cart items
  // carry catalogue_id snapshots, so we can look the live flag up at
  // print time without snapshotting it onto cart_items (snapshotted
  // fields are for receipts; operational behaviour stays current).
  const { rows: catalogueRows } = useCatalogueActive();
  const catalogueById = useMemo(() => {
    const m = new Map<string, (typeof catalogueRows)[number]>();
    for (const r of catalogueRows) m.set(r.id, r);
    return m;
  }, [catalogueRows]);
  // Live registry of upgrade display_position so cart subtitle + LWO
  // can place each upgrade where admin wants it.
  const { rows: upgradeRows } = useUpgradesActive();
  const upgradePositionById = useMemo(() => {
    const m = new Map<string, UpgradeDisplayPosition>();
    for (const u of upgradeRows) m.set(u.id, u.display_position);
    return m;
  }, [upgradeRows]);
  // Decide whether a cart line should print on the LWO. Catalogue
  // lookup wins; ad-hoc rows (no catalogue_id) fall back to the
  // legacy "exclude impression appointments" rule so behaviour
  // stays identical for non-catalogue lines.
  const itemPrintsOnLwo = useCallback(
    (it: { catalogue_id: string | null; service_type: string | null }): boolean => {
      if (it.catalogue_id) {
        const row = catalogueById.get(it.catalogue_id);
        if (row) return row.include_on_lwo;
      }
      return it.service_type !== 'impression_appointment';
    },
    [catalogueById]
  );

  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Tech-note edit dialog. Reuses the visit's notes column — same field
  // step 1 of the arrival form writes to and the printed LWO reads
  // from. Once the visit is open it's read-only on this page until
  // the receptionist taps "Edit tech note" to amend it (e.g. after a
  // call from the lab asking for shade clarification).
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  // Signed-waiver viewer. Waivers are patient-scoped (a patient signs
  // each section once at its current version, and the same signature
  // is valid for every visit until the section's version bumps), so
  // we read every signed row for the patient and pair them up to
  // this visit's required sections inside the memo below. The
  // dialog only shows up when at least one required section has a
  // matching signed row.
  const [waiverViewerOpen, setWaiverViewerOpen] = useState(false);
  const { rows: patientSignedRows } = useSignedWaivers(patient?.id ?? null);
  const [waiverOpen, setWaiverOpen] = useState(false);
  // Unsuitability sheet — staff records that the patient cannot
  // proceed with one or more items in their basket. Reason is shared
  // across the selected products (one submit = one finding for each
  // chosen line, all with the same reason). Submit terminates the
  // visit by flipping status to 'unsuitable'.
  const [unsuitableOpen, setUnsuitableOpen] = useState(false);
  const [unsuitableCatalogueIds, setUnsuitableCatalogueIds] = useState<string[]>([]);
  const [unsuitableReason, setUnsuitableReason] = useState('');
  const [unsuitableBusy, setUnsuitableBusy] = useState(false);
  const [unsuitableError, setUnsuitableError] = useState<string | null>(null);
  const isMobile = useIsMobile(640);

  // Waiver state. Required sections are derived from the cart's
  // service_types when items exist (post-arrival truth) and fall back to
  // the appointment's event-type label for an empty cart (pre-arrival
  // inference). 'general' is always included.
  const {
    sections: waiverSections,
    loading: waiverSectionsLoading,
    error: waiverSectionsError,
  } = useWaiverSections();
  const {
    latest: patientSignatures,
    loading: patientSignaturesLoading,
    refresh: refreshSignatures,
  } = usePatientWaiverState(patient?.id ?? null);
  const { byCatalogueId: explicitWaiverByCatalogueId } = useAllCatalogueWaiverRequirements();
  const requiredSections = useMemo<WaiverSection[]>(() => {
    if (waiverSections.length === 0) return [];
    if (items.length > 0) {
      return requiredSectionsForCart(
        items.map((it) => ({ catalogue_id: it.catalogue_id, service_type: it.service_type })),
        waiverSections,
        explicitWaiverByCatalogueId
      );
    }
    const inferred = inferServiceTypeFromEventLabel(appointment?.event_type_label ?? null);
    return requiredSectionsForCart(
      inferred ? [{ catalogue_id: null, service_type: inferred }] : [],
      waiverSections,
      explicitWaiverByCatalogueId
    );
  }, [appointment?.event_type_label, items, waiverSections, explicitWaiverByCatalogueId]);
  const waiverFlag = useMemo(
    () => summariseWaiverFlag(requiredSections, patientSignatures),
    [requiredSections, patientSignatures]
  );
  const sectionsToSign = useMemo<WaiverSection[]>(
    () =>
      requiredSections.filter(
        (s) => sectionSignatureState(s, patientSignatures) !== 'current'
      ),
    [requiredSections, patientSignatures]
  );

  // Compose the WaiverDocInput from the loaded visit / patient /
  // appointment / items / signatures. Memoised so opening and
  // closing the dialog doesn't rebuild the document HTML on every
  // render. Returns null until every dependency is loaded and at
  // least one of the visit's required sections has a matching
  // signed row from this patient. The View Waiver button is gated
  // on this not being null below.
  const waiverDoc = useMemo<WaiverDocInput | null>(() => {
    if (!visit || !patient) return null;
    if (!appointment?.appointment_ref) return null;
    if (requiredSections.length === 0) return null;

    // Pair each required section to the patient's most recent
    // signature for that section_key. Patients sign once per
    // section (at the current version) and the signature stays
    // valid until the section is re-versioned. A missing section
    // is dropped from the doc rather than throwing — staff can
    // still print/download a partial document for the sections
    // that were signed, and the WaiverCard already drives them
    // to sign anything outstanding.
    const matchedRows = requiredSections
      .map((section) => {
        const candidates = patientSignedRows.filter((r) => r.section_key === section.key);
        if (candidates.length === 0) return null;
        return candidates.reduce(
          (acc, r) => (r.signed_at > acc.signed_at ? r : acc),
          candidates[0]!,
        );
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (matchedRows.length === 0) return null;

    // Items: same filter as the LWO — anything the catalogue says
    // shouldn't print (e.g. impression-appointment placeholders) is
    // skipped. The waiver doc and the printed LWO must agree on
    // which work is being signed for.
    const docItems: WaiverDocItem[] = items
      .filter((it) => itemPrintsOnLwo(it))
      .map((it) => {
        const isDenture = it.service_type === 'denture_repair';
        const thicknessUpgrade = it.upgrades.find((u) => /\d+(?:\.\d+)?\s*mm/i.test(u.upgrade_name));
        const thickness = thicknessUpgrade
          ? thicknessUpgrade.upgrade_name.match(/\d+(?:\.\d+)?\s*mm/i)?.[0] ?? null
          : null;
        // Compose before/after_device upgrade names into the device
        // label. Thickness is still pulled out into its own column;
        // own_line upgrades fall back to after_device for the doc
        // (it has no per-row break-out today).
        const baseDevice = isDenture ? 'Denture' : it.name;
        const composed = composeUpgradeLabel(
          baseDevice,
          it.upgrades.filter((u) => !/\d+(?:\.\d+)?\s*mm/i.test(u.upgrade_name)),
          upgradePositionById
        );
        const device = composed.title + (composed.ownLines.length > 0 ? ', ' + composed.ownLines.join(', ') : '');
        return {
          qty: it.quantity,
          device,
          repairType: isDenture ? it.name : '',
          arch: it.arch,
          shade: it.shade,
          thickness,
          category: isDenture ? ('denture' as const) : ('appliance' as const),
          unitPricePence: it.unit_price_pence,
        };
      });

    // Signed sections — one row per lng_waiver_signatures with the
    // section title joined and frozen terms snapshot. Throw at
    // render time if any signature lacks its terms_snapshot
    // (legacy rows pre-snapshot column) so we never emit a
    // waiver document with empty terms.
    const docSections: WaiverDocSection[] = matchedRows.map((s) => {
      if (!s.terms_snapshot || s.terms_snapshot.length === 0) {
        // Surface as a thrown render error rather than a silent
        // empty section — admin can fix the underlying row.
        throw new Error(
          `Signed-waiver row ${s.id} has no terms_snapshot. Re-sign the section to refresh the snapshot before printing.`,
        );
      }
      return {
        title: s.section_title ?? s.section_key,
        version: s.section_version,
        terms: s.terms_snapshot,
        signedAt: s.signed_at,
        witnessName: s.witness_name,
      };
    });

    // Use the latest signature's SVG path for the document's
    // signature box. The audit table on PatientProfile keeps the
    // per-section originals; the printed/emailed document just
    // shows the most recent one. matchedRows.length === 0 was
    // ruled out at the top of the memo, so [0] is non-nullable.
    const seedSig = matchedRows[0]!;
    const latestSig = matchedRows.reduce((acc, s) => (s.signed_at > acc.signed_at ? s : acc), seedSig);

    return {
      lapRef: appointment.appointment_ref,
      // Visit type drives the page-1 hero deck ("following your in-person
      // impression appointment on …"). Falls back to null which makes the
      // hero use the simpler date-only deck.
      visitType: appointment.event_type_label ?? null,
      patient: {
        fullName: patientFullName(patient),
        dateOfBirth: patient.date_of_birth,
        sex: (patient as { sex?: string | null }).sex ?? null,
        email: patient.email,
        phone: patient.phone,
        addressLine1: (patient as { portal_ship_line1?: string | null }).portal_ship_line1 ?? null,
        addressLine2: (patient as { portal_ship_line2?: string | null }).portal_ship_line2 ?? null,
        city: (patient as { portal_ship_city?: string | null }).portal_ship_city ?? null,
        postcode: (patient as { portal_ship_postcode?: string | null }).portal_ship_postcode ?? null,
      },
      visitOpenedAt: visit.opened_at,
      // The receptionist who opened the visit witnesses the signature
      // on the patient's behalf. Surfaces only on the signature card,
      // not the visit summary metadata where a generic "Staff" field
      // would have meant nothing to the patient.
      witnessName: receptionistName,
      items: docItems,
      notes: visit.notes,
      sections: docSections,
      signatureSvg: latestSig?.signature_svg ?? null,
      // Payment: cart status + total once the till closes. Cart's
      // own status is the source of truth; nothing populated when
      // payment hasn't been taken yet.
      // Payment: cart status + total once the till closes. Deposit
      // (if a Calendly booking already collected one) is threaded
      // through so the waiver shows the same Subtotal / Deposit /
      // Total breakdown the rest of the app uses.
      payment:
        cart && cart.status === 'paid'
          ? {
              amountPence: cart.total_pence,
              method: 'card',
              takenAt: cart.closed_at ?? visit.opened_at,
              status: 'paid' as const,
              depositPence: deposit?.status === 'paid' ? deposit.pence : 0,
              depositProvider:
                deposit?.status === 'paid' ? deposit.provider : null,
            }
          : null,
      // Brand block is built here rather than read from the location
      // row because the lng_ schema doesn't yet carry a patient-facing
      // contact email or address. When that lands the values can move
      // to a useLocationForBrand() hook without touching the renderer.
      brand: {
        name: 'Venneir',
        // Customer service email — what the patient writes to with
        // questions about their visit. accounts@venneir.com is for
        // finance / invoicing only and is not the right contact
        // line for a customer-facing document.
        contactEmail: 'cs@venneir.com',
        vatNumber: 'GB406459983',
        logoUrl: window.location.origin + '/black-venneir-logo.png',
        addressLine: null,
      },
      accentColor: theme.color.accent,
    };
  }, [visit, patient, appointment, receptionistName, items, patientSignedRows, requiredSections, cart, deposit]);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  const subtotal = items.reduce((sum, i) => sum + i.line_total_pence, 0);
  const discount = items.reduce((sum, i) => sum + i.discount_pence, 0);
  // Only successful deposits credit the till. A failed deposit is shown
  // visually elsewhere; the bill still sums to the full subtotal.
  const depositPence = deposit?.status === 'paid' ? deposit.pence : 0;
  // Balance is what the receptionist will collect at the till after the
  // Calendly deposit is applied. Floor at 0 — manual PayPal refund handles
  // the over-deposit case so we never produce a negative charge here.
  const total = Math.max(0, subtotal - discount - depositPence);
  const cartLocked = cart?.status === 'paid' || cart?.status === 'voided';

  // Visits that have already terminated (complete / unsuitable /
  // cancelled) are read-only for unsuitability — no second mark.
  const visitTerminated =
    visit?.status === 'complete' || visit?.status === 'unsuitable' || visit?.status === 'cancelled';

  // Items that can be picked in the dropdown — only catalogue-backed
  // lines (ad-hoc rows have no catalogue_id and the schema requires
  // one). We surface them in the order they sit in the cart.
  const unsuitableEligibleItems = useMemo(
    () => items.filter((it): it is typeof it & { catalogue_id: string } => !!it.catalogue_id),
    [items]
  );
  const canMarkUnsuitable = !visitTerminated && unsuitableEligibleItems.length > 0;

  const openUnsuitable = () => {
    setUnsuitableError(null);
    setUnsuitableReason('');
    // Default-empty selection so staff has to consciously pick — no
    // chance of submitting against the wrong line through inertia.
    setUnsuitableCatalogueIds([]);
    setUnsuitableOpen(true);
  };

  // True when every catalogue-backed line on the visit has been
  // ticked. Submitting in this state ends the visit; the sheet warns
  // staff before they confirm.
  const unsuitableEndsVisit =
    unsuitableEligibleItems.length > 0 &&
    unsuitableCatalogueIds.length === unsuitableEligibleItems.length;

  const submitUnsuitable = async () => {
    if (!visit || !patient) return;
    if (unsuitableCatalogueIds.length === 0) {
      setUnsuitableError('Pick at least one product the patient was unsuitable for.');
      return;
    }
    if (unsuitableReason.trim().length === 0) {
      setUnsuitableError('A reason is required.');
      return;
    }
    setUnsuitableBusy(true);
    setUnsuitableError(null);
    try {
      await recordUnsuitability({
        patient_id: patient.id,
        visit_id: visit.id,
        catalogue_ids: unsuitableCatalogueIds,
        reason: unsuitableReason,
        endsVisit: unsuitableEndsVisit,
      });
      setUnsuitableOpen(false);
      refresh();
    } catch (e) {
      setUnsuitableError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setUnsuitableBusy(false);
    }
  };

  const openPicker = async () => {
    setError(null);
    try {
      const opened = await ensureOpen();
      if (!opened) throw new Error('Could not open cart');
      setPickerOpen(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    }
  };

  const inc = async (id: string, q: number) => {
    setBusyItem(id);
    try {
      await updateCartItemQuantity(id, q + 1);
      refresh();
    } finally {
      setBusyItem(null);
    }
  };
  const dec = async (id: string, q: number) => {
    setBusyItem(id);
    try {
      await updateCartItemQuantity(id, q - 1);
      refresh();
    } finally {
      setBusyItem(null);
    }
  };
  const rm = async (id: string) => {
    setBusyItem(id);
    try {
      await removeCartItem(id);
      refresh();
    } finally {
      setBusyItem(null);
    }
  };

  const openNoteEditor = () => {
    setNoteDraft(visit?.notes ?? '');
    setNoteError(null);
    setNoteOpen(true);
  };

  const saveNote = async () => {
    if (!visit) return;
    setNoteError(null);
    setNoteSaving(true);
    try {
      const trimmed = noteDraft.trim();
      // MAX_TECH_NOTE_LENGTH matches the LWO label's Notes box capacity
      // exactly. textarea maxLength stops typing past the limit, but
      // a paste can still overrun — we re-validate here and refuse
      // the save rather than emit a truncated label to the lab.
      if (trimmed.length > MAX_TECH_NOTE_LENGTH) {
        throw new Error(
          `Tech note is too long for the label (${trimmed.length} / ${MAX_TECH_NOTE_LENGTH}). Please trim and try again.`,
        );
      }
      const { error: err } = await supabase
        .from('lng_visits')
        .update({ notes: trimmed.length > 0 ? trimmed : null })
        .eq('id', visit.id);
      if (err) throw new Error(err.message);
      // Realtime subscription on lng_visits (filter id=eq.<visit>)
      // refreshes useVisitDetail; the dialog closes immediately.
      setNoteOpen(false);
    } catch (e: unknown) {
      setNoteError(e instanceof Error ? e.message : 'Could not save tech note.');
    } finally {
      setNoteSaving(false);
    }
  };

  const handlePrintLwo = () => {
    setError(null);
    if (!visit || !patient) {
      setError('Visit not loaded yet. Try again in a moment.');
      return;
    }
    if (!appointment?.appointment_ref) {
      // The LAP ref is stamped at intake-submit (lng_appointments.appointment_ref
      // for booked rows, lng_walk_ins.appointment_ref for walk-ins). If it
      // isn't there yet the visit was opened without going through arrival
      // intake — refuse to print rather than emit a label with a blank ref.
      setError(
        'No LAP reference on this visit. The lab work order can only print after arrival intake has stamped a reference.',
      );
      return;
    }
    // Catalogue.include_on_lwo gates per-line printing. Defaults to
    // true; impression-appointment rows are backfilled to false so
    // existing behaviour is preserved. Admin can flip the flag on
    // any other row from the catalogue editor.
    const printableItems = items
      .filter((it) => itemPrintsOnLwo(it))
      .map((it) => buildPrintableItem(it, upgradePositionById));

    if (printableItems.length === 0) {
      setError(
        'No printable work on this visit. Add at least one denture or appliance line. Impression appointments alone do not go to the lab.',
      );
      return;
    }

    try {
      printLwo({
        lapRef: appointment.appointment_ref,
        arrivalType: visit.arrival_type === 'walk_in' ? 'WALK-IN' : 'PRE-BOOKED',
        patientName: patientFullName(patient),
        jobBox: appointment.jb_ref ? `JB${appointment.jb_ref}` : null,
        staffName: receptionistName,
        checkedInAt: visit.opened_at,
        notes: visit.notes,
        items: printableItems,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not open the printable LWO.');
    }
  };

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: isMobile ? theme.space[4] : theme.space[6],
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + ${isMobile ? theme.space[4] : theme.space[6]}px + env(safe-area-inset-top, 0px))`,
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${isMobile ? theme.space[6] : theme.space[8]}px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div style={{ maxWidth: theme.layout.pageMaxWidth, margin: '0 auto' }}>
        <VisitBreadcrumbs visit={visit} patient={patient} />

        {loading ? (
          <p style={{ color: theme.color.inkMuted }}>Loading appointment…</p>
        ) : !visit ? (
          <EmptyState title="Appointment not found" description="That appointment no longer exists or you do not have access." />
        ) : (
          <>
            {/* Visit header. The previous version stacked
                  breadcrumb → "Walk-in · opened 17:48" → h1 → pills,
                which read as one cramped block with no air between
                breadcrumb and title and a redundant time line (the
                breadcrumb crumb already shows the timestamp). Now:
                title sits clean below the breadcrumb; arrival type
                joins the pills row alongside status and cart, so
                every meta atom lives in one consistent rhythm. */}
            <div style={{ marginBottom: theme.space[6] }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: theme.space[3],
                  flexWrap: 'wrap',
                  margin: `0 0 ${theme.space[3]}px`,
                }}
              >
                <h1
                  style={{
                    margin: 0,
                    fontSize: theme.type.size.xxl,
                    fontWeight: theme.type.weight.semibold,
                    letterSpacing: theme.type.tracking.tight,
                  }}
                >
                  {/* Title is the patient's name, full stop. The
                      visit's identity (booked / scheduled / arrived /
                      completed timestamps, refs, JB) lives in the
                      lifecycle strip + meta pills below — much
                      richer than packing the word "Appointment" into
                      the heading. Falls back to plain "Patient" when
                      the row hasn't resolved. */}
                  {patient ? patientFullName(patient) : 'Patient'}
                </h1>
                {patient ? (
                  <Button
                    variant="tertiary"
                    size="sm"
                    onClick={() =>
                      navigate(`/patient/${patient.id}`, {
                        state: {
                          from: 'visit',
                          visitId: visit.id,
                          visitOpenedAt: visit.opened_at,
                          // Preview name lets the profile's breadcrumb
                          // render the correct rightmost crumb on first
                          // paint, before its own patient query has
                          // resolved — kills the "Patient" → "Ewa Deb"
                          // flicker.
                          patientName: patientFullName(patient),
                          // Pass the visit's own entry state through so
                          // the profile breadcrumb can preserve the chain
                          // (Schedule / Patients / In clinic) and the
                          // visit-link can navigate back with that
                          // context intact.
                          visitEntry: location.state,
                        },
                      })
                    }
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                      View profile
                      <ChevronRight size={16} />
                    </span>
                  </Button>
                ) : null}
              </div>
              <LifecycleStrip
                arrivalType={visit.arrival_type}
                bookedAt={appointment?.created_at ?? null}
                bookingSource={appointment?.source ?? null}
                scheduledAt={appointment?.start_at ?? null}
                arrivedAt={visit.opened_at}
                completedAt={visit.closed_at}
              />
              <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap', marginTop: theme.space[4] }}>
                {showableRef(patient?.internal_ref) ? (
                  <MetaPill icon={<Hash size={12} />} tone="neutral" size="sm">
                    {patient!.internal_ref}
                  </MetaPill>
                ) : null}
                {appointment?.appointment_ref ? (
                  <MetaPill icon={<Hash size={12} />} tone="neutral" size="sm">
                    {appointment.appointment_ref}
                  </MetaPill>
                ) : null}
                {appointment?.jb_ref ? (
                  <MetaPill icon={<Box size={12} />} tone="neutral" size="sm">
                    JB{appointment.jb_ref}
                  </MetaPill>
                ) : null}
                <MetaPill
                  icon={visit.arrival_type === 'walk_in' ? <UserPlus size={12} /> : <CalendarCheck size={12} />}
                  tone="neutral"
                  size="sm"
                >
                  {visit.arrival_type === 'walk_in' ? 'Walk-in' : 'Scheduled'}
                </MetaPill>
                <MetaPill icon={visitStatusIcon(visit.status)} tone={visitStatusTone(visit.status)} size="sm">
                  {visitStatusLabel(visit.status)}
                </MetaPill>
                {cart ? (
                  <MetaPill
                    icon={cartStatusIcon(cart.status)}
                    tone={cart.status === 'paid' ? 'arrived' : cart.status === 'open' ? 'neutral' : 'no_show'}
                    size="sm"
                  >
                    {cartStatusLabel(cart.status)}
                  </MetaPill>
                ) : null}
              </div>
            </div>

            <WaiverCard
              flag={waiverFlag}
              requiredCount={requiredSections.length}
              schemaLoading={waiverSectionsLoading}
              schemaError={waiverSectionsError}
              schemaEmpty={!waiverSectionsLoading && !waiverSectionsError && waiverSections.length === 0}
              // Wait for both the patient row AND the signatures fetch
              // before resolving. Without the !patient gate the card
              // would briefly think "no patient = no signatures = needed"
              // and flip the moment the patient resolved. See
              // feedback_no_load_flicker.
              signaturesLoading={!patient || patientSignaturesLoading}
              onOpen={() => setWaiverOpen(true)}
              // Surface the "View" affordance only when a doc is
              // buildable — every required section has a matching
              // signature. The bottom action row used to host this
              // button; pulling it into the ready banner frees a
              // slot in that row.
              onView={waiverDoc ? () => setWaiverViewerOpen(true) : undefined}
            />

            <Card padding="lg">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: theme.space[4] }}>
                <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
                  Cart
                </h2>
                {items.length > 0 && !cartLocked ? (
                  <Button variant="secondary" size="sm" onClick={openPicker}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                      <Plus size={16} /> Add item
                    </span>
                  </Button>
                ) : null}
              </div>

              {cartLoading ? (
                <p style={{ color: theme.color.inkMuted }}>Loading cart…</p>
              ) : items.length === 0 ? (
                <EmptyState
                  icon={<ShoppingCart size={20} />}
                  title="No items yet"
                  description="Pick from the shared catalogue. Suggestions populate based on the booking type and intake answers."
                  action={
                    <Button variant="primary" onClick={openPicker} disabled={cartLocked}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                        <Plus size={16} /> Add item
                      </span>
                    </Button>
                  }
                />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
                  {items.map((it) => {
                    const composed = composeUpgradeLabel(it.name, it.upgrades, upgradePositionById);
                    return (
                      <CartLineItem
                        key={it.id}
                        name={composed.title}
                        description={cartItemSubtitle(it, composed.ownLines)}
                        quantity={it.quantity}
                        unitPricePence={it.unit_price_pence}
                        lineTotalPence={it.line_total_pence}
                        onIncrement={() => inc(it.id, it.quantity)}
                        onDecrement={() => dec(it.id, it.quantity)}
                        onRemove={() => rm(it.id)}
                        disabled={busyItem === it.id || cartLocked}
                        quantityEnabled={it.quantity_enabled}
                        thumbnailUrl={it.image_url}
                      />
                    );
                  })}
                </div>
              )}

              {items.length > 0 ? (
                <Totals
                  subtotal={subtotal}
                  discount={discount}
                  depositPence={depositPence}
                  depositProvider={deposit?.provider ?? null}
                  total={total}
                />
              ) : null}
            </Card>

            {items.length > 0 ? (
              <div style={{ marginTop: theme.space[6], display: 'flex', gap: theme.space[2], justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
                {canMarkUnsuitable ? (
                  <Button variant="tertiary" onClick={openUnsuitable}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                      <Ban size={16} aria-hidden />
                      Mark unsuitable
                    </span>
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={openNoteEditor}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                    <StickyNote size={16} aria-hidden />
                    {visit.notes && visit.notes.trim() ? 'Edit tech note' : 'Add tech note'}
                  </span>
                </Button>
                <Button
                  variant="secondary"
                  onClick={handlePrintLwo}
                  disabled={!appointment?.appointment_ref}
                  title={
                    appointment?.appointment_ref
                      ? undefined
                      : 'A LAP reference is stamped during arrival intake. Open arrival before printing.'
                  }
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                    <Printer size={16} aria-hidden />
                    Print LWO
                  </span>
                </Button>
                <Button
                  variant="primary"
                  showArrow
                  disabled={cartLocked}
                  onClick={() =>
                    navigate(`/visit/${visit.id}/pay`, {
                      state: {
                        from: 'visit',
                        visitId: visit.id,
                        visitOpenedAt: visit.opened_at,
                        // Pass the visit's own entry through so Pay's
                        // breadcrumb can render the full chain and the
                        // visit-link can pop back with the right state.
                        visitEntry: location.state,
                      },
                    })
                  }
                >
                  Take payment {formatPence(total)}
                </Button>
              </div>
            ) : null}

            {patient ? (
              <>
                {/* Hairline break splits the cart / payment block from the
                    media block below so the eye reads the page as two
                    distinct sections instead of one long scroll. */}
                <hr
                  style={{
                    margin: `${theme.space[6]}px 0 0`,
                    border: 'none',
                    borderTop: `1px solid ${theme.color.border}`,
                  }}
                />
                <div style={{ marginTop: theme.space[6], display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
                  <BeforeAfterGallery
                    patient={patient}
                    files={galleryFiles}
                    loading={galleryFilesLoading}
                    refresh={refreshGalleryFiles}
                    isMobile={isMobile}
                  />
                  <MarketingGallery
                    patient={patient}
                    files={galleryFiles}
                    loading={galleryFilesLoading}
                    refresh={refreshGalleryFiles}
                    isMobile={isMobile}
                  />
                  <VisitTimeline visitId={visit.id} />
                </div>
              </>
            ) : null}

          </>
        )}
      </div>

      {error ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone="error" title="Could not save" description={error} duration={6000} onDismiss={() => setError(null)} />
        </div>
      ) : null}

      <CataloguePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        cartId={cart?.id ?? null}
        intake={appointment?.intake ?? null}
        eventTypeLabel={appointment?.event_type_label ?? null}
        onItemAdded={refresh}
      />

      <WaiverSheet
        open={waiverOpen}
        onClose={() => setWaiverOpen(false)}
        patientId={patient?.id ?? null}
        visitId={visit?.id ?? null}
        sections={sectionsToSign}
        patientName={patient ? patientFullName(patient) : 'Patient'}
        defaultWitnessName={receptionistName ?? ''}
        onAllSigned={refreshSignatures}
      />

      <WaiverViewerDialog
        open={waiverViewerOpen}
        onClose={() => setWaiverViewerOpen(false)}
        doc={waiverDoc}
        visitId={visit?.id ?? null}
        patientEmail={patient?.email ?? null}
      />

      <Dialog
        open={noteOpen}
        onClose={() => !noteSaving && setNoteOpen(false)}
        title="Tech note for the lab"
        description="This prints on the LWO."
        width={560}
        dismissable={!noteSaving}
        footer={
          <div
            style={{
              display: 'flex',
              gap: theme.space[3],
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            {/* Clear sits on the left so it reads as a destructive
                action away from the primary save. Disabled when the
                draft is already empty so the affordance only appears
                when there's something to clear. */}
            <Button
              variant="tertiary"
              onClick={() => setNoteDraft('')}
              disabled={noteSaving || noteDraft.length === 0}
            >
              Clear
            </Button>
            <div style={{ display: 'flex', gap: theme.space[3] }}>
              <Button variant="secondary" onClick={() => setNoteOpen(false)} disabled={noteSaving}>
                Cancel
              </Button>
              <Button variant="primary" onClick={saveNote} loading={noteSaving}>
                Save
              </Button>
            </div>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          <textarea
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            rows={5}
            // maxLength stops typing past the label's capacity. Paste
            // events can still overrun in some browsers, so saveNote
            // re-validates server-side-style and throws.
            maxLength={MAX_TECH_NOTE_LENGTH}
            placeholder="Anything the lab needs (shade clarification, urgency, special handling). Leave blank to clear."
            style={{
              width: '100%',
              minHeight: 120,
              padding: theme.space[3],
              borderRadius: theme.radius.input,
              border: `1px solid ${theme.color.border}`,
              background: theme.color.surface,
              color: theme.color.ink,
              fontFamily: 'inherit',
              fontSize: theme.type.size.base,
              lineHeight: 1.5,
              resize: 'vertical',
              outline: 'none',
            }}
          />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
            }}
          >
            <span>Keep it short. The label is small.</span>
            <span
              aria-live="polite"
              style={{
                fontVariantNumeric: 'tabular-nums',
                color:
                  noteDraft.length >= MAX_TECH_NOTE_LENGTH
                    ? theme.color.alert
                    : noteDraft.length >= MAX_TECH_NOTE_LENGTH * 0.9
                      ? theme.color.warn
                      : theme.color.inkMuted,
                fontWeight:
                  noteDraft.length >= MAX_TECH_NOTE_LENGTH * 0.9
                    ? theme.type.weight.semibold
                    : theme.type.weight.regular,
              }}
            >
              {noteDraft.length} / {MAX_TECH_NOTE_LENGTH}
            </span>
          </div>
          {noteError ? (
            <div
              role="alert"
              style={{
                padding: theme.space[3],
                borderRadius: theme.radius.input,
                background: theme.color.alert,
                color: theme.color.surface,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
              }}
            >
              {noteError}
            </div>
          ) : null}
        </div>
      </Dialog>

      {/* Mark unsuitable sheet. Required reason + product dropdown
          (cart catalogue items only). Submit terminates the visit. */}
      <BottomSheet
        open={unsuitableOpen}
        onClose={() => !unsuitableBusy && setUnsuitableOpen(false)}
        dismissable={!unsuitableBusy}
        title="Mark patient unsuitable"
        description={
          unsuitableEndsVisit
            ? 'Every product on this visit will be marked unsuitable. The visit ends here. Only an admin can reverse it.'
            : 'Captured for the patient timeline. The visit stays open for the products you don’t tick, so the rest can still be paid for.'
        }
        footer={
          <div
            style={{
              display: 'flex',
              gap: theme.space[3],
              justifyContent: 'flex-end',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Button variant="secondary" onClick={() => setUnsuitableOpen(false)} disabled={unsuitableBusy}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <X size={16} aria-hidden /> Cancel
              </span>
            </Button>
            <Button variant="primary" onClick={submitUnsuitable} loading={unsuitableBusy}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Ban size={16} aria-hidden />
                {unsuitableEndsVisit ? 'Mark unsuitable & end visit' : 'Mark unsuitable'}
              </span>
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          {/* Multi-select dropdown for the basket items the patient is
              unsuitable for. Same reason applies to every ticked
              product (one submit = one record per ticked product). */}
          <MultiSelectDropdown<string>
            label="Products"
            required
            values={unsuitableCatalogueIds}
            options={unsuitableEligibleItems.map((it) => ({
              value: it.catalogue_id,
              label: it.name,
            }))}
            onChange={(next) => setUnsuitableCatalogueIds(next)}
            placeholder="Pick from the basket"
            totalNoun="products"
          />

          {unsuitableEndsVisit ? (
            <div
              role="status"
              style={{
                display: 'inline-flex',
                alignItems: 'flex-start',
                gap: theme.space[2],
                padding: theme.space[3],
                borderRadius: theme.radius.input,
                background: 'rgba(179, 104, 21, 0.08)',
                color: theme.color.warn,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
              }}
            >
              <AlertTriangle size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                All basket items are selected. Submitting will end the visit. The patient won’t be charged for
                these lines and the visit drops off the in-clinic board.
              </span>
            </div>
          ) : null}

          <label style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            <span
              style={{
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
                fontWeight: theme.type.weight.medium,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
              }}
            >
              Reason <span style={{ color: theme.color.alert }}>*</span>
            </span>
            <textarea
              value={unsuitableReason}
              onChange={(e) => setUnsuitableReason(e.target.value)}
              rows={5}
              placeholder="Why is the patient unsuitable for these products? Be specific. This lands on the patient timeline."
              style={{
                width: '100%',
                padding: theme.space[3],
                fontSize: theme.type.size.base,
                fontFamily: 'inherit',
                lineHeight: theme.type.leading.normal,
                color: theme.color.ink,
                background: theme.color.surface,
                border: `1px solid ${theme.color.border}`,
                borderRadius: theme.radius.input,
                resize: 'vertical',
                minHeight: 120,
              }}
            />
          </label>

          {unsuitableError ? (
            <p
              role="alert"
              style={{
                margin: 0,
                color: theme.color.alert,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
              }}
            >
              {unsuitableError}
            </p>
          ) : null}
        </div>
      </BottomSheet>
    </main>
  );
}

// Renders the breadcrumb trail at the top of the visit page. The path
// depends on how the receptionist arrived: from a patient profile we
// show "Patients › Name › Visit"; from the schedule (default) we show
// "Schedule › Visit". The entry hint comes through router state set
// by the caller (see PatientProfile.openVisit). When state is missing
// — direct URL paste, browser refresh — we fall back to the schedule
// trail so the leftmost crumb still navigates somewhere sensible.
interface VisitEntryState {
  from?: 'patient' | 'schedule' | 'in_clinic';
  patientId?: string;
  patientName?: string;
  // Optional preview of the visit's opened-at timestamp. When the
  // caller already has it (e.g. PatientProfile's appointments list),
  // forwarding it lets the breadcrumb render the full "Appointment,
  // 29 Apr, 21:43" label on first paint instead of a shimmer.
  visitOpenedAt?: string;
}

function VisitBreadcrumbs({
  visit,
  patient,
}: {
  visit: { opened_at: string } | null;
  patient: { id: string; first_name: string; last_name: string } | null;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const entry = (location.state as VisitEntryState | null) ?? {};

  // Visit-crumb label. Two sources for the open time (live row,
  // then router-state preview), two for the patient name (live,
  // then preview). Both go through formatVisitCrumb, which decides
  // whether to include "[Name]'s " based on whether a separate
  // patient crumb is already in the chain — avoids "Patients ›
  // Ewa Deb › Ewa Deb's Appt. 29 Apr" redundancy.
  const visitOpenedAt = visit?.opened_at ?? entry.visitOpenedAt ?? null;
  const livePatientName = patient ? patientFullName(patient) : '';
  const previewPatientName = entry.patientName?.trim() ?? '';
  const resolvedPatientName = livePatientName || previewPatientName || '';

  const buildVisitLabel = (includeName: boolean): ReactNode => {
    if (!visitOpenedAt) return <VisitLabelSkeleton />;
    return formatVisitCrumb({
      name: resolvedPatientName,
      openedAtIso: visitOpenedAt,
      includeName,
    });
  };

  // Patient crumb label (only rendered in chains that include a
  // separate patient step). Live > preview > skeleton.
  const patientNameLabel: ReactNode =
    livePatientName || previewPatientName || <PatientNameSkeleton />;

  const items = (() => {
    if (entry.from === 'patient' && entry.patientId) {
      // Patients › Ewa Deb › Appt. 29 Apr — name shown by the
      // middle crumb, so the visit crumb stays compact.
      return [
        { label: 'Patients', onClick: () => navigate('/patients') },
        {
          label: patientNameLabel,
          onClick: () =>
            navigate(`/patient/${entry.patientId}`, {
              state: { patientName: livePatientName || previewPatientName },
            }),
        },
        { label: buildVisitLabel(false) },
      ];
    }
    if (entry.from === 'in_clinic') {
      // In clinic › Ewa Deb's Appt. 29 Apr — no separate patient
      // crumb, so the visit crumb takes ownership of the identity.
      return [
        { label: 'In clinic', onClick: () => navigate('/in-clinic') },
        { label: buildVisitLabel(true) },
      ];
    }
    // 'schedule' or no hint — default trail. Patient crumb renders
    // when we have any identity to link to.
    if (patient) {
      return [
        { label: 'Schedule', onClick: () => navigate('/schedule') },
        {
          label: patientNameLabel,
          onClick: () =>
            navigate(`/patient/${patient.id}`, {
              state: { patientName: livePatientName },
            }),
        },
        { label: buildVisitLabel(false) },
      ];
    }
    // No patient row yet — fold the (preview) name into the visit
    // crumb so the receptionist isn't staring at a bare "Appt." while
    // the page resolves.
    return [
      { label: 'Schedule', onClick: () => navigate('/schedule') },
      { label: buildVisitLabel(true) },
    ];
  })();

  return (
    <div style={{ margin: `${theme.space[3]}px 0 ${theme.space[6]}px` }}>
      <Breadcrumb items={items} />
    </div>
  );
}

// Inline shimmers used as crumb labels while the underlying row is
// in flight. Width ≈ a typical two-word patient name / a typical
// visit-label string, so the chevrons don't reflow when the real
// content lands.
function PatientNameSkeleton() {
  return (
    <>
      <span
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
          borderWidth: 0,
        }}
      >
        Loading patient name
      </span>
      <Skeleton width={96} height={14} radius={4} />
    </>
  );
}

function VisitLabelSkeleton() {
  return (
    <>
      <span
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
          borderWidth: 0,
        }}
      >
        Loading appointment timestamp
      </span>
      <Skeleton width={160} height={14} radius={4} />
    </>
  );
}

// Waiver surface for the visit page. Always visible — the receptionist
// should never have to wonder whether a waiver is needed for this
// patient. Five states drive the layout:
//
//   loading      → schema is being fetched; muted neutral skeleton row
//   error        → query failed; alert-coloured banner with the message
//   schemaEmpty  → no sections seeded (migration didn't take); warning
//                  banner pointing at the cause
//   needs        → one or more required sections missing/stale; red
//                  border + "Sign waiver" / "Re-sign" CTA
//   ready        → all required sections current; quiet ink-tinted
//                  confirmation row, no border
//
// Previously this rendered nothing when `requiredSections.length === 0`,
// which silently hid the entire feature when the schema didn't load —
// staff thought the waiver flow was missing. The five-state model
// makes the system's status legible at all times.
function WaiverCard({
  flag,
  requiredCount,
  schemaLoading,
  schemaError,
  schemaEmpty,
  signaturesLoading,
  onOpen,
  onView,
}: {
  flag: ReturnType<typeof summariseWaiverFlag>;
  requiredCount: number;
  schemaLoading: boolean;
  schemaError: string | null;
  schemaEmpty: boolean;
  // True until the patient's signatures have been fetched. We must
  // wait for both this AND the schema before rendering the resolved
  // status; otherwise the card would briefly show "Waiver needed"
  // (the default for "no signatures yet") and flip to "signed and up
  // to date" the instant the signatures landed — a classic flicker
  // that makes the surface feel broken. See feedback_no_load_flicker.
  signaturesLoading: boolean;
  onOpen: () => void;
  // Optional: when supplied, the ready-state banner renders a "View"
  // button that opens the printable waiver dialog. Caller passes this
  // only when a doc is actually buildable (every required section has
  // a matching signature) so we don't surface a disabled action.
  onView?: () => void;
}) {
  const wrapStyle = (border: string): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: theme.space[3],
    padding: `${theme.space[4]}px ${theme.space[4]}px`,
    marginBottom: theme.space[5],
    borderRadius: theme.radius.input,
    background: theme.color.surface,
    border: `1px solid ${border}`,
  });

  if (schemaLoading || signaturesLoading) {
    return (
      <div style={wrapStyle(theme.color.border)}>
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          Loading waiver…
        </span>
      </div>
    );
  }

  if (schemaError) {
    return (
      <div role="alert" style={wrapStyle(theme.color.alert)}>
        <WaiverBadge tone="alert" icon={<AlertTriangle size={22} />} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.alert }}>
            Waiver unavailable
          </p>
          <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
            {schemaError}
          </p>
        </div>
      </div>
    );
  }

  if (schemaEmpty) {
    // Schema query succeeded but no rows. Either the migration's
    // seed insert didn't run on this DB, or all sections are
    // inactive. Either way, the waiver flow can't proceed; be
    // explicit about it instead of failing silent.
    return (
      <div role="alert" style={wrapStyle(theme.color.warn)}>
        <WaiverBadge tone="warn" icon={<AlertTriangle size={22} />} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.warn }}>
            Waiver not configured
          </p>
          <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
            No active waiver sections found. Apply the lng_waiver migration or re-seed lng_waiver_sections.
          </p>
        </div>
      </div>
    );
  }

  // Schema loaded with rows but nothing required for this visit.
  // 'general' is always required so this branch is rare in practice
  // (would only hit if every section were marked inactive). Stay
  // visible so the absence of a CTA reads as deliberate.
  if (requiredCount === 0) {
    return (
      <div style={wrapStyle(theme.color.border)}>
        <WaiverBadge tone="muted" icon={<CheckCircle2 size={22} />} />
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          No waiver required for this visit.
        </span>
      </div>
    );
  }

  if (flag.status === 'ready') {
    return (
      <div style={wrapStyle(theme.color.border)}>
        <WaiverBadge tone="accent" icon={<CheckCircle2 size={22} />} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
            Waiver signed and up to date
          </p>
          <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
            Every required section is current.
          </p>
        </div>
        {onView ? (
          <Button variant="secondary" size="sm" onClick={onView}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <FileText size={14} aria-hidden /> View
            </span>
          </Button>
        ) : null}
      </div>
    );
  }

  const title =
    flag.status === 'stale'
      ? 'Waiver needs re-signing'
      : flag.status === 'partial'
        ? 'Waiver partially signed'
        : 'Waiver needed';
  const body = composeBannerBody(flag);
  const ctaLabel = flag.status === 'stale' ? 'Re-sign waiver' : 'Sign waiver';

  return (
    <div role="alert" style={wrapStyle(theme.color.alert)}>
      <WaiverBadge tone="alert" icon={<AlertTriangle size={22} />} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.alert }}>
          {title}
        </p>
        <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          {body}
        </p>
      </div>
      <Button variant="primary" size="sm" onClick={onOpen}>
        {ctaLabel}
      </Button>
    </div>
  );
}

// Circular icon badge used by the WaiverCard header. Tinted background
// gives the leading icon enough visual weight to read as a status badge
// rather than a punctuation glyph next to the title.
type WaiverBadgeTone = 'accent' | 'alert' | 'warn' | 'muted';
function WaiverBadge({ tone, icon }: { tone: WaiverBadgeTone; icon: React.ReactNode }) {
  const palette: Record<WaiverBadgeTone, { bg: string; fg: string }> = {
    accent: { bg: theme.color.accentBg, fg: theme.color.accent },
    alert: { bg: 'rgba(184, 58, 42, 0.10)', fg: theme.color.alert },
    warn: { bg: 'rgba(179, 104, 21, 0.10)', fg: theme.color.warn },
    muted: { bg: theme.color.bg, fg: theme.color.inkSubtle },
  };
  const { bg, fg } = palette[tone];
  return (
    <span
      aria-hidden
      style={{
        flexShrink: 0,
        width: 40,
        height: 40,
        borderRadius: '50%',
        background: bg,
        color: fg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {icon}
    </span>
  );
}

// LifecycleStrip — chronological breadcrumb of the appointment's
// real-world milestones (when it was booked → scheduled to start →
// patient arrived → all done). Lives directly under the patient h1
// so the visit page reads top-down as a record of the appointment,
// not just an EPOS surface.
//
// Lines render only when the underlying timestamp exists:
//   • Booked / Scheduled — only for `arrival_type === 'scheduled'`.
//     Walk-ins have no booking lifecycle; surfacing those rows
//     would just point at the arrival timestamp twice.
//   • Arrived — always (visit.opened_at is non-null by definition).
//   • Completed — only when the visit is closed.
//
// Each line is label + datetime, dot-aligned via a fixed-width
// label column. Reads cleanly in either order: scan labels on the
// left or scan times on the right.
function LifecycleStrip({
  arrivalType,
  bookedAt,
  bookingSource,
  scheduledAt,
  arrivedAt,
  completedAt,
}: {
  arrivalType: 'walk_in' | 'scheduled';
  bookedAt: string | null;
  bookingSource: string | null;
  scheduledAt: string | null;
  arrivedAt: string;
  completedAt: string | null;
}) {
  const isScheduled = arrivalType === 'scheduled';
  const bookedLabel =
    bookingSource === 'calendly' ? 'Booked on Calendly' : 'Booked';
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'max-content 1fr',
        columnGap: theme.space[4],
        rowGap: theme.space[1],
        margin: 0,
      }}
    >
      {isScheduled && bookedAt ? (
        <LifecycleLine label={bookedLabel} iso={bookedAt} />
      ) : null}
      {isScheduled && scheduledAt ? (
        <LifecycleLine label="Scheduled" iso={scheduledAt} />
      ) : null}
      <LifecycleLine label="Arrived" iso={arrivedAt} />
      {completedAt ? <LifecycleLine label="Completed" iso={completedAt} /> : null}
    </dl>
  );
}

function LifecycleLine({ label, iso }: { label: string; iso: string }) {
  return (
    <>
      <dt
        style={{
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.inkMuted,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
          alignSelf: 'baseline',
          paddingTop: 2,
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatLifecycle(iso)}
      </dd>
    </>
  );
}

function formatLifecycle(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} at ${time}`;
}

// MetaPill — visit-header chip with a leading icon. Wraps StatusPill
// so the colour tones stay consistent with every other status pill in
// the app, but the icon turns enum keys ("Walk-in", "Opened",
// "Cart open") into glanceable badges instead of bare text.
function MetaPill({
  icon,
  tone,
  size,
  children,
}: {
  icon: React.ReactNode;
  tone: 'neutral' | 'arrived' | 'in_progress' | 'complete' | 'no_show' | 'cancelled';
  size?: 'sm' | 'md';
  children: React.ReactNode;
}) {
  return (
    <StatusPill tone={tone} size={size}>
      <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center' }}>
        {icon}
      </span>
      {children}
    </StatusPill>
  );
}

// Filters out internal placeholders and empty refs. Anything starting
// with "__" or empty is treated as not-yet-resolved and hidden from
// the UI rather than rendered as raw plumbing.
function showableRef(value: string | null | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('__')) return false;
  return true;
}

function visitStatusIcon(s: 'opened' | 'in_progress' | 'complete' | 'cancelled' | 'unsuitable') {
  switch (s) {
    case 'opened':
      return <Circle size={12} />;
    case 'in_progress':
      return <Loader2 size={12} />;
    case 'complete':
      return <CheckCircle size={12} />;
    case 'cancelled':
      return <CircleSlash size={12} />;
    case 'unsuitable':
      return <Ban size={12} />;
  }
}

function cartStatusIcon(s: 'open' | 'paid' | 'voided') {
  switch (s) {
    case 'open':
      return <ShoppingCart size={12} />;
    case 'paid':
      return <CreditCard size={12} />;
    case 'voided':
      return <CircleSlash size={12} />;
  }
}

// Visit-status helpers. The DB stores the raw enum (opened /
// in_progress / complete / cancelled); the UI shows humanised copy
// to match the other status pills in the app.
function visitStatusLabel(s: 'opened' | 'in_progress' | 'complete' | 'cancelled' | 'unsuitable'): string {
  switch (s) {
    case 'opened':
      return 'Opened';
    case 'in_progress':
      return 'In progress';
    case 'complete':
      return 'Complete';
    case 'cancelled':
      return 'Cancelled';
    case 'unsuitable':
      return 'Unsuitable';
  }
}
function visitStatusTone(s: 'opened' | 'in_progress' | 'complete' | 'cancelled' | 'unsuitable') {
  switch (s) {
    case 'opened':
      return 'in_progress' as const;
    case 'in_progress':
      return 'in_progress' as const;
    case 'complete':
      return 'complete' as const;
    case 'cancelled':
      return 'cancelled' as const;
    case 'unsuitable':
      return 'cancelled' as const;
  }
}
function cartStatusLabel(s: 'open' | 'paid' | 'voided'): string {
  switch (s) {
    case 'open':
      return 'Cart open';
    case 'paid':
      return 'Cart paid';
    case 'voided':
      return 'Cart voided';
  }
}

function composeBannerBody(flag: ReturnType<typeof summariseWaiverFlag>): string {
  const parts: string[] = [];
  if (flag.missingSections.length > 0) {
    parts.push(
      `Missing: ${flag.missingSections.map((s) => s.title).join(', ')}`
    );
  }
  if (flag.staleSections.length > 0) {
    parts.push(
      `Re-sign: ${flag.staleSections.map((s) => s.title).join(', ')}`
    );
  }
  return parts.join(' · ');
}

// Compose a one-line subtitle for a cart item using the catalogue
// snapshot — arch / shade / notes / upgrades — so the receptionist
// sees what was configured without opening the row. Upgrade prices
// are already baked into unit_price_pence; this is name-only.
// Map one cart line to the printable LWO item shape. Rules ported
// 1:1 from Checkpoint's parseRepairNotes:
//
//   - service_type === 'denture_repair'  → category 'denture'.
//     The Device column is literally "Denture"; the row's catalogue
//     name (e.g. "Broken tooth on denture") goes in the Repair Type
//     column. Lounge's catalogue rename moved this from "Broken
//     tooth" so it reads on its own; the print stays in lockstep.
//   - everything else                    → category 'appliance'.
//     The Device column carries the catalogue name and Repair Type
//     stays empty (the column itself is hidden when no row has one).
//
// Thickness is sourced from the per-line upgrades — the catalogue
// upgrade names (e.g. "Thicker 1.5mm") carry their own millimetre
// suffix, so we just pick the first one whose name ends in "mm".
function buildPrintableItem(
  item: {
    name: string;
    service_type: string | null;
    arch: 'upper' | 'lower' | 'both' | null;
    shade: string | null;
    quantity: number;
    upgrades: { upgrade_id: string | null; upgrade_name: string }[];
  },
  upgradePositionById: Map<string, UpgradeDisplayPosition>
): PrintableLwoItem {
  const isDenture = item.service_type === 'denture_repair';
  const thicknessUpgrade = item.upgrades.find((u) => /\d+(?:\.\d+)?\s*mm/i.test(u.upgrade_name));
  const thickness = thicknessUpgrade
    ? thicknessUpgrade.upgrade_name.match(/\d+(?:\.\d+)?\s*mm/i)?.[0] ?? null
    : null;
  // Compose before/after_device upgrade names into the Device column.
  // Thickness is excluded — it has its own column. own_line upgrades
  // fall back to after_device for the LWO label (the layout is
  // fixed-column thermal print; restructuring is a follow-up).
  const baseDevice = isDenture ? 'Denture' : item.name;
  const composed = composeUpgradeLabel(
    baseDevice,
    item.upgrades.filter((u) => !/\d+(?:\.\d+)?\s*mm/i.test(u.upgrade_name)),
    upgradePositionById
  );
  const device = composed.title + (composed.ownLines.length > 0 ? ', ' + composed.ownLines.join(', ') : '');
  return {
    qty: item.quantity,
    device,
    repairType: isDenture ? item.name : '',
    arch: item.arch,
    shade: item.shade,
    thickness,
    category: isDenture ? 'denture' : 'appliance',
  };
}

// Cart line subtitle. Upgrades flagged display_position='own_line' are
// passed in as `ownLines` and rendered as their own ` · ` segments;
// before/after_device upgrades are already merged into the title by
// composeUpgradeLabel and don't appear here.
function cartItemSubtitle(
  item: {
    description: string | null;
    arch: 'upper' | 'lower' | 'both' | null;
    shade: string | null;
    notes: string | null;
  },
  ownLines: string[]
): string | null {
  const parts: string[] = [];
  if (item.arch === 'upper') parts.push('Upper');
  else if (item.arch === 'lower') parts.push('Lower');
  else if (item.arch === 'both') parts.push('Upper and lower');
  if (item.shade) parts.push(`shade ${item.shade}`);
  if (item.notes) parts.push(item.notes);
  for (const name of ownLines) parts.push(name);
  if (parts.length > 0) return parts.join(' · ');
  return item.description;
}

function Totals({
  subtotal,
  discount,
  depositPence,
  depositProvider,
  total,
}: {
  subtotal: number;
  discount: number;
  depositPence: number;
  depositProvider: 'paypal' | 'stripe' | null;
  total: number;
}) {
  return (
    <div
      style={{
        marginTop: theme.space[6],
        paddingTop: theme.space[5],
        borderTop: `1px solid ${theme.color.border}`,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
      }}
    >
      <Row label="Subtotal" value={formatPence(subtotal)} />
      {discount > 0 ? <Row label="Discount" value={`-${formatPence(discount)}`} /> : null}
      {depositPence > 0 ? (
        <Row
          label={`Deposit (${depositProvider === 'stripe' ? 'Stripe' : 'PayPal'} via Calendly)`}
          value={`-${formatPence(depositPence)}`}
          accent
        />
      ) : null}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          paddingTop: theme.space[3],
          marginTop: theme.space[2],
          borderTop: `1px solid ${theme.color.border}`,
        }}
      >
        <span style={{ fontSize: theme.type.size.md, color: theme.color.ink, fontWeight: theme.type.weight.semibold }}>
          {depositPence > 0 ? 'To collect' : 'Total'}
        </span>
        <span style={{ fontSize: theme.type.size.xxl, fontWeight: theme.type.weight.semibold, color: theme.color.ink, fontVariantNumeric: 'tabular-nums' }}>
          {formatPence(total)}
        </span>
      </div>
    </div>
  );
}

function Row({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>{label}</span>
      <span
        style={{
          color: accent ? theme.color.accent : theme.color.ink,
          fontVariantNumeric: 'tabular-nums',
          fontSize: theme.type.size.base,
          fontWeight: accent ? theme.type.weight.semibold : theme.type.weight.regular,
        }}
      >
        {value}
      </span>
    </div>
  );
}
