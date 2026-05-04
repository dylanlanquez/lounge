import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CheckCircle,
  ChevronRight,
  FileText,
  Plus,
  Printer,
  RotateCcw,
  ShoppingCart,
  StickyNote,
  X,
} from 'lucide-react';
import {
  AppointmentHero,
  type AppointmentHeroPill,
  type AppointmentHeroProps,
  type AppointmentHeroTone,
  BeforeAfterGallery,
  BottomSheet,
  Breadcrumb,
  Button,
  Card,
  DropdownSelect,
  EmptyState,
  Input,
  MarketingGallery,
  MultiSelectDropdown,
  Skeleton,
  Toast,
  VisitTimeline,
  WaiverSheet,
} from '../components/index.ts';
import { WaiverViewerDialog } from '../components/WaiverViewerDialog/WaiverViewerDialog.tsx';
import { supabase } from '../lib/supabase.ts';
import { useSignedWaivers } from '../lib/queries/waiver.ts';
import type { WaiverDocInput, WaiverDocItem, WaiverDocSection } from '../lib/waiverDocument.ts';
import { humaniseEventTypeLabel, usePatientProfileFiles } from '../lib/queries/patientProfile.ts';
import {
  formatDateLongOrdinal,
  formatTime,
  formatTimeRange,
  relativeMinutes,
} from '../lib/dateFormat.ts';
import { CartLineItem } from '../components/CartLineItem/CartLineItem.tsx';
import { CataloguePicker } from '../components/CataloguePicker/CataloguePicker.tsx';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useCurrentAccount } from '../lib/queries/currentAccount.ts';
import { useIsMobile } from '../lib/useIsMobile.ts';
import {
  completeVisit,
  endVisitEarly,
  formatVisitCrumb,
  removeCartLineWithReason,
  reverseUnsuitability,
  useLatestUnsuitability,
  useVisitDetail,
} from '../lib/queries/visits.ts';
import type {
  VisitAppointmentContext,
  VisitEndReason,
  VisitRow,
} from '../lib/queries/visits.ts';
import type { PatientRow } from '../lib/queries/patients.ts';
import {
  amendCartDiscount,
  applyCartDiscount,
  listManagers,
  removeCartDiscount,
  setManagerEmailLookup,
  useActiveCartDiscount,
  type ManagerRow,
} from '../lib/queries/cartDiscounts.ts';
import { patientFullName } from '../lib/queries/patients.ts';
import {
  formatPence,
  updateCartItemQuantity,
  useCart,
} from '../lib/queries/carts.ts';
import { useCatalogueActive } from '../lib/queries/catalogue.ts';
import {
  composeUpgradeLabel,
  useAllActiveUpgrades,
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
  const { account: currentAccount } = useCurrentAccount();
  const navigate = useNavigate();
  const location = useLocation();
  const { visit, patient, deposit, appointment, receptionistName, loading } = useVisitDetail(id);
  const { data: galleryFiles, loading: galleryFilesLoading, refresh: refreshGalleryFiles } =
    usePatientProfileFiles(patient?.id ?? null);
  const { cart, items, loading: cartLoading, refresh, ensureOpen } = useCart(id);
  const { active: activeDiscount, refresh: refreshDiscount } = useActiveCartDiscount(cart?.id ?? null);
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
  // Live id → display_position lookup so cart subtitle + LWO can place
  // each upgrade where admin wants it. Upgrades are now per-product, but
  // this map is just by id so a flat fetch of all active rows is fine.
  const { rows: upgradeRows } = useAllActiveUpgrades();
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
  // visit by flipping status to 'unsuitable' iff the cart ends empty
  // and the removal was unsuitable (handled by removeCartLineWithReason).
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeItemId, setRemoveItemId] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState<'mistake' | 'changed_mind' | 'unsuitable'>('mistake');
  const [removeNote, setRemoveNote] = useState('');
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // "End visit early" sheet — visible CTA on the action row for
  // closing out a visit before the till. Reason picker (5 cards):
  //   unsuitable        → reveals product picker; loops removeCartLineWithReason
  //   patient_declined  → endVisitEarly with note
  //   patient_walked_out→ endVisitEarly with note
  //   wrong_booking     → endVisitEarly with note
  //   other             → endVisitEarly with note
  const [unsuitOpen, setUnsuitOpen] = useState(false);
  const [endReason, setEndReason] = useState<VisitEndReason>('unsuitable');
  const [unsuitItemIds, setUnsuitItemIds] = useState<string[]>([]);
  const [unsuitNote, setUnsuitNote] = useState('');
  const [unsuitBusy, setUnsuitBusy] = useState(false);
  const [unsuitError, setUnsuitError] = useState<string | null>(null);

  // Complete visit sheet — fires when staff hits the primary CTA on
  // a free visit or paid-cart visit. Asks the fulfilment question
  // (in person vs shipping) and writes the choice onto the visit row
  // via completeVisit. Shipping branch surfaces a follow-up notice;
  // the actual dispatch flow is a separate slice.
  const [completeOpen, setCompleteOpen] = useState(false);
  const [completeMethod, setCompleteMethod] = useState<'in_person' | 'shipping'>('in_person');
  const [completeBusy, setCompleteBusy] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  // Cart-level discount state. Apply / Remove share the same sheet
  // shape — picker for the manager, password for the manager,
  // reason text. Manager re-auths via approveAsManager (parallel
  // Supabase client; doesn't disturb the cashier's session).
  const [discountSheet, setDiscountSheet] = useState<'apply' | 'amend' | 'remove' | null>(null);
  const [discountAmountText, setDiscountAmountText] = useState('');
  const [discountReason, setDiscountReason] = useState('');
  const [discountManagerId, setDiscountManagerId] = useState<string>('');
  const [discountManagerPassword, setDiscountManagerPassword] = useState('');
  const [discountManagers, setDiscountManagers] = useState<ManagerRow[]>([]);
  const [discountBusy, setDiscountBusy] = useState(false);
  const [discountError, setDiscountError] = useState<string | null>(null);

  const isMobile = useIsMobile(640);
  // Drives the unsuitable header line + reverse-flow toast wording.
  // Re-fetched whenever the visit refreshes.
  const { data: latestUnsuitable } = useLatestUnsuitability(id ?? null);

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
      cartDiscountPence: cart?.discount_pence ?? 0,
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
  const lineDiscount = items.reduce((sum, i) => sum + i.discount_pence, 0);
  // Cart-level (sale-wide) discount, applied via the manager-
  // approved Apply Discount sheet. The cart's generated total_pence
  // already factors this in; we surface it here so the receipt /
  // pay screen / Totals card can show the line.
  const cartDiscount = cart?.discount_pence ?? 0;
  const discount = lineDiscount + cartDiscount;
  // Only successful deposits credit the till. A failed deposit is shown
  // visually elsewhere; the bill still sums to the full subtotal.
  const depositPence = deposit?.status === 'paid' ? deposit.pence : 0;
  // Balance is what the receptionist will collect at the till after the
  // Calendly deposit is applied. Floor at 0 — manual PayPal refund handles
  // the over-deposit case so we never produce a negative charge here.
  const total = Math.max(0, subtotal - discount - depositPence);
  const cartLocked = cart?.status === 'paid' || cart?.status === 'voided';
  // Primary action toggles between Take payment and Complete visit
  // based on whether there's a balance to collect. Free visits and
  // already-paid carts skip the till entirely; staff completes the
  // visit straight from VisitDetail, answering the in-person-vs-
  // shipping question.
  const balanceDuePence = total;
  const noBalanceToCollect = balanceDuePence <= 0 || cart?.status === 'paid';
  // Visit terminated by an unsuitability finding. Same as cartLocked
  // but specifically lit when the lock is reversible (admin can flip
  // back via the in-app reverse button), unlike paid which is final.
  // Both terminal statuses (unsuitable / ended_early) trigger the
  // same lock UX: dim the cart, suppress productive actions, expose
  // the Reverse button. The labels differ (orange Unsuitable pill
  // vs Ended-early lifecycle line) but the gating predicate is one.
  const isVisitEnded =
    visit?.status === 'unsuitable' || visit?.status === 'ended_early';
  // Backwards-compat alias for the existing call sites that already
  // use isUnsuitable for opacity/disabled props. Removing it would
  // be a churn pass; the alias keeps the diff focused.
  const isUnsuitable = isVisitEnded;
  // Productive actions (cart edits, tech note, LWO print, waiver
  // viewing, payment) are gated behind both: paid carts are immutable
  // forever, unsuitable visits are immutable until reversed.
  const productiveLocked = cartLocked || isUnsuitable;

  // Open the Remove sheet for a specific cart line. Staff picks one
  // of three reasons; submit routes to removeCartLineWithReason.
  const openRemoveSheet = (itemId: string) => {
    setRemoveItemId(itemId);
    // Default to 'mistake' — most common removal reason; staff can
    // switch to changed_mind / unsuitable if it warrants more weight.
    setRemoveReason('mistake');
    setRemoveNote('');
    setRemoveError(null);
    setRemoveOpen(true);
  };

  // True only when the chosen reason is unsuitable AND removing this
  // line would leave the cart empty. Used to surface the "this will
  // end the visit" amber alert in the Remove sheet.
  const itemBeingRemoved = items.find((it) => it.id === removeItemId) ?? null;
  const removeWillEndVisit =
    removeReason === 'unsuitable' && items.length === 1 && itemBeingRemoved !== null;

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

  const [reverseBusy, setReverseBusy] = useState(false);
  const submitReverseUnsuitable = async () => {
    if (!visit || !patient) return;
    setReverseBusy(true);
    setError(null);
    try {
      await reverseUnsuitability({ patient_id: patient.id, visit_id: visit.id });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reverse');
    } finally {
      setReverseBusy(false);
    }
  };

  const openCompleteVisit = () => {
    setCompleteError(null);
    setCompleteMethod('in_person');
    setCompleteOpen(true);
  };

  const submitCompleteVisit = async () => {
    if (!visit || !patient) return;
    setCompleteBusy(true);
    setCompleteError(null);
    try {
      await completeVisit({
        patient_id: patient.id,
        visit_id: visit.id,
        appointment_id: visit.appointment_id,
        walk_in_id: visit.walk_in_id,
        fulfilment_method: completeMethod,
        total_pence: total,
      });
      setCompleteOpen(false);
      refresh();
    } catch (e) {
      setCompleteError(e instanceof Error ? e.message : 'Could not complete');
    } finally {
      setCompleteBusy(false);
    }
  };

  const openDiscountSheet = async (mode: 'apply' | 'amend' | 'remove') => {
    setDiscountError(null);
    // Pre-fill amount + reason from the active discount when amending
    // so staff sees what they're changing from. Apply / Remove start
    // blank.
    if (mode === 'amend' && activeDiscount) {
      setDiscountAmountText((activeDiscount.amount_pence / 100).toFixed(2));
      setDiscountReason(activeDiscount.reason);
    } else {
      setDiscountAmountText('');
      setDiscountReason('');
    }
    setDiscountManagerId('');
    setDiscountManagerPassword('');
    setDiscountSheet(mode);
    try {
      const list = await listManagers();
      setDiscountManagers(list);
      // Cache the email-by-id map so approveAsManager can look up
      // the manager's login_email when verifying their password.
      setManagerEmailLookup(list);
    } catch (e) {
      setDiscountError(e instanceof Error ? e.message : 'Could not load managers');
    }
  };

  const submitApplyDiscount = async () => {
    if (!cart) return;
    const float = Number(discountAmountText.replace(/[^\d.]/g, ''));
    const pence = Math.round(float * 100);
    if (!Number.isFinite(pence) || pence <= 0) {
      setDiscountError('Enter a positive amount.');
      return;
    }
    setDiscountBusy(true);
    setDiscountError(null);
    try {
      await applyCartDiscount({
        cart_id: cart.id,
        amount_pence: pence,
        reason: discountReason,
        approver_id: discountManagerId,
        approver_password: discountManagerPassword,
      });
      setDiscountSheet(null);
      refresh();
      refreshDiscount();
    } catch (e) {
      setDiscountError(e instanceof Error ? e.message : 'Could not apply');
    } finally {
      setDiscountBusy(false);
    }
  };

  const submitRemoveDiscount = async () => {
    if (!cart) return;
    setDiscountBusy(true);
    setDiscountError(null);
    try {
      await removeCartDiscount({
        cart_id: cart.id,
        reason: discountReason,
        approver_id: discountManagerId,
        approver_password: discountManagerPassword,
      });
      setDiscountSheet(null);
      refresh();
      refreshDiscount();
    } catch (e) {
      setDiscountError(e instanceof Error ? e.message : 'Could not remove');
    } finally {
      setDiscountBusy(false);
    }
  };

  const submitAmendDiscount = async () => {
    if (!cart) return;
    const float = Number(discountAmountText.replace(/[^\d.]/g, ''));
    const pence = Math.round(float * 100);
    if (!Number.isFinite(pence) || pence <= 0) {
      setDiscountError('Enter a positive amount.');
      return;
    }
    setDiscountBusy(true);
    setDiscountError(null);
    try {
      await amendCartDiscount({
        cart_id: cart.id,
        amount_pence: pence,
        reason: discountReason,
        approver_id: discountManagerId,
        approver_password: discountManagerPassword,
      });
      setDiscountSheet(null);
      refresh();
      refreshDiscount();
    } catch (e) {
      setDiscountError(e instanceof Error ? e.message : 'Could not amend');
    } finally {
      setDiscountBusy(false);
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
  // Trash icon on a cart line opens the Remove sheet rather than
  // hard-deleting. Every removal goes through reason capture so
  // staff can't silently zero-out a line and bypass the audit.
  const rm = (id: string) => openRemoveSheet(id);

  const submitRemove = async () => {
    if (!visit || !patient || !removeItemId || !itemBeingRemoved) return;
    if (removeReason === 'unsuitable' && removeNote.trim().length === 0) {
      setRemoveError('A reason is required when marking the patient unsuitable.');
      return;
    }
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await removeCartLineWithReason({
        cart_item_id: removeItemId,
        catalogue_id: itemBeingRemoved.catalogue_id,
        visit_id: visit.id,
        patient_id: patient.id,
        reason: removeReason,
        note: removeNote,
      });
      setRemoveOpen(false);
      setRemoveItemId(null);
      refresh();
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : 'Could not remove');
    } finally {
      setRemoveBusy(false);
    }
  };

  // Items eligible for the multi-pick Mark-unsuitable flow: every
  // active catalogue-backed line. Ad-hoc rows are excluded because
  // lng_unsuitability_records requires a catalogue_id.
  const unsuitEligibleItems = useMemo(
    () =>
      items.filter((it): it is typeof it & { catalogue_id: string } => !!it.catalogue_id),
    [items]
  );
  // The button is available on every active visit (regardless of
  // cart contents). Empty cart visits especially benefit — they
  // had no way to close out before. While the visit is active and
  // not already ended, the button shows.
  const canEndEarly = !isVisitEnded;
  const unsuitWillEndAllItems =
    endReason === 'unsuitable' &&
    unsuitEligibleItems.length > 0 &&
    unsuitItemIds.length === unsuitEligibleItems.length;
  // The sheet's submission always ends the visit when reason is not
  // 'unsuitable' (those go through endVisitEarly directly). For
  // 'unsuitable', termination still depends on whether all eligible
  // items are picked.
  const sheetWillEndVisit = endReason !== 'unsuitable' || unsuitWillEndAllItems;

  const openEndEarly = () => {
    setUnsuitError(null);
    setUnsuitNote('');
    setUnsuitItemIds([]);
    setEndReason('unsuitable');
    setUnsuitOpen(true);
  };

  const submitEndEarly = async () => {
    if (!visit || !patient) return;
    if (unsuitNote.trim().length === 0) {
      setUnsuitError('A reason is required.');
      return;
    }
    if (endReason === 'unsuitable' && unsuitItemIds.length === 0) {
      setUnsuitError('Pick at least one product the patient was unsuitable for.');
      return;
    }
    setUnsuitBusy(true);
    setUnsuitError(null);
    try {
      if (endReason === 'unsuitable') {
        // Loop through picked items via the unified removal flow.
        // The orchestrator handles termination once active items
        // hit zero.
        for (const itemId of unsuitItemIds) {
          const it = unsuitEligibleItems.find((x) => x.id === itemId);
          if (!it) continue;
          await removeCartLineWithReason({
            cart_item_id: it.id,
            catalogue_id: it.catalogue_id,
            visit_id: visit.id,
            patient_id: patient.id,
            reason: 'unsuitable',
            note: unsuitNote,
          });
        }
      } else {
        await endVisitEarly({
          patient_id: patient.id,
          visit_id: visit.id,
          reason: endReason,
          note: unsuitNote,
        });
      }
      setUnsuitOpen(false);
      refresh();
    } catch (e) {
      setUnsuitError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setUnsuitBusy(false);
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
            {/* Unified hero — same shape AppointmentDetail uses, fed
                visit-specific data. Identity row carries the patient
                + visit status pill + optional cart status pill +
                a compact subtitle of refs / arrival type / staff;
                the tinted "When" ribbon below carries the slot date,
                relative state ("Arrived 23 minutes ago") and the
                service. The previous title + meta pills + lifecycle
                strip are folded into this one card so the page reads
                with the same rhythm as the appointment surface — no
                drift between the two. Chronological detail lives on
                the visit timeline at the bottom. */}
            <div style={{ marginBottom: theme.space[6] }}>
              <AppointmentHero
                {...buildVisitHeroProps(visit, appointment, patient, cart, latestUnsuitable)}
                trailing={
                  patient ? (
                    <Button
                      variant="tertiary"
                      size="sm"
                      onClick={() =>
                        navigate(`/patient/${patient.id}`, {
                          state: {
                            from: 'visit',
                            visitId: visit.id,
                            visitOpenedAt: visit.opened_at,
                            patientName: patientFullName(patient),
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
                  ) : undefined
                }
              />
            </div>

            {/* Whole banner dims when the visit is unsuitable so it
                reads as terminated alongside the cart. The View
                button inside still stays visible (just disabled) so
                staff can see the affordance shape. */}
            <div style={isUnsuitable ? { opacity: 0.55 } : undefined}>
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
                // buildable. While the visit is unsuitable the
                // button stays visible but disabled.
                onView={waiverDoc ? () => setWaiverViewerOpen(true) : undefined}
                viewDisabled={isUnsuitable}
              />
            </div>

            {/* Whole Cart card dims when the visit is unsuitable —
                title, items, subtotal, totals all go quiet. The
                action row below stays at full opacity so the
                Reverse affordance reads as the only live thing. */}
            <div style={isUnsuitable ? { opacity: 0.55 } : undefined}>
            <Card padding="lg">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: theme.space[4] }}>
                <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
                  Cart
                </h2>
                {items.length > 0 && !productiveLocked ? (
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
                    <Button variant="primary" onClick={openPicker} disabled={productiveLocked}>
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
                        disabled={busyItem === it.id || productiveLocked}
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

              {/* Discount control sits beside the totals — that's where
                  staff already look to verify the bill, and the apply /
                  remove flow has manager-approval friction we don't
                  want to bury. Only renders when there's a basket and
                  the cart is still mutable; productive locks (paid /
                  voided / unsuitable / ended_early) hide it like the
                  rest of the cart actions. */}
              {items.length > 0 && !productiveLocked ? (
                <div
                  style={{
                    marginTop: theme.space[4],
                    paddingTop: theme.space[3],
                    borderTop: `1px dashed ${theme.color.border}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: theme.space[2],
                  }}
                >
                  {activeDiscount ? (
                    <>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: theme.space[3],
                          flexWrap: 'wrap',
                        }}
                      >
                        <span
                          style={{
                            fontSize: theme.type.size.sm,
                            color: theme.color.inkMuted,
                          }}
                        >
                          Approved by {activeDiscount.approver_name ?? 'manager'}
                          {activeDiscount.reason ? ` · ${activeDiscount.reason}` : ''}
                        </span>
                        <div style={{ display: 'flex', gap: theme.space[2] }}>
                          <Button variant="tertiary" size="sm" onClick={() => openDiscountSheet('amend')}>
                            Amend
                          </Button>
                          <Button variant="tertiary" size="sm" onClick={() => openDiscountSheet('remove')}>
                            Remove
                          </Button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <Button variant="tertiary" size="sm" onClick={() => openDiscountSheet('apply')}>
                        Apply discount
                      </Button>
                    </div>
                  )}
                </div>
              ) : null}
            </Card>
            </div>

            {/* Action row is always visible when the visit exists.
                Each button decides for itself whether it's relevant:
                - End visit early shows whenever the visit is active,
                  including on an empty cart (key exit ramp).
                - Tech note is always available.
                - Print LWO / Take payment only render with items.
                - Resume replaces Take payment when terminated. */}
            <div
              style={{
                marginTop: theme.space[6],
                display: 'flex',
                gap: theme.space[2],
                justifyContent: 'flex-end',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              {canEndEarly ? (
                <Button variant="tertiary" onClick={openEndEarly}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                    <Ban size={16} aria-hidden />
                    End visit early
                  </span>
                </Button>
              ) : null}
              {items.length > 0 ? (
                <span style={isUnsuitable ? { opacity: 0.55 } : undefined}>
                  <Button variant="secondary" onClick={openNoteEditor} disabled={productiveLocked}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                      <StickyNote size={16} aria-hidden />
                      {visit.notes && visit.notes.trim() ? 'Edit tech note' : 'Add tech note'}
                    </span>
                  </Button>
                </span>
              ) : null}
              {items.length > 0 ? (
                <span style={isUnsuitable ? { opacity: 0.55 } : undefined}>
                  <Button
                    variant="secondary"
                    onClick={handlePrintLwo}
                    disabled={!appointment?.appointment_ref || productiveLocked}
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
                </span>
              ) : null}
              {isUnsuitable ? (
                <Button variant="primary" onClick={submitReverseUnsuitable} loading={reverseBusy}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                    <RotateCcw size={16} aria-hidden />
                    Resume visit
                  </span>
                </Button>
              ) : items.length > 0 ? (
                noBalanceToCollect ? (
                  // Free visit, fully covered by deposit, or cart
                  // already paid → there's no till step. Primary
                  // becomes Complete visit; the sheet asks the
                  // in-person-vs-shipping question.
                  <Button variant="primary" onClick={openCompleteVisit}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                      <CheckCircle size={16} aria-hidden />
                      Complete visit
                    </span>
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    showArrow
                    onClick={() =>
                      navigate(`/visit/${visit.id}/pay`, {
                        state: {
                          from: 'visit',
                          visitId: visit.id,
                          visitOpenedAt: visit.opened_at,
                          // Pass the visit's own entry through so
                          // Pay's breadcrumb can render the full
                          // chain and the visit-link can pop back
                          // with the right state.
                          visitEntry: location.state,
                        },
                      })
                    }
                  >
                    Take payment
                  </Button>
                )
              ) : null}
            </div>

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
        defaultWitnessName={currentAccount?.display_name ?? receptionistName ?? ''}
        onAllSigned={refreshSignatures}
      />

      <WaiverViewerDialog
        open={waiverViewerOpen}
        onClose={() => setWaiverViewerOpen(false)}
        doc={waiverDoc}
        visitId={visit?.id ?? null}
        patientEmail={patient?.email ?? null}
      />

      <BottomSheet
        open={noteOpen}
        onClose={() => !noteSaving && setNoteOpen(false)}
        title="Tech note for the lab"
        description="This prints on the LWO."
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
      </BottomSheet>

      {/* Per-line Remove sheet. Trash icon on a cart line opens
          this; staff picks one of three reasons and (for unsuitable
          / changed_mind) optionally adds a note. Submit routes to
          removeCartLineWithReason which soft-deletes the line,
          writes the right audit, and decides whether the visit
          should terminate. */}
      <BottomSheet
        open={removeOpen}
        onClose={() => !removeBusy && setRemoveOpen(false)}
        dismissable={!removeBusy}
        title={itemBeingRemoved ? `Remove ${itemBeingRemoved.name}` : 'Remove item'}
        description={
          removeReason === 'unsuitable'
            ? removeWillEndVisit
              ? 'This is the last item on the visit. Submitting will end the visit. The patient won’t be charged. An admin can reverse this later.'
              : 'Records on the patient timeline that the patient was unsuitable for this product. Reason is required.'
            : removeReason === 'changed_mind'
              ? 'Records on the patient timeline that the patient declined this product. A note is optional.'
              : 'Removes the line from the cart. Use this when staff picked the wrong product. Logged for audit.'
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
            <Button variant="secondary" onClick={() => setRemoveOpen(false)} disabled={removeBusy}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <X size={16} aria-hidden /> Cancel
              </span>
            </Button>
            <Button variant="primary" onClick={submitRemove} loading={removeBusy}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Ban size={16} aria-hidden />
                {removeReason === 'unsuitable' && removeWillEndVisit
                  ? 'Remove & end visit'
                  : 'Remove'}
              </span>
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
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
            {/* Three radio-style cards. Click flips the selection;
                the chosen reason drives the sheet description and
                whether the note textarea is required. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {([
                { value: 'mistake', label: 'Added by mistake', sub: 'Staff picked the wrong product. No clinical meaning.' },
                { value: 'changed_mind', label: 'Patient changed mind', sub: 'Patient declined this product today.' },
                { value: 'unsuitable', label: 'Patient unsuitable', sub: 'Clinical decision. Reason required, lands on timeline.' },
              ] as const).map((opt) => {
                const isSel = removeReason === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setRemoveReason(opt.value)}
                    style={{
                      appearance: 'none',
                      width: '100%',
                      textAlign: 'left',
                      cursor: 'pointer',
                      padding: theme.space[3],
                      borderRadius: theme.radius.input,
                      border: `1.5px solid ${isSel ? theme.color.ink : theme.color.border}`,
                      background: isSel ? 'rgba(14, 20, 20, 0.03)' : theme.color.surface,
                      color: theme.color.ink,
                      fontFamily: 'inherit',
                      transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
                    }}
                  >
                    <div
                      style={{
                        fontSize: theme.type.size.base,
                        fontWeight: isSel ? theme.type.weight.semibold : theme.type.weight.medium,
                      }}
                    >
                      {opt.label}
                    </div>
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: theme.type.size.sm,
                        color: theme.color.inkMuted,
                        fontWeight: theme.type.weight.regular,
                      }}
                    >
                      {opt.sub}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {removeWillEndVisit ? (
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
                Last item on the visit. Submitting will end the visit. The patient won’t be charged and the visit
                drops off the in-clinic board.
              </span>
            </div>
          ) : null}

          {removeReason !== 'mistake' ? (
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
                {removeReason === 'unsuitable' ? 'Reason' : 'Note'}
                {removeReason === 'unsuitable' ? <span style={{ color: theme.color.alert }}> *</span> : null}
              </span>
              <textarea
                value={removeNote}
                onChange={(e) => setRemoveNote(e.target.value)}
                rows={4}
                placeholder={
                  removeReason === 'unsuitable'
                    ? 'Why is the patient unsuitable for this product? Be specific. This lands on the patient timeline.'
                    : 'Optional. Anything worth recording about why the patient declined.'
                }
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
                  minHeight: 100,
                }}
              />
            </label>
          ) : null}

          {removeError ? (
            <p
              role="alert"
              style={{
                margin: 0,
                color: theme.color.alert,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
              }}
            >
              {removeError}
            </p>
          ) : null}
        </div>
      </BottomSheet>

      {/* End visit early sheet. Five reason categories — picking
          'Patient unsuitable' reveals the product picker; the rest
          end the visit on a non-clinical reason. Submit branches
          accordingly: unsuitable loops removeCartLineWithReason,
          everything else calls endVisitEarly which soft-deletes any
          remaining items and stamps lng_visits.visit_end_reason +
          visit_end_note. Reverse restores the lines exactly. */}
      <BottomSheet
        open={unsuitOpen}
        onClose={() => !unsuitBusy && setUnsuitOpen(false)}
        dismissable={!unsuitBusy}
        title="End visit early"
        description={
          sheetWillEndVisit
            ? 'The visit ends here. Soft-deleted lines come back if you Reverse later. Only an admin can reverse outside the app.'
            : 'Records on the patient timeline that the patient was unsuitable for the picked products. The visit stays open for any product you don’t tick.'
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
            <Button variant="secondary" onClick={() => setUnsuitOpen(false)} disabled={unsuitBusy}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <X size={16} aria-hidden /> Cancel
              </span>
            </Button>
            <Button variant="primary" onClick={submitEndEarly} loading={unsuitBusy}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Ban size={16} aria-hidden />
                {sheetWillEndVisit ? 'End visit' : 'Mark unsuitable'}
              </span>
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          {/* Five radio cards. Picking 'unsuitable' reveals the
              product picker below; the others use only the reason
              textarea. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            <span
              style={{
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
                fontWeight: theme.type.weight.medium,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
              }}
            >
              Reason category <span style={{ color: theme.color.alert }}>*</span>
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {([
                { value: 'unsuitable', label: 'Patient unsuitable', sub: 'Clinical decision. Pick the products it applies to.' },
                { value: 'patient_declined', label: 'Patient declined', sub: 'Patient changed their mind or no longer wants the work.' },
                { value: 'patient_walked_out', label: 'Patient walked out', sub: 'Patient left without finishing the visit.' },
                { value: 'wrong_booking', label: 'Wrong booking', sub: 'We can’t deliver what they came for today.' },
                { value: 'other', label: 'Other', sub: 'Anything else. Reason note explains it.' },
              ] as const).map((opt) => {
                const isSel = endReason === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setEndReason(opt.value)}
                    style={{
                      appearance: 'none',
                      width: '100%',
                      textAlign: 'left',
                      cursor: 'pointer',
                      padding: theme.space[3],
                      borderRadius: theme.radius.input,
                      border: `1.5px solid ${isSel ? theme.color.ink : theme.color.border}`,
                      background: isSel ? 'rgba(14, 20, 20, 0.03)' : theme.color.surface,
                      color: theme.color.ink,
                      fontFamily: 'inherit',
                      transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
                    }}
                  >
                    <div
                      style={{
                        fontSize: theme.type.size.base,
                        fontWeight: isSel ? theme.type.weight.semibold : theme.type.weight.medium,
                      }}
                    >
                      {opt.label}
                    </div>
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: theme.type.size.sm,
                        color: theme.color.inkMuted,
                        fontWeight: theme.type.weight.regular,
                      }}
                    >
                      {opt.sub}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {endReason === 'unsuitable' && unsuitEligibleItems.length > 0 ? (
            <MultiSelectDropdown<string>
              label="Products"
              required
              values={unsuitItemIds}
              options={unsuitEligibleItems.map((it) => ({ value: it.id, label: it.name }))}
              onChange={(next) => setUnsuitItemIds(next)}
              placeholder="Pick from the basket"
              totalNoun="products"
            />
          ) : null}

          {sheetWillEndVisit ? (
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
                Submitting will end the visit. The cart locks, the visit drops off the in-clinic board, and any
                remaining lines soft-delete so Reverse can restore them later.
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
              value={unsuitNote}
              onChange={(e) => setUnsuitNote(e.target.value)}
              rows={5}
              placeholder={
                endReason === 'unsuitable'
                  ? 'Why is the patient unsuitable for these products? Be specific. This lands on the patient timeline.'
                  : 'Why is the visit ending early? Be specific. This lands on the patient timeline.'
              }
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

          {unsuitError ? (
            <p
              role="alert"
              style={{
                margin: 0,
                color: theme.color.alert,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
              }}
            >
              {unsuitError}
            </p>
          ) : null}
        </div>
      </BottomSheet>

      {/* Complete visit sheet — fired by the primary CTA when the
          balance is fully settled. Asks the fulfilment question and
          writes the choice to lng_visits.fulfilment_method via
          completeVisit. The shipping branch is just stored for now;
          the actual dispatch flow is a separate slice. */}
      <BottomSheet
        open={completeOpen}
        onClose={() => !completeBusy && setCompleteOpen(false)}
        dismissable={!completeBusy}
        title="Complete visit"
        description={
          completeMethod === 'shipping'
            ? 'The work will be shipped. The dispatch flow opens after this slice lands; for now the choice is recorded on the visit.'
            : 'Confirm the work was passed to the patient on the day. The visit closes and the job box is freed.'
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
            <Button variant="secondary" onClick={() => setCompleteOpen(false)} disabled={completeBusy}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <X size={16} aria-hidden /> Cancel
              </span>
            </Button>
            <Button variant="primary" onClick={submitCompleteVisit} loading={completeBusy}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <CheckCircle size={16} aria-hidden /> Complete visit
              </span>
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            <span
              style={{
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
                fontWeight: theme.type.weight.medium,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
              }}
            >
              How is the work being handed off? <span style={{ color: theme.color.alert }}>*</span>
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {([
                { value: 'in_person', label: 'Passed to patient', sub: 'Patient is taking the work today.' },
                { value: 'shipping', label: 'To be shipped', sub: 'Work is being dispatched. We move to the shipping flow next.' },
              ] as const).map((opt) => {
                const isSel = completeMethod === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setCompleteMethod(opt.value)}
                    style={{
                      appearance: 'none',
                      width: '100%',
                      textAlign: 'left',
                      cursor: 'pointer',
                      padding: theme.space[3],
                      borderRadius: theme.radius.input,
                      border: `1.5px solid ${isSel ? theme.color.ink : theme.color.border}`,
                      background: isSel ? 'rgba(14, 20, 20, 0.03)' : theme.color.surface,
                      color: theme.color.ink,
                      fontFamily: 'inherit',
                      transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
                    }}
                  >
                    <div
                      style={{
                        fontSize: theme.type.size.base,
                        fontWeight: isSel ? theme.type.weight.semibold : theme.type.weight.medium,
                      }}
                    >
                      {opt.label}
                    </div>
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: theme.type.size.sm,
                        color: theme.color.inkMuted,
                        fontWeight: theme.type.weight.regular,
                      }}
                    >
                      {opt.sub}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {completeError ? (
            <p
              role="alert"
              style={{
                margin: 0,
                color: theme.color.alert,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
              }}
            >
              {completeError}
            </p>
          ) : null}
        </div>
      </BottomSheet>

      {/* Apply / Amend / Remove discount sheet. All three modes share
          the same chrome — manager dropdown + manager password
          (re-auth) + reason + (apply / amend only) amount. Submitting
          calls the right mutation; lng_carts.discount_pence stays in
          sync with the audit table, and total_pence is generated so
          the cart card + Pay screen + waiver pick up the new total
          without extra plumbing. Amend retires the previous audit row
          and inserts a fresh one in the same call so the trail reads
          as a clean pair. */}
      <BottomSheet
        open={discountSheet !== null}
        onClose={() => !discountBusy && setDiscountSheet(null)}
        dismissable={!discountBusy}
        title={
          discountSheet === 'remove'
            ? 'Remove discount'
            : discountSheet === 'amend'
              ? 'Amend discount'
              : 'Apply discount'
        }
        description={
          discountSheet === 'remove'
            ? 'Removing the discount restores the full bill. Manager re-enters their password to authorise — this lands on the audit row alongside the original approver.'
            : discountSheet === 'amend'
              ? 'Change the amount or reason. The existing audit row is retired and a fresh one is inserted, both attributed to the approving manager. Patient sees the new total immediately.'
              : 'Sale-wide discount on this visit. Manager re-enters their password to authorise; both your name and theirs land on the audit row.'
        }
        footer={
          <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={() => setDiscountSheet(null)} disabled={discountBusy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={
                discountSheet === 'remove'
                  ? submitRemoveDiscount
                  : discountSheet === 'amend'
                    ? submitAmendDiscount
                    : submitApplyDiscount
              }
              loading={discountBusy}
            >
              {discountSheet === 'remove'
                ? 'Remove discount'
                : discountSheet === 'amend'
                  ? 'Save amendment'
                  : 'Apply discount'}
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          {discountSheet === 'apply' || discountSheet === 'amend' ? (
            <Input
              label="Discount amount (£)"
              inputMode="decimal"
              value={discountAmountText}
              onChange={(e) => setDiscountAmountText(e.target.value)}
              placeholder="e.g. 25.00"
              autoFocus
            />
          ) : null}
          <Input
            label="Reason"
            value={discountReason}
            onChange={(e) => setDiscountReason(e.target.value)}
            placeholder={
              discountSheet === 'remove'
                ? 'Why is the discount being removed?'
                : discountSheet === 'amend'
                  ? 'Why is the discount being amended? (e.g. miscalculation, additional courtesy)'
                  : 'Why is the discount being given? (e.g. compensation, repeat-patient courtesy)'
            }
          />
          <div
            style={{
              padding: theme.space[3],
              borderRadius: theme.radius.input,
              border: `1px solid ${theme.color.border}`,
              background: theme.color.bg,
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[3],
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
              Manager sign-off
            </span>
            <DropdownSelect<string>
              label="Approving manager"
              required
              value={discountManagerId}
              options={discountManagers.map((m) => ({ value: m.id, label: m.name }))}
              onChange={(v) => setDiscountManagerId(v)}
              placeholder={discountManagers.length === 0 ? 'No managers configured. Add one in Admin > Staff.' : 'Pick a manager'}
              disabled={discountManagers.length === 0}
            />
            <Input
              label="Manager password"
              type="password"
              value={discountManagerPassword}
              onChange={(e) => setDiscountManagerPassword(e.target.value)}
            />
          </div>
          {discountError ? (
            <p
              role="alert"
              style={{
                margin: 0,
                color: theme.color.alert,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
              }}
            >
              {discountError}
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
  from?: 'patient' | 'schedule' | 'in_clinic' | 'ledger';
  patientId?: string;
  patientName?: string;
  // Optional preview of the visit's opened-at timestamp. When the
  // caller already has it (e.g. PatientProfile's appointments list),
  // forwarding it lets the breadcrumb render the full "Appointment,
  // 29 Apr, 21:43" label on first paint instead of a shimmer.
  visitOpenedAt?: string;
  // YYYY-MM-DD of the day the receptionist was viewing on Schedule
  // when they drilled in. Used by the Schedule breadcrumb back-link
  // so they return to the same day instead of today.
  scheduleDate?: string;
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
    if (entry.from === 'ledger') {
      // Ledger › Ewa Deb's Appt. 29 Apr — two crumbs, name baked
      // into the visit crumb. Mirrors the In-clinic shape: each Ledger
      // row already shows the patient + service + status before the
      // click, so a third crumb just for the patient name is clutter.
      // Drilling into the patient profile from here happens via the
      // "View patient profile" button on the page itself, which
      // forwards the Ledger origin so the chain stays "Ledger ›
      // Visit › Patient name" on that page.
      return [
        { label: 'Ledger', onClick: () => navigate('/ledger') },
        { label: buildVisitLabel(true) },
      ];
    }
    // 'schedule' or no hint — default trail. Patient crumb renders
    // when we have any identity to link to. When we know which day
    // the receptionist was viewing on Schedule, we route the back-link
    // to that exact day so they don't lose their place.
    const scheduleHref = entry.scheduleDate
      ? `/schedule?date=${encodeURIComponent(entry.scheduleDate)}`
      : '/schedule';
    if (patient) {
      return [
        { label: 'Schedule', onClick: () => navigate(scheduleHref) },
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
      { label: 'Schedule', onClick: () => navigate(scheduleHref) },
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
  viewDisabled,
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
  // a matching signature) so we don't surface an inert action.
  onView?: () => void;
  // When true, the View button stays visible but disabled + dimmed.
  // Used while the visit is locked (unsuitable) so the affordance
  // matches the rest of the dimmed productive surface.
  viewDisabled?: boolean;
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
          <Button
            variant="secondary"
            size="sm"
            onClick={onView}
            disabled={viewDisabled}
          >
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


// Builds the AppointmentHero props for a visit. Wraps the visit-
// specific facts (visit.status, cart.status, refs, arrival type)
// into the shape the shared hero expects so the page reads with the
// same rhythm AppointmentDetail does. The chronological detail —
// booked / scheduled / arrived / closed timestamps — moved out of a
// dedicated lifecycle strip and into the visit timeline at the
// bottom of the page; the hero captures the headline state alone.
function buildVisitHeroProps(
  visit: VisitRow,
  appointment: VisitAppointmentContext | null,
  patient: (PatientRow & { avatar_data?: string | null }) | null,
  cart: { status: 'open' | 'paid' | 'voided' } | null,
  latestUnsuitable: { recorded_at: string | null } | null,
): Omit<AppointmentHeroProps, 'trailing'> {
  const isWalkIn = visit.arrival_type === 'walk_in';
  const headlineIso: string = !isWalkIn && appointment ? appointment.start_at : visit.opened_at;
  const dateLong = formatDateLongOrdinal(headlineIso);
  const lineParts = visitWhenStatusLine(visit, appointment, isWalkIn);
  const service =
    humaniseEventTypeLabel(appointment?.event_type_label ?? null) ?? (isWalkIn ? 'Walk-in' : 'Appointment');

  // Pills row — visit status always; cart status when one exists and
  // the visit isn't terminated (a "Cart open" pill on an unsuitable
  // visit is misleading because the cart's locked anyway).
  const pills: AppointmentHeroPill[] = [
    { tone: visitStatusTone(visit.status), label: visitStatusLabel(visit.status) },
  ];
  const isTerminated = visit.status === 'unsuitable' || visit.status === 'ended_early';
  if (cart && !isTerminated) {
    pills.push({
      tone: cart.status === 'paid' ? 'arrived' : cart.status === 'open' ? 'neutral' : 'no_show',
      label: cartStatusLabel(cart.status),
    });
  }

  // Subtitle — refs first (MP, LAP, JB), then arrival type. Compact
  // dot-separated form so the line stays scannable at a glance.
  const subtitleParts: string[] = [];
  if (showableRef(patient?.internal_ref)) subtitleParts.push(patient!.internal_ref);
  if (appointment?.appointment_ref) subtitleParts.push(appointment.appointment_ref);
  if (appointment?.jb_ref) subtitleParts.push(`JB${appointment.jb_ref}`);
  subtitleParts.push(isWalkIn ? 'Walk-in' : 'Scheduled');

  const tone: AppointmentHeroTone = (() => {
    switch (visit.status) {
      case 'arrived':
      case 'in_chair':
        return 'accent';
      case 'complete':
        return 'neutral';
      case 'unsuitable':
      case 'ended_early':
        return 'warn';
    }
  })();

  // Suppress unused-arg warning until we surface the unsuitable-at
  // moment in the ribbon copy. Keeping the arg in the signature so
  // future enrichment doesn't need a callsite churn.
  void latestUnsuitable;

  return {
    patient: { name: patient ? patientFullName(patient) : 'Patient', avatarSrc: patient?.avatar_data ?? null },
    pills,
    subtitle: subtitleParts.join(' · '),
    when: {
      dateLong,
      timeLine: lineParts.anchor,
      relative: lineParts.relative,
      service,
      tone,
    },
  };
}

// Build the second-line "anchor + relative" pair for the ribbon.
// Anchor reads as a fact ("Scheduled 09:00", "Walked in 09:43");
// relative phrases what's happening right now ("Arrived 23 minutes
// ago", "In chair · 14 minutes", "Completed 5 minutes ago"). The
// pair is deliberately split so the renderer can colour them
// differently without re-parsing the string.
function visitWhenStatusLine(
  visit: VisitRow,
  appointment: VisitAppointmentContext | null,
  isWalkIn: boolean,
): { anchor: string; relative: string | null } {
  // Reference time for "X minutes ago": closed_at when the visit has
  // ended, opened_at while it's still active. Falls through to
  // null-safe parsing on either side.
  const reference =
    visit.status === 'complete' || visit.status === 'unsuitable' || visit.status === 'ended_early'
      ? visit.closed_at ?? visit.opened_at
      : visit.opened_at;
  const relative = reference ? relativeMinutes(reference) : null;

  // Anchor sentence varies with origin + status. Walk-ins never had a
  // booked slot so we phrase the time as the arrival moment; scheduled
  // visits show the booked time so staff can see at a glance whether
  // the patient was on time, early, or late.
  if (isWalkIn) {
    return {
      anchor: `Walked in ${formatTime(visit.opened_at)}`,
      relative: walkInRelative(visit, relative),
    };
  }

  const slotRange = appointment ? formatTimeRange(appointment.start_at, '') : '';
  // formatTimeRange returns '' when end is unparseable; for visits we
  // don't have end_at on the appointment context, so render just the
  // start time using formatTime instead.
  const slotStart = appointment ? formatTime(appointment.start_at) : '';
  const anchor = slotStart ? `Scheduled ${slotStart}` : 'Scheduled';
  // Suppress slotRange usage warning — see comment above.
  void slotRange;

  switch (visit.status) {
    case 'arrived':
      return { anchor, relative: relative ? `Arrived ${relative}` : 'Arrived' };
    case 'in_chair':
      return { anchor, relative: relative ? `In chair · ${relative}` : 'In chair' };
    case 'complete':
      return { anchor, relative: relative ? `Completed ${relative}` : 'Completed' };
    case 'unsuitable':
      return { anchor, relative: relative ? `Marked unsuitable ${relative}` : 'Marked unsuitable' };
    case 'ended_early':
      return { anchor, relative: relative ? `Ended early ${relative}` : 'Ended early' };
  }
}

function walkInRelative(visit: VisitRow, baseRelative: string | null): string | null {
  if (!baseRelative) return null;
  switch (visit.status) {
    case 'arrived':
      return `Arrived ${baseRelative}`;
    case 'in_chair':
      return `In chair · ${baseRelative}`;
    case 'complete':
      return `Completed ${baseRelative}`;
    case 'unsuitable':
      return `Marked unsuitable ${baseRelative}`;
    case 'ended_early':
      return `Ended early ${baseRelative}`;
  }
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

// Visit-status helpers. The DB stores the raw enum (opened /
// in_progress / complete / cancelled); the UI shows humanised copy
// to match the other status pills in the app.
function visitStatusLabel(s: 'arrived' | 'in_chair' | 'complete' | 'unsuitable' | 'ended_early'): string {
  switch (s) {
    case 'arrived':
      return 'Arrived';
    case 'in_chair':
      return 'In chair';
    case 'complete':
      return 'Complete';
    case 'unsuitable':
      return 'Unsuitable';
    case 'ended_early':
      return 'Ended early';
  }
}
function visitStatusTone(s: 'arrived' | 'in_chair' | 'complete' | 'unsuitable' | 'ended_early') {
  switch (s) {
    case 'arrived':
      return 'in_progress' as const;
    case 'in_chair':
      return 'in_progress' as const;
    case 'complete':
      return 'complete' as const;
    case 'unsuitable':
    case 'ended_early':
      return 'unsuitable' as const;
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
