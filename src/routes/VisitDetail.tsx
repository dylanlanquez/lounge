import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Ban,
  CalendarClock,
  CheckCircle2,
  CheckCircle,
  ChevronRight,
  CircleSlash,
  ExternalLink,
  FileText,
  MapPin,
  MoreHorizontal,
  Package,
  Plus,
  Printer,
  Receipt,
  RotateCcw,
  ShoppingCart,
  StickyNote,
  Truck,
  User as UserIcon,
  UserCheck,
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
  CollapsibleCard,
  EmptyState,
  Input,
  MarketingGallery,
  MultiSelectDropdown,
  PatientCommsCard,
  PhaseTimeline,
  Section,
  AppointmentExtras,
  ContinuousTimeline,
  ShipVisitSheet,
  Skeleton,
  SmilePhotosCard,
  Toast,
  WaiverSheet,
} from '../components/index.ts';
import { useAppointmentExtras } from '../lib/queries/appointmentExtras.ts';
import { useAppointmentLivePhases } from '../lib/queries/appointmentLivePhases.ts';
import { WaiverViewerDialog } from '../components/WaiverViewerDialog/WaiverViewerDialog.tsx';
import { supabase } from '../lib/supabase.ts';
import { useSignedWaivers } from '../lib/queries/waiver.ts';
import type { WaiverDocInput, WaiverDocItem, WaiverDocSection } from '../lib/waiverDocument.ts';
import { humaniseEventTypeLabel, usePatientProfileFiles } from '../lib/queries/patientProfile.ts';
import {
  formatAppointmentSummary,
  type AppointmentSource,
} from '../lib/queries/appointments.ts';
import { SourceGlyph } from '../components/AppointmentCard/AppointmentCard.tsx';
import { AppointmentNotesHero } from '../components/AppointmentNotesHero/AppointmentNotesHero.tsx';
import {
  formatDateLongOrdinal,
  formatTime,
  relativeMinutes,
} from '../lib/dateFormat.ts';
import { CartLineItem } from '../components/CartLineItem/CartLineItem.tsx';
import { CataloguePicker } from '../components/CataloguePicker/CataloguePicker.tsx';
import { DiscountIcon } from '../components/Icons/DiscountIcon.tsx';
import { ShopifyIcon } from '../components/Icons/ShopifyIcon.tsx';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useCurrentAccount } from '../lib/queries/currentAccount.tsx';
import { RefundSheet } from '../components/RefundSheet/RefundSheet.tsx';
import { SendReceiptSheet } from '../components/SendReceiptSheet/SendReceiptSheet.tsx';
import { ActionMenu, type ActionMenuItem } from '../components/ActionMenu/ActionMenu.tsx';
import { recordOwedToPatient, type OwedTrigger } from '../lib/queries/owedToPatient.ts';
import {
  configFor,
  useAdminProductConfig,
} from '../lib/queries/productWidgetConfig.ts';
import { useIsMobile } from '../lib/useIsMobile.ts';
import {
  completeVisit,
  endVisitEarly,
  formatVisitCrumb,
  removeCartLineWithReason,
  formatDepositSourceSuffix,
  reverseUnsuitability,
  updateVisitFulfilmentMethod,
  useLatestUnsuitability,
  useVisitDetail,
  visitRequiresFulfilment,
  type VisitFulfilmentMethod,
} from '../lib/queries/visits.ts';
import type {
  AppointmentDeposit,
  VisitAppointmentContext,
  VisitEndReason,
  VisitRow,
} from '../lib/queries/visits.ts';
import type { PatientRow } from '../lib/queries/patients.ts';
import {
  amendCartDiscount,
  applyCartDiscount,
  removeCartDiscount,
  useActiveCartDiscount,
} from '../lib/queries/cartDiscounts.ts';
import {
  listResolvedManagerRecipients,
  sendManagerNotification,
} from '../lib/queries/managerNotifications.ts';
import { ManagerNotificationNotice } from '../components/ManagerNotificationNotice/ManagerNotificationNotice.tsx';
import { patientFullName } from '../lib/queries/patients.ts';
import {
  formatPence,
  updateCartItemQuantity,
  useCart,
} from '../lib/queries/carts.ts';
import {
  useCartPayments,
  useVisitPaidStatus,
  type CartPaymentRow,
  type PaymentMethod,
} from '../lib/queries/payments.ts';
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
  // Customer Service-only staff lose every clinic-floor affordance on
  // this page: no cart edits, no discounts, no payment, no Print LWO,
  // no end-visit-early, no tech notes. They can still SEE the visit;
  // they just can't act on it. Admins / managers flagged as CS keep
  // their full access (is_cs_only is false for those).
  const isCsOnly = currentAccount?.is_cs_only === true;
  // Per-product widget config — drives whether the Smile photos card
  // renders on the visit body. Composite key (service_type, product_key)
  // — see AppointmentDetail for the matching surface; both read the
  // same source of truth.
  const { data: productConfig } = useAdminProductConfig();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    visit,
    patient,
    deposit,
    shopifyOrder,
    appointment,
    receptionistName,
    loading,
    refresh: refreshVisitDetail,
  } = useVisitDetail(id);
  const { upgrades: appointmentUpgrades, repairItems: appointmentRepairItems } =
    useAppointmentExtras(visit?.appointment_id ?? null);
  // Live booking-type phases for the appointment, projected onto
  // the visit's actual arrival time (visit.opened_at). The customer
  // walked in at the arrival time so the timeline reflects how the
  // service unfolds from THIS moment, not from the originally booked
  // slot. Returns an empty list for walk-ins (no appointment context)
  // and for services with zero or one configured phases. Anchoring on
  // arrival rather than start_at is the difference between the
  // appointment page (forward-looking) and the visit page (already
  // in-progress).
  const visitLivePhasesState = useAppointmentLivePhases(
    appointment && visit
      ? {
          service_type: appointment.service_type,
          repair_variant: appointment.repair_variant,
          product_key: appointment.product_key,
          arch: appointment.arch,
          start_at: visit.opened_at,
        }
      : null,
  );
  const visitLivePhases = visitLivePhasesState.phases ?? [];
  const { data: galleryFiles, loading: galleryFilesLoading, refresh: refreshGalleryFiles } =
    usePatientProfileFiles(patient?.id ?? null);
  const { cart, items, loading: cartLoading, refresh, ensureOpen } = useCart(id);
  const { active: activeDiscount, refresh: refreshDiscount } = useActiveCartDiscount(cart?.id ?? null);
  // Captured payments power the Paid banner — once the cart is paid,
  // the operator should see WHICH methods landed (cash + card split,
  // etc.) and WHEN, not just the final total.
  const { data: succeededPayments } = useCartPayments(cart?.id ?? null);
  // Single source of truth for "how much has actually been collected
  // for this visit" — sums the paid Calendly/widget deposit, every
  // succeeded lng_payments row, and any linked Shopify pre-paid order.
  // Used for the Cart card's outstanding balance so this page agrees
  // with the Take Payment screen.
  const { data: paidStatus, refresh: refreshPaid } = useVisitPaidStatus(id);
  const paidPayments = useMemo(
    () => succeededPayments.filter((p) => p.status === 'succeeded'),
    [succeededPayments],
  );
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
  //   unsuitable        → reveals product picker; submit calls
  //                       endVisitEarly with the picked lines (one
  //                       atomic lng_end_visit_early RPC behind it)
  //   patient_declined  → endVisitEarly with note (all active lines
  //                       soft-deleted with reason='visit_ended_early')
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
  // via completeVisit. Shipping branch opens ShipVisitSheet.
  const [completeOpen, setCompleteOpen] = useState(false);
  const [completeMethod, setCompleteMethod] = useState<'in_person' | 'shipping'>('in_person');
  const [completeBusy, setCompleteBusy] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  // Shipping dispatch sheet — opens after completing a visit with
  // fulfilment_method='shipping'. Also surfaces via "Process shipping"
  // button if the visit was completed earlier but dispatch wasn't done.
  const [shipOpen, setShipOpen] = useState(false);
  // Sum of every succeeded refund on this visit (deposit-side + cart-
  // payment-side combined). Surfaces as the "Refunded" line in the
  // Totals card so the breakdown explains the gap between the gross
  // captures shown above and the net amount_paid the view returns.
  // Without this row, "Paid -£760 + Refunded £0 + Owed back £55"
  // doesn't reconcile against the £700 subtotal after a £5 refund.
  const [refundedToDatePence, setRefundedToDatePence] = useState(0);
  const [refundsTick, setRefundsTick] = useState(0);
  // Refund sheet: opens from the owed-back banner (cart edit dropped
  // the cart below what was already paid) and from the cancelled /
  // ended-early flow. Same component for every entry point so the
  // audit shape is identical no matter how the refund was triggered.
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundDefaultCategory, setRefundDefaultCategory] = useState<
    'item_removed' | 'visit_cancelled' | 'visit_ended_early' | 'cart_correction'
  >('item_removed');
  // Send-receipt sheet — opens from the More menu's "Send receipt"
  // option (only shown when at least one payment has succeeded).
  const [sendReceiptOpen, setSendReceiptOpen] = useState(false);
  // Last-seen "owed back" amount + the trigger context staged by the
  // most recent cart mutation. The effect below fires a single
  // patient_events 'owed_to_patient' row whenever the derived owed
  // amount crosses upward (0→positive, or positive→bigger-positive).
  // The trigger ref lets each mutation handler stamp WHY before
  // refresh kicks off the recompute.
  const lastOwedRef = useRef(0);
  const pendingOwedTriggerRef = useRef<{
    trigger: OwedTrigger;
    reason: string;
    context?: Record<string, unknown>;
  } | null>(null);
  // Flag set by submitEndEarly so the refund sheet auto-opens on
  // the NEXT render once owedToPatientPence has settled to its
  // post-end-visit value. The previous shape checked owed at
  // submit time, but that reads the value from BEFORE the refresh
  // applies — typical case (paid-in-full booking, end early on an
  // intact cart) had owed=0 before submit and £X after, so the
  // check missed. Flag is cleared in the same effect that opens
  // the sheet (or by manual user interaction).
  const refundPromptOnEndVisitRef = useRef(false);
  const [shipToast, setShipToast] = useState<{ dispatch_ref: string; tracking_number: string | null } | null>(null);

  // Change-fulfilment sheet — opens post-completion when staff need
  // to flip in_person ↔ shipping (customer changes their mind about
  // collecting vs delivery). The choice is reversible while the visit
  // has no dispatch_ref; once a DPD label has been issued the change
  // path locks (the sheet shows the locked-state copy instead of the
  // picker). See updateVisitFulfilmentMethod in lib/queries/visits.ts.
  const [changeFulfilmentOpen, setChangeFulfilmentOpen] = useState(false);
  const [changeFulfilmentNext, setChangeFulfilmentNext] =
    useState<VisitFulfilmentMethod>('in_person');
  const [changeFulfilmentBusy, setChangeFulfilmentBusy] = useState(false);
  const [changeFulfilmentError, setChangeFulfilmentError] = useState<string | null>(null);

  // Estimated appointment length sheet — same modal AppointmentDetail
  // surfaces from its booked-for line. On the visit page the timeline
  // anchors on visit.opened_at (the actual arrival time) so the
  // projection reads as "from where the patient stands right now"
  // rather than rewinding to the original booked slot. Live phase
  // shape from the booking-type config — see appointmentLivePhases.ts
  // for why we read live vs the materialised snapshot.
  const [visitTimelineOpen, setVisitTimelineOpen] = useState(false);

  // Cart-level discount state. Apply / Amend / Remove share the same
  // sheet — amount (apply/amend), reason, then a ManagerNotificationNotice
  // that surfaces who'll get an emailed record of the action. Per the
  // May 2026 redesign there's no per-action manager picker — the
  // recipient list lives in Admin → Emails → Manager notifications,
  // and the send fires fire-and-forget after the action succeeds.
  const [discountSheet, setDiscountSheet] = useState<'apply' | 'amend' | 'remove' | null>(null);
  const [discountAmountText, setDiscountAmountText] = useState('');
  const [discountReason, setDiscountReason] = useState('');
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
      // Surface the Shopify credit independent of payment state so
      // the waiver signed at arrival already shows it as a
      // deduction. Without this the patient signs a doc that reads
      // "Total £399" + "Awaiting payment" and never sees that £140
      // is already covered online.
      shopifyCreditPence: shopifyOrder?.pence ?? 0,
      shopifyOrderName: shopifyOrder?.name ?? null,
      // Same reasoning for the deposit / paid-in-full collected at
      // booking. Top-level fields render on every waiver render
      // (arrival signing, post-payment receipt) regardless of cart
      // status. The previous shape only sourced these from `payment`
      // (set when cart.status='paid'), so an unpaid cart's waiver
      // missed the deposit credit entirely.
      depositPence: deposit?.status === 'paid' ? deposit.pence : 0,
      depositProvider: deposit?.status === 'paid' ? deposit.provider : null,
      depositSource: deposit?.status === 'paid' ? deposit.source : null,
      depositBrandId: deposit?.status === 'paid' ? deposit.brandId : null,
      depositPaidInFullAtBooking:
        deposit?.status === 'paid' ? deposit.paidInFullAtBooking : false,
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
              // Method comes from the actual succeeded payments on the
              // cart, not a hardcoded 'card'. Single method renders as
              // its own word ("Cash" / "Card" / "Gift card"); a split
              // payment renders as the methods joined ("Cash + Card").
              // Falls back to 'Card' only if the cart is paid but no
              // succeeded payment rows exist (defensive — shouldn't
              // happen, the cart only flips to paid when sum of
              // succeeded >= total).
              method: deriveWaiverPaymentMethod(paidPayments),
              takenAt: cart.closed_at ?? visit.opened_at,
              status: 'paid' as const,
              depositPence: deposit?.status === 'paid' ? deposit.pence : 0,
              depositProvider:
                deposit?.status === 'paid' ? deposit.provider : null,
              depositSource: deposit?.status === 'paid' ? deposit.source : null,
              depositBrandId: deposit?.status === 'paid' ? deposit.brandId : null,
              depositPaidInFullAtBooking:
                deposit?.status === 'paid' ? deposit.paidInFullAtBooking : false,
              shopifyCreditPence: shopifyOrder?.pence ?? 0,
              shopifyOrderName: shopifyOrder?.name ?? null,
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
  }, [visit, patient, appointment, receptionistName, items, patientSignedRows, requiredSections, cart, deposit, shopifyOrder, paidPayments]);


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
  // Load every succeeded refund tied to this visit (cart payments) or
  // the associated appointment's deposit. One query per axis so we
  // can sum both without joining server-side. Re-runs when refundsTick
  // flips after a fresh refund completes (RefundSheet.onCompleted).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let total = 0;
      if (cart?.id) {
        const { data: paymentRefunds } = await supabase
          .from('lng_payment_refunds')
          .select('amount_pence, payment:lng_payments!payment_id ( cart_id )')
          .eq('status', 'succeeded')
          .not('payment_id', 'is', null);
        if (cancelled) return;
        for (const r of (paymentRefunds ?? []) as Array<{
          amount_pence: number;
          payment:
            | { cart_id: string | null }
            | { cart_id: string | null }[]
            | null;
        }>) {
          const p = Array.isArray(r.payment) ? r.payment[0] ?? null : r.payment ?? null;
          if (p?.cart_id === cart.id) total += r.amount_pence ?? 0;
        }
      }
      if (visit?.appointment_id) {
        const { data: depositRefunds } = await supabase
          .from('lng_payment_refunds')
          .select('amount_pence')
          .eq('deposit_appointment_id', visit.appointment_id)
          .eq('status', 'succeeded');
        if (cancelled) return;
        for (const r of (depositRefunds ?? []) as Array<{ amount_pence: number }>) {
          total += r.amount_pence ?? 0;
        }
      }
      if (!cancelled) setRefundedToDatePence(total);
    })();
    return () => {
      cancelled = true;
    };
  }, [cart?.id, visit?.appointment_id, refundsTick]);
  // Shopify-paid order linked to the appointment. Already-paid online,
  // so it nets against the bill the same way the deposit does — the
  // till only collects whatever's left over.
  const shopifyCreditPence = shopifyOrder?.pence ?? 0;
  // Outstanding balance: read amount_paid_pence from the canonical
  // lng_visit_paid_status view (which already sums deposit + Shopify
  // credit + every succeeded lng_payments row) and subtract from the
  // discount-adjusted subtotal. This is the SAME formula Pay.tsx uses,
  // so the "To collect / Outstanding" number on this card and the
  // Take Payment screen always agree.
  //
  // The previous shape `subtotal - discount - deposit - shopify`
  // ignored till payments entirely, so a partially-paid cart on this
  // page still showed the gross-of-payments balance. A patient who
  // had paid £248 cash on a £298 cart with £25 deposit saw "To
  // collect £273" here while the Take Payment screen correctly
  // showed "Outstanding £25" — staff could collect £273 again,
  // double-charging by the £248 already in the till.
  const subtotalAfterDiscount = Math.max(0, subtotal - discount);
  const amountPaidPence = paidStatus?.amount_paid_pence ?? 0;
  const total = Math.max(0, subtotalAfterDiscount - amountPaidPence);
  // Inverse of the outstanding balance: when the patient has paid
  // more than the cart owes (cart item removed after a full pre-pay,
  // discount applied retroactively, etc) we owe THEM. The red banner
  // above the cart surfaces this so staff can issue a refund before
  // wrapping up the visit. Capped at amountPaidPence so a malformed
  // negative subtotal can't ask for a refund larger than was ever
  // collected.
  const owedToPatientPence = Math.min(
    amountPaidPence,
    Math.max(0, amountPaidPence - subtotalAfterDiscount),
  );

  // Owed-state transition logger. Writes a patient_events
  // 'owed_to_patient' row ONLY when a mutation handler has staged a
  // trigger AND the new owed amount is genuinely higher than the
  // last seen value.
  //
  // Why the staged-trigger gate: lastOwedRef resets to 0 on every
  // page mount, so opening a visit that's already in the owed
  // state would otherwise re-log the event every single time
  // (Dylan caught three duplicate rows from page reloads). The
  // event represents a moment-of-action — only mutation handlers
  // produce one. If staff lands on a pre-existing owed state with
  // no staged trigger, we just baseline the ref silently.
  useEffect(() => {
    if (!patient || !visit) return;
    const staged = pendingOwedTriggerRef.current;
    const prev = lastOwedRef.current;
    lastOwedRef.current = owedToPatientPence;
    // Mount / passive re-render: nothing staged, nothing to log.
    if (!staged) return;
    if (owedToPatientPence <= prev) return;
    if (owedToPatientPence <= 0) return;
    pendingOwedTriggerRef.current = null;
    void recordOwedToPatient({
      patient_id: patient.id,
      trigger: staged.trigger,
      owed_pence: owedToPatientPence,
      visit_id: visit.id,
      appointment_id: visit.appointment_id ?? null,
      reason:
        staged.reason ||
        'Cart total dropped below what the patient already paid.',
      context: {
        ...(staged.context ?? {}),
        previous_owed_pence: prev,
        new_owed_pence: owedToPatientPence,
        amount_paid_pence: amountPaidPence,
        cart_total_after_discount_pence: subtotalAfterDiscount,
      },
    });
  }, [owedToPatientPence, patient, visit, amountPaidPence, subtotalAfterDiscount]);

  // Refund-sheet auto-open after End-visit-early. The submit
  // handler stages the flag because the imperative check at
  // submit-time reads the PRE-refresh value of owedToPatientPence
  // (always 0 on a paid-in-full visit that's mid-action). This
  // effect waits for owedToPatientPence to actually settle and
  // then opens the sheet so staff doesn't have to hunt for the
  // Refund button on the cart card.
  useEffect(() => {
    if (!refundPromptOnEndVisitRef.current) return;
    if (owedToPatientPence <= 0) return;
    refundPromptOnEndVisitRef.current = false;
    setRefundOpen(true);
  }, [owedToPatientPence]);

  // Pence collected at the till today, separate from the deposit and
  // any Shopify pre-paid credit. Used in the Totals card breakdown
  // so we can show "Deposit -£X · Collected -£Y" without overlap.
  const tillCollectedPence = Math.max(
    0,
    amountPaidPence - depositPence - shopifyCreditPence,
  );
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

  const openCompleteVisit = async () => {
    if (!visit || !patient) return;
    // Block finish when there's money owed back to the patient.
    // The visit can't be properly closed out while the books say
    // the customer is overpaid — letting it through would leave
    // the owed amount unrefunded and orphaned on a closed visit
    // the receptionist might never reopen. Open the RefundSheet
    // instead with the canonical owed-money category. Once the
    // refund settles, owedToPatientPence drops to 0 and Finish
    // visit becomes available again.
    if (owedToPatientPence > 0) {
      setRefundDefaultCategory('item_removed');
      setRefundOpen(true);
      return;
    }
    setCompleteError(null);
    setCompleteMethod('in_person');
    // Skip the in-person / shipping sheet entirely when the cart's
    // catalogue lines all have fulfilment_required=false (virtual
    // sessions, in-person impression appointments). The decision is
    // moot — nothing's handed over, nothing's shipped — so we just
    // finish the visit directly. Falls back to opening the sheet on
    // any error reading the catalogue.
    try {
      const needsSheet = await visitRequiresFulfilment(visit.id);
      if (!needsSheet) {
        setCompleteBusy(true);
        try {
          await completeVisit({
            patient_id: patient.id,
            visit_id: visit.id,
            appointment_id: visit.appointment_id,
            walk_in_id: visit.walk_in_id,
            fulfilment_method: null,
            total_pence: total,
          });
          refresh();
        } catch (e) {
          setCompleteError(e instanceof Error ? e.message : 'Could not complete');
          setCompleteOpen(true);
        } finally {
          setCompleteBusy(false);
        }
        return;
      }
    } catch {
      // Fall through and show the sheet — safer than silently
      // auto-completing on a transient query error.
    }
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
      if (completeMethod === 'shipping') {
        setShipOpen(true);
      }
    } catch (e) {
      setCompleteError(e instanceof Error ? e.message : 'Could not complete');
    } finally {
      setCompleteBusy(false);
    }
  };

  // Open the change-method sheet pre-selecting the OPPOSITE of the
  // current fulfilment_method so the toggle reads as a "flip this"
  // action rather than a no-op confirmation. Disallowed when a DPD
  // label has been generated — the UI hides the change affordance in
  // that state, but we still guard here as belt-and-braces.
  const openChangeFulfilment = () => {
    if (!visit || !visit.fulfilment_method) return;
    if (visit.dispatch_ref) return;
    setChangeFulfilmentNext(visit.fulfilment_method === 'in_person' ? 'shipping' : 'in_person');
    setChangeFulfilmentError(null);
    setChangeFulfilmentOpen(true);
  };

  const submitChangeFulfilment = async () => {
    if (!visit || !patient || !visit.fulfilment_method) return;
    setChangeFulfilmentBusy(true);
    setChangeFulfilmentError(null);
    try {
      const result = await updateVisitFulfilmentMethod({
        visit_id: visit.id,
        patient_id: patient.id,
        expected_current_method: visit.fulfilment_method,
        next_method: changeFulfilmentNext,
      });
      if (!result.ok) {
        const msg =
          result.reason === 'shipment_dispatched'
            ? `Shipment already dispatched (${result.detail ?? 'see Shipment card'}). Cancel the shipment in DPD before changing the fulfilment method.`
            : result.reason === 'stale_method'
              ? result.detail ?? 'Method changed elsewhere. Refresh and try again.'
              : result.reason === 'not_found'
                ? 'Visit could not be found.'
                : result.reason === 'no_change'
                  ? 'Already set to that method.'
                  : (result.detail ?? 'Could not update fulfilment method.');
        setChangeFulfilmentError(msg);
        return;
      }
      setChangeFulfilmentOpen(false);
      refresh();
      // Switching FROM in_person TO shipping → drop straight into the
      // shipping sheet so the receptionist can create the DPD label
      // without an extra click. The same hop that happens on the
      // original Finish-visit flow.
      if (changeFulfilmentNext === 'shipping') {
        setShipOpen(true);
      }
    } catch (e) {
      setChangeFulfilmentError(e instanceof Error ? e.message : 'Could not update fulfilment method');
    } finally {
      setChangeFulfilmentBusy(false);
    }
  };

  const openDiscountSheet = (mode: 'apply' | 'amend' | 'remove') => {
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
    setDiscountSheet(mode);
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
      pendingOwedTriggerRef.current = {
        trigger: 'cart_discount_applied',
        reason:
          discountReason.trim().length > 0
            ? `${formatPence(pence)} discount applied: ${discountReason.trim()}`
            : `${formatPence(pence)} discount applied.`,
        context: {
          cart_id: cart.id,
          discount_amount_pence: pence,
          discount_reason: discountReason.trim() || null,
        },
      };
      // Resolve the recipient list ONCE before the action so the
      // exact set notified ends up on both the audit row AND the
      // email send below. Reading lng_settings between the two
      // could yield two different snapshots if an admin edits the
      // list mid-action — which would split the audit story.
      const recipients = await listResolvedManagerRecipients().catch(() => []);
      const notifiedIds = recipients.map((r) => r.accountId);
      await applyCartDiscount({
        cart_id: cart.id,
        amount_pence: pence,
        reason: discountReason,
        notified_account_ids: notifiedIds,
      });
      void sendManagerNotification({
        actionKind: 'discount_applied',
        amountPence: pence,
        reason: discountReason.trim(),
        patientId: patient?.id ?? null,
        visitId: visit?.id ?? null,
        staffAccountId: currentAccount?.account_id ?? null,
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
      const removedAmount = activeDiscount?.amount_pence ?? 0;
      const recipients = await listResolvedManagerRecipients().catch(() => []);
      const notifiedIds = recipients.map((r) => r.accountId);
      await removeCartDiscount({
        cart_id: cart.id,
        reason: discountReason,
        notified_account_ids: notifiedIds,
      });
      void sendManagerNotification({
        actionKind: 'discount_removed',
        amountPence: removedAmount,
        reason: discountReason.trim(),
        patientId: patient?.id ?? null,
        visitId: visit?.id ?? null,
        staffAccountId: currentAccount?.account_id ?? null,
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
      const recipients = await listResolvedManagerRecipients().catch(() => []);
      const notifiedIds = recipients.map((r) => r.accountId);
      await amendCartDiscount({
        cart_id: cart.id,
        amount_pence: pence,
        reason: discountReason,
        notified_account_ids: notifiedIds,
      });
      void sendManagerNotification({
        actionKind: 'discount_amended',
        amountPence: pence,
        reason: discountReason.trim(),
        patientId: patient?.id ?? null,
        visitId: visit?.id ?? null,
        staffAccountId: currentAccount?.account_id ?? null,
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
      // Stamp the owed-trigger BEFORE the mutation so the post-
      // refresh effect picks up the right context when it fires.
      // Best-effort: we lift the line's display name + unit price
      // from the current cart so the timeline row reads cleanly
      // ("Decreased Whitening Tray from 2 to 1") without joining
      // back to the cart_items table later.
      const line = items.find((it) => it.id === id);
      if (line) {
        pendingOwedTriggerRef.current = {
          trigger: 'cart_quantity_decreased',
          reason: `Decreased ${line.name} from ${q} to ${q - 1}.`,
          context: {
            cart_item_id: id,
            catalogue_id: line.catalogue_id,
            line_name: line.name,
            unit_price_pence: line.unit_price_pence,
            quantity_before: q,
            quantity_after: q - 1,
          },
        };
      }
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
      // Stage the owed-trigger before mutation so the post-refresh
      // effect logs with rich context (line name, reason category,
      // staff note).
      pendingOwedTriggerRef.current = {
        trigger: 'cart_line_removed',
        reason:
          removeNote.trim().length > 0
            ? `Removed ${itemBeingRemoved.name}: ${removeNote.trim()}`
            : `Removed ${itemBeingRemoved.name}.`,
        context: {
          cart_item_id: removeItemId,
          catalogue_id: itemBeingRemoved.catalogue_id,
          line_name: itemBeingRemoved.name,
          line_total_pence: itemBeingRemoved.line_total_pence,
          remove_reason: removeReason,
          remove_note: removeNote.trim() || null,
        },
      };
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
  const canEndEarly = visit?.status === 'arrived';
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
      // Stage the owed-trigger so the post-refresh effect logs the
      // visit-ended-early reason against any newly-overpaid balance.
      // Captures the staff-typed reason verbatim so the timeline row
      // reads exactly what was given.
      pendingOwedTriggerRef.current = {
        trigger: 'visit_ended_early',
        reason: `Visit ended early (${endReason}): ${unsuitNote.trim()}`,
        context: {
          visit_id: visit.id,
          end_reason: endReason,
          end_note: unsuitNote.trim(),
        },
      };
      // One atomic RPC for both branches (unsuitable picks + the
      // non-clinical end-visit reasons). Prior code looped
      // removeCartLineWithReason() N times on the unsuitable path,
      // which left a half-written window if the tab closed
      // mid-loop — some lines soft-deleted, visit row not yet
      // flipped, refund banner racing the cart-empty check.
      const picks =
        endReason === 'unsuitable'
          ? unsuitItemIds
              .map((id) => unsuitEligibleItems.find((x) => x.id === id))
              .filter((it): it is (typeof unsuitEligibleItems)[number] => !!it)
              .map((it) => ({ cart_item_id: it.id, catalogue_id: it.catalogue_id }))
          : undefined;
      await endVisitEarly({
        patient_id: patient.id,
        visit_id: visit.id,
        reason: endReason,
        note: unsuitNote,
        picks,
      });
      setUnsuitOpen(false);
      refresh();
      refreshPaid();
      // Pre-set the category so the sheet opens on the right
      // option once it does open. The auto-open effect below
      // watches owedToPatientPence after the refresh applies.
      setRefundDefaultCategory('visit_ended_early');
      refundPromptOnEndVisitRef.current = true;
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
      const previousNote = (visit.notes ?? '').trim();
      const nextNote = trimmed;
      // Skip the round-trip when nothing changed — the dialog still
      // closes (idempotent save) but we don't write a no-op event
      // to the timeline.
      if (previousNote === nextNote) {
        setNoteOpen(false);
        return;
      }
      const { error: err } = await supabase
        .from('lng_visits')
        .update({ notes: nextNote.length > 0 ? nextNote : null })
        .eq('id', visit.id);
      if (err) throw new Error(err.message);
      // Audit row for the timeline. Three distinct event types so
      // the visit timeline can render add / edit / remove with the
      // right verb (rather than collapsing to one ambiguous
      // "tech_note_changed"). Best-effort — the dialog still closes
      // even if the audit insert fails so a single-write hiccup
      // doesn't block the operator from saving.
      const eventType = !previousNote
        ? 'visit_tech_note_added'
        : !nextNote
          ? 'visit_tech_note_removed'
          : 'visit_tech_note_edited';
      await supabase.from('patient_events').insert({
        patient_id: visit.patient_id,
        event_type: eventType,
        actor_account_id: currentAccount?.account_id ?? null,
        payload: {
          visit_id: visit.id,
          // Short preview so the timeline can show a snippet of
          // the new note without rendering the full body. Trimmed
          // to ~120 chars + ellipsis; the full text always lives
          // on lng_visits.notes for anyone needing the canonical
          // copy.
          preview: nextNote.length > 0 ? nextNote.slice(0, 120) : null,
          truncated: nextNote.length > 120,
          previous_length: previousNote.length || null,
          length: nextNote.length || null,
        },
      });
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

  const printLabel = async (labelData: string | null) => {
    if (!labelData) { setError('No label data stored for this shipment.'); return; }
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
      const res = await fetch(`${supabaseUrl}/functions/v1/render-lng-label`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          Authorization:   `Bearer ${session?.access_token ?? anonKey}`,
          apikey:          anonKey,
        },
        body: JSON.stringify({ zpl: labelData }),
      });
      if (!res.ok) throw new Error('Label render failed');
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      window.open(url, '_blank', 'width=520,height=580');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not render label.');
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
                {...buildVisitHeroProps(
                  visit,
                  appointment,
                  patient,
                  cart,
                  latestUnsuitable,
                  items.length > 0,
                  total,
                  openChangeFulfilment,
                  visitLivePhases.length > 1
                    ? () => setVisitTimelineOpen(true)
                    : null,
                  refundedToDatePence,
                  amountPaidPence,
                )}
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
              {/* Customer service note for the clinic floor. Sits
                  directly under the visit hero so the team sees it
                  before any other card on the page. Editable by any
                  active Lounge staff at any time — audit row written
                  to patient_events on every save. The note lives on
                  lng_appointments.notes so it travels with the
                  appointment through every reschedule and across the
                  booked → arrived → joined → complete lifecycle.
                  Gated on visit.appointment_id so the hero never
                  renders for walk-ins (no appointment row, no notes
                  field on lng_walk_ins yet). */}
              {appointment && visit?.appointment_id ? (
                <div style={{ marginTop: theme.space[4] }}>
                  <AppointmentNotesHero
                    appointmentId={appointment.id}
                    notes={appointment.notes}
                    onChanged={refreshVisitDetail}
                  />
                </div>
              ) : null}
              <BottomSheet
                open={visitTimelineOpen}
                onClose={() => setVisitTimelineOpen(false)}
                title="Estimated appointment length"
                description={
                  appointment ? (
                    <span>
                      Anchored on the patient's arrival time
                      ({formatTime(visit.opened_at)}) — when each
                      phase happens from this point, and when they're
                      free to step away.
                    </span>
                  ) : null
                }
              >
                <PhaseTimeline phases={visitLivePhases} />
              </BottomSheet>
            </div>

            {/* Online-order banner — only renders for visits where the
                appointment was created from a venneir.com Shopify
                order. Loud, branded, clickable through to the admin
                order so staff can verify the credit independently of
                what the patient says they paid. Sits directly under
                the hero so it lands in the first scan of the page. */}
            {shopifyOrder ? (
              <div style={{ marginBottom: theme.space[6] }}>
                <ShopifyOrderCard order={shopifyOrder} />
              </div>
            ) : null}

            {/* Patient comms — only renders while the visit is live in
                clinic (status='arrived'). Earlier states haven't had
                an arrival yet so there's no "your work is ready"
                signal to send; later states (complete, ended_early,
                unsuitable) mean the patient has already left or the
                visit is closed, and a notification after the fact
                would be misleading. Hidden from CS-only staff — they
                handle pre/post-visit comms through a different
                channel and shouldn't be able to fire a "ready to
                collect" SMS on a live in-clinic visit.

                The card itself now renders further down the column,
                directly under RescheduleAfterArrivalNote, so the
                primary in-clinic surface stays focused on the
                appointment / waiver / cart. */}

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

            {/* Whole Cart card dims when the visit is unsuitable
                AND there's no outstanding financial action — title,
                items, subtotal, totals all go quiet. The action row
                below stays at full opacity so the Reverse affordance
                reads as the only live thing.

                When the patient is owed money back, we DON'T dim:
                staff still needs to read the owed amount and click
                Refund. Dimming the alert at 55% opacity would defeat
                the whole point of surfacing it. Once the refund is
                issued (owed drops to 0) the dim returns. */}
            <div style={isUnsuitable && owedToPatientPence === 0 ? { opacity: 0.55 } : undefined}>
            <Card padding="lg">
              {cart?.status === 'paid' ? (
                <PaidHeader
                  amountPence={cart.total_pence}
                  paidAt={cart.closed_at ?? null}
                  payments={paidPayments}
                />
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: theme.space[4] }}>
                  <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
                    Cart
                  </h2>
                  {items.length > 0 && !productiveLocked && !isCsOnly ? (
                    <Button variant="secondary" size="sm" onClick={openPicker}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                        <Plus size={16} /> Add item
                      </span>
                    </Button>
                  ) : null}
                </div>
              )}

              {cartLoading ? (
                <p style={{ color: theme.color.inkMuted }}>Loading cart…</p>
              ) : items.length === 0 ? (
                isVisitEnded ? (
                  // Terminal-state empty cart. The "No items yet" /
                  // "Add item" prompt is misleading here because (a)
                  // the cart isn't editable and (b) lines were just
                  // soft-deleted by the end-visit action, not "never
                  // added". The Totals block below still renders any
                  // financial state (owed-back banner, payments
                  // taken) so staff can see what they need to refund
                  // before the visit can be wrapped up.
                  <EmptyState
                    icon={<ShoppingCart size={20} />}
                    title="Cart closed"
                    description={
                      visit?.status === 'unsuitable'
                        ? 'Lines that were in the cart were removed when the visit was marked unsuitable. Resume the visit to bring them back.'
                        : 'Lines that were in the cart were removed when the visit ended early. Resume the visit to bring them back.'
                    }
                    action={null}
                  />
                ) : (
                  <EmptyState
                    icon={<ShoppingCart size={20} />}
                    title="No items yet"
                    description="Pick from the shared catalogue. Suggestions populate based on the booking type and intake answers."
                    action={
                      isCsOnly ? null : (
                        <Button variant="primary" onClick={openPicker} disabled={productiveLocked}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                            <Plus size={16} /> Add item
                          </span>
                        </Button>
                      )
                    }
                  />
                )
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
                        readOnly={isCsOnly}
                      />
                    );
                  })}
                </div>
              )}

              {/* Render Totals when there's anything financial to
                  show — even with an empty cart. For an ended visit
                  the active items are zero but the payment + refund
                  + deposit + owed-back state still needs to drive
                  staff to action (issue the refund before wrapping
                  up). Without this branch the only place the owed
                  amount appeared was buried in the timeline, which
                  Dylan reported as "we ended visit but owe the
                  customer money, so it won't show?". */}
              {items.length > 0
                || amountPaidPence > 0
                || refundedToDatePence > 0
                || depositPence > 0 ? (
                <Totals
                  subtotal={subtotal}
                  discount={discount}
                  depositPence={depositPence}
                  deposit={deposit}
                  shopifyCreditPence={shopifyCreditPence}
                  shopifyOrderName={shopifyOrder?.name ?? null}
                  tillCollectedPence={tillCollectedPence}
                  total={total}
                  owedToPatientPence={owedToPatientPence}
                  refundedToDatePence={refundedToDatePence}
                  patientFirstName={patient?.first_name ?? null}
                  onOpenRefund={() => {
                    setRefundDefaultCategory(
                      // On a terminal-state visit the canonical
                      // refund reason is the visit ending, not a
                      // single line removal — the prefilled
                      // category reflects that.
                      isVisitEnded ? 'visit_ended_early' : 'item_removed'
                    );
                    setRefundOpen(true);
                  }}
                  // Suppress the giant "Outstanding £X.XX" row when the
                  // cart is paid — the PaidHeader above already carries
                  // that amount, and showing it twice was the exact
                  // ambiguity that made it impossible to tell at a
                  // glance whether the visit was paid or outstanding.
                  hideTotalRow={cart?.status === 'paid'}
                  // Once paid, Subtotal / Discount / Deposit / Collected
                  // rows are reference-only — keep them readable but
                  // step them back so the eye stays on the PaidHeader
                  // as the headline fact.
                  dim={cart?.status === 'paid'}
                  // Approver row renders directly under the Discount
                  // line so the reason + amend / remove controls sit
                  // visually attached to what they affect. Was
                  // previously a separate row below the totals that
                  // read as floating, with no connection to the
                  // discount line above.
                  activeDiscount={activeDiscount}
                  onAmendDiscount={() => openDiscountSheet('amend')}
                  onRemoveDiscount={() => openDiscountSheet('remove')}
                  discountEditable={!productiveLocked && !isCsOnly}
                />
              ) : null}

              {/* Apply-discount affordance — only renders when the cart
                  has items, is mutable, and no active discount yet.
                  Once a discount is applied the approver row inside
                  Totals (above) carries the Amend / Remove buttons. */}
              {items.length > 0 && !productiveLocked && !activeDiscount && !isCsOnly ? (
                <div
                  style={{
                    marginTop: theme.space[3],
                    display: 'flex',
                    justifyContent: 'flex-end',
                  }}
                >
                  <ApplyDiscountLink onClick={() => openDiscountSheet('apply')} />
                </div>
              ) : null}
            </Card>
            </div>

            {/* Action row is always visible when the visit exists,
                EXCEPT for Customer Service-only staff. CS agents
                can't touch the till, edit notes, print LWOs, or
                end the visit — those are clinic-floor actions. They
                see the cart read-only and that's the end of their
                authority on this page. */}
            {!isCsOnly ? (
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
              {/* More menu — folds the secondary destructive /
                  irreversible affordances behind one dropdown so
                  the primary action row stays focused on the cart
                  + the primary CTA. Each item only renders when
                  its preconditions are met (same gates the inline
                  buttons used to have):
                    • End visit early — when canEndEarly
                    • Refund         — when any payment captured
                    • Send receipt   — when any payment captured
                  When none of the three apply, the More button
                  doesn't render at all. */}
              {(() => {
                const moreItems: ActionMenuItem[] = [];
                if (canEndEarly) {
                  moreItems.push({
                    key: 'end_visit_early',
                    label: 'End visit early',
                    hint: 'Mark this visit unsuitable or stopped before completion. Cart lines are removed.',
                    icon: <Ban size={16} aria-hidden />,
                    tone: 'alert',
                    onClick: () => openEndEarly(),
                  });
                }
                if (amountPaidPence > 0) {
                  moreItems.push({
                    key: 'refund',
                    label: 'Refund',
                    hint: 'Send money back against a captured payment or deposit.',
                    icon: <RotateCcw size={16} aria-hidden />,
                    onClick: () => {
                      // Default to cart_correction — the most
                      // common ad-hoc refund reason outside the
                      // owed-back banner flow.
                      setRefundDefaultCategory('cart_correction');
                      setRefundOpen(true);
                    },
                  });
                  moreItems.push({
                    key: 'send_receipt',
                    label: 'Send receipt',
                    hint: 'Resend the receipt for the most recent payment, email or SMS.',
                    icon: <Receipt size={16} aria-hidden />,
                    onClick: () => setSendReceiptOpen(true),
                  });
                }
                if (moreItems.length === 0) return null;
                return (
                  <ActionMenu
                    presentation="sheet"
                    sheetTitle="More visit actions"
                    sheetDescription="Pick an action below. Each one is the irreversible affordance pulled out of the main row."
                    ariaLabel="More visit actions"
                    items={moreItems}
                    trigger={
                      <Button variant="secondary">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                          <MoreHorizontal size={16} aria-hidden />
                          More
                        </span>
                      </Button>
                    }
                  />
                );
              })()}
              {visit.status === 'complete' && visit.fulfilment_method === 'shipping' && !visit.dispatch_ref ? (
                // Visit completed with shipping method but dispatch not yet
                // processed (e.g. sheet was closed before submitting).
                <Button variant="primary" onClick={() => setShipOpen(true)}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                    <Package size={16} aria-hidden />
                    Process shipping
                  </span>
                </Button>
              ) : isUnsuitable ? (
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
                  // becomes Finish visit; the sheet asks the
                  // in-person-vs-shipping question.
                  <Button variant="primary" onClick={openCompleteVisit} disabled={visit.status === 'complete'}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                      <CheckCircle size={16} aria-hidden />
                      Finish visit
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
                  {/* Quick actions block — Patient profile only.
                      Reschedule is intentionally NOT here once the
                      patient has been marked arrived: rescheduling
                      mid-visit would orphan the cart, the waiver
                      signatures, the JB ref, and any payments
                      already collected. The right flow is to End
                      visit and create a fresh booking. The note
                      directly under the actions explains that —
                      reschedule still lives on the pre-arrival
                      page (AppointmentDetail) where the booking
                      hasn't yet committed any of those side
                      effects. */}
                  {patient ? (
                    <>
                      <RescheduleAfterArrivalNote />
                      {/* Send-an-SMS card sits directly under the
                          reschedule note, gated on arrival + non-CS
                          staff for the same reasons as before:
                          terminal statuses or CS-only staff would
                          either fire a misleading SMS or use a
                          different channel. */}
                      {visit.status === 'arrived' && !isCsOnly ? (
                        <PatientCommsCard
                          visitId={visit.id}
                          patientId={patient.id}
                          patientPhone={patient.phone ?? null}
                          patientFirstName={patient.first_name ?? null}
                          cartSignature={items
                            .map((it) => `${it.service_type ?? ''}|${it.product_key ?? ''}`)
                            .sort()
                            .join(';')}
                        />
                      ) : null}
                      <VisitActionStack
                        onPatientProfile={() =>
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
                      />
                    </>
                  ) : null}
                  {visit.dispatch_ref ? (
                    <ShippedItemsCard visit={visit} onPrintLabel={() => printLabel(visit.label_data)} />
                  ) : null}
                  {/* What the patient picked at booking — paid upgrades
                      and (for denture-repair bookings) the per-arch
                      repair lines. Renders nothing when both lists are
                      empty so the visit page doesn't grow a placeholder
                      for every booking. */}
                  <AppointmentExtras
                    upgrades={appointmentUpgrades}
                    repairItems={appointmentRepairItems}
                  />
                  {/* Pre-visit smile photos — the intake photos the
                      patient uploaded from the booking-confirmation
                      screen, sitting just above the before/after
                      gallery so the reference shots and the live
                      progress shots read as one media block. Click-in
                      veneers only. */}
                  {visit.appointment_id &&
                  configFor(
                    appointment?.service_type,
                    appointment?.product_key,
                    productConfig,
                  ).request_smile_photos ? (
                    <SmilePhotosCard
                      appointmentId={visit.appointment_id}
                      patientId={patient?.id}
                      patientName={patient ? patientFullName(patient) : undefined}
                      uploaderAccountId={currentAccount?.account_id ?? null}
                      onPromoted={refreshGalleryFiles}
                    />
                  ) : null}
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
                  <ContinuousTimeline
                    appointmentId={visit.appointment_id ?? null}
                    visitId={visit.id}
                  />
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


      <RefundSheet
        open={refundOpen}
        onClose={() => setRefundOpen(false)}
        cartId={cart?.id ?? null}
        appointmentId={visit?.appointment_id ?? null}
        suggestedPence={owedToPatientPence}
        defaultCategory={refundDefaultCategory}
        patientId={patient?.id ?? null}
        visitId={visit?.id ?? null}
        staffAccountId={currentAccount?.account_id ?? null}
        onCompleted={() => {
          // Re-pull paid-status + cart-payment list so the banner
          // disappears immediately on a clean refund and the
          // captured-payments list reflects the new remaining
          // balances. Also tick the refunds counter so the Totals
          // "Refunded" line picks up the new total.
          refreshPaid();
          setRefundsTick((t) => t + 1);
        }}
      />

      {/* Send-receipt sheet. Attaches to the most recent
          succeeded payment so a resend lands on the same Stripe /
          cash row the original receipt would have referenced.
          Gated by the More menu — it's only invocable when at
          least one payment exists, so paidPayments[0] is safe. */}
      <SendReceiptSheet
        open={sendReceiptOpen}
        onClose={() => setSendReceiptOpen(false)}
        paymentId={paidPayments[0]?.id ?? null}
        patientEmail={patient?.email ?? null}
        patientPhone={patient?.phone ?? null}
      />

      {visit && patient ? (
        <ShipVisitSheet
          open={shipOpen}
          onClose={() => setShipOpen(false)}
          visitId={visit.id}
          patientId={patient.id}
          items={items}
          staffName={currentAccount?.display_name ?? receptionistName ?? ''}
          onShipped={(result) => {
            setShipOpen(false);
            setShipToast({ dispatch_ref: result.dispatch_ref, tracking_number: result.tracking_number });
            refresh();
          }}
        />
      ) : null}

      {shipToast ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast
            tone="success"
            title={`Dispatched · ${shipToast.dispatch_ref}`}
            description={
              shipToast.tracking_number
                ? `DPD tracking: ${shipToast.tracking_number}`
                : 'Label created. Tracking number unavailable.'
            }
            duration={8000}
            onDismiss={() => setShipToast(null)}
          />
        </div>
      ) : null}

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
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          <Section
            title="Reason"
            required
            sub="Pick why this line is being removed. Drives whether we record an unsuitability against the product."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {([
                { value: 'mistake', label: 'Added by mistake', sub: 'Staff picked the wrong product. No clinical meaning.' },
                { value: 'changed_mind', label: 'Patient changed mind', sub: 'Patient declined this product today.' },
                { value: 'unsuitable', label: 'Patient unsuitable', sub: 'Clinical decision. Reason required, lands on timeline.' },
              ] as const).map((opt) => (
                <ReasonCard
                  key={opt.value}
                  selected={removeReason === opt.value}
                  label={opt.label}
                  sub={opt.sub}
                  onSelect={() => setRemoveReason(opt.value)}
                />
              ))}
            </div>
          </Section>

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
            <Section
              title={removeReason === 'unsuitable' ? 'Reason note' : 'Note'}
              required={removeReason === 'unsuitable'}
              sub={
                removeReason === 'unsuitable'
                  ? 'Be specific. This lands on the patient timeline so the next clinician can see why.'
                  : 'Optional. Anything worth recording about why the patient declined.'
              }
            >
              <textarea
                value={removeNote}
                onChange={(e) => setRemoveNote(e.target.value)}
                rows={4}
                placeholder={
                  removeReason === 'unsuitable'
                    ? 'Why is the patient unsuitable for this product?'
                    : 'Anything worth recording.'
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
                  outline: 'none',
                }}
              />
            </Section>
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
          end the visit on a non-clinical reason. Submit calls
          endVisitEarly once (single lng_end_visit_early RPC); the
          server soft-deletes the cart lines, stamps visit_end_reason
          + visit_end_note, and writes the timeline events in one
          transaction. Reverse restores only the lines this action
          removed (unsuitable + visit_ended_early reasons); manual
          pre-end-visit removals stay removed. */}
      <BottomSheet
        open={unsuitOpen}
        onClose={() => !unsuitBusy && setUnsuitOpen(false)}
        dismissable={!unsuitBusy}
        title="End visit early"
        description={
          sheetWillEndVisit
            ? 'The visit ends here. Lines removed by this action come back if you Reverse later. Lines you removed earlier in the visit stay removed (any refunds already issued for them stay applied). Only an admin can reverse outside the app.'
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          <Section
            title="Reason category"
            required
            sub="Pick the closest fit. The choice drives whether we record an unsuitability against products or close the visit on a non-clinical reason."
          >
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
                  <ReasonCard
                    key={opt.value}
                    selected={isSel}
                    label={opt.label}
                    sub={opt.sub}
                    onSelect={() => setEndReason(opt.value)}
                  />
                );
              })}
            </div>
          </Section>

          {endReason === 'unsuitable' && unsuitEligibleItems.length > 0 ? (
            <Section
              title="Products"
              required
              sub="Tick every product the patient was unsuitable for today. Visit ends if you tick everything in the basket."
            >
              <MultiSelectDropdown<string>
                ariaLabel="Products"
                values={unsuitItemIds}
                options={unsuitEligibleItems.map((it) => ({ value: it.id, label: it.name }))}
                onChange={(next) => setUnsuitItemIds(next)}
                placeholder="Pick from the basket"
                totalNoun="products"
              />
            </Section>
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

          <Section
            title="Reason"
            required
            sub={
              endReason === 'unsuitable'
                ? 'Be specific. This lands on the patient timeline so the next clinician can see why.'
                : 'Be specific. This lands on the patient timeline.'
            }
          >
            <textarea
              value={unsuitNote}
              onChange={(e) => setUnsuitNote(e.target.value)}
              rows={5}
              placeholder={
                endReason === 'unsuitable'
                  ? 'Why is the patient unsuitable for these products?'
                  : 'Why is the visit ending early?'
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
                outline: 'none',
              }}
            />
          </Section>

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

      {/* Finish visit sheet — fired by the primary CTA when the
          balance is fully settled. Asks the fulfilment question and
          writes the choice to lng_visits.fulfilment_method via
          completeVisit. The shipping branch opens ShipVisitSheet
          immediately after so staff can create the DPD label. */}
      <BottomSheet
        open={completeOpen}
        onClose={() => !completeBusy && setCompleteOpen(false)}
        dismissable={!completeBusy}
        title="Finish visit"
        description={
          completeMethod === 'shipping'
            ? 'The visit closes and the shipping form opens next so you can create the DPD label.'
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
                <CheckCircle size={16} aria-hidden /> Finish visit
              </span>
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          <Section
            title="How is the work being handed off?"
            required
            sub="Pick how the patient is leaving with the work today. Shipping opens the dispatch form next."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {([
                { value: 'in_person', label: 'Passed to patient', sub: 'Patient is taking the work today.' },
                { value: 'shipping', label: 'To be shipped', sub: 'Work is being dispatched. We move to the shipping flow next.' },
              ] as const).map((opt) => (
                <ReasonCard
                  key={opt.value}
                  selected={completeMethod === opt.value}
                  label={opt.label}
                  sub={opt.sub}
                  onSelect={() => setCompleteMethod(opt.value)}
                />
              ))}
            </div>
          </Section>

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

      {/* Change-fulfilment sheet — opens after completion when staff need
          to flip in_person ↔ shipping. Picker mirrors the Finish-visit
          sheet, but the submit calls updateVisitFulfilmentMethod and
          the copy explicitly says "Change" so staff don't think they're
          re-finishing. */}
      <BottomSheet
        open={changeFulfilmentOpen}
        onClose={() => !changeFulfilmentBusy && setChangeFulfilmentOpen(false)}
        dismissable={!changeFulfilmentBusy}
        title="Change fulfilment"
        description={
          changeFulfilmentNext === 'shipping'
            ? 'Switch to shipping. The visit stays complete; the dispatch form opens next so you can create the DPD label.'
            : 'Switch to passing the work to the patient. The visit stays complete; no shipment is created.'
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
            <Button
              variant="secondary"
              onClick={() => setChangeFulfilmentOpen(false)}
              disabled={changeFulfilmentBusy}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <X size={16} aria-hidden /> Cancel
              </span>
            </Button>
            <Button variant="primary" onClick={submitChangeFulfilment} loading={changeFulfilmentBusy}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <RotateCcw size={16} aria-hidden /> Save change
              </span>
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          <Section
            title="How is the work being handed off?"
            required
            sub="The customer changed how they want the work delivered. Pick the new method below."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {([
                { value: 'in_person', label: 'Passed to patient', sub: 'Patient is collecting / has collected the work.' },
                { value: 'shipping', label: 'To be shipped', sub: 'Work is being dispatched. The shipping form opens next.' },
              ] as const).map((opt) => (
                <ReasonCard
                  key={opt.value}
                  selected={changeFulfilmentNext === opt.value}
                  label={opt.label}
                  sub={opt.sub}
                  onSelect={() => setChangeFulfilmentNext(opt.value)}
                />
              ))}
            </div>
          </Section>

          {changeFulfilmentError ? (
            <p
              role="alert"
              style={{
                margin: 0,
                color: theme.color.alert,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
              }}
            >
              {changeFulfilmentError}
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
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
            <DiscountIcon size={20} />
            {discountSheet === 'remove'
              ? 'Remove discount'
              : discountSheet === 'amend'
                ? 'Amend discount'
                : 'Apply discount'}
          </span>
        }
        description={
          discountSheet === 'remove'
            ? 'Removing the discount restores the full bill. The configured managers will be notified by email about what changed.'
            : discountSheet === 'amend'
              ? 'Change the amount or reason. The patient sees the new total immediately; the configured managers will be notified by email.'
              : 'Sale-wide discount on this visit. The configured managers will be notified by email with a summary of what was applied.'
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
              numericFormat="currency"
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
          <ManagerNotificationNotice />
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

// Tappable reason card used inside the End-visit-early, Remove-line,
// and Finish-visit sheets. Bold label + muted sub on a flat surface;
// selected state lifts the border to ink and tints the fill.
function ReasonCard({
  selected,
  label,
  sub,
  onSelect,
}: {
  selected: boolean;
  label: string;
  sub: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        appearance: 'none',
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        padding: `${theme.space[4]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        border: `1.5px solid ${selected ? theme.color.ink : theme.color.border}`,
        background: selected ? 'rgba(14, 20, 20, 0.04)' : theme.color.surface,
        color: theme.color.ink,
        fontFamily: 'inherit',
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 18,
          height: 18,
          marginTop: 2,
          borderRadius: '50%',
          border: `1.5px solid ${selected ? theme.color.ink : theme.color.border}`,
          background: theme.color.surface,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      >
        {selected ? (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: theme.color.ink,
            }}
          />
        ) : null}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
        <span
          style={{
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.normal,
          }}
        >
          {sub}
        </span>
      </span>
    </button>
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
  cart: { status: 'open' | 'paid' | 'voided'; closed_at: string | null; total_pence: number } | null,
  latestUnsuitable: { recorded_at: string | null } | null,
  hasItems: boolean,
  outstandingPence: number,
  onChangeFulfilment: () => void,
  onShowTimeline: (() => void) | null,
  refundedToDatePence: number,
  amountPaidPence: number,
): Omit<AppointmentHeroProps, 'trailing'> {
  const isWalkIn = visit.arrival_type === 'walk_in';
  const headlineIso: string = !isWalkIn && appointment ? appointment.start_at : visit.opened_at;
  const dateLong = formatDateLongOrdinal(headlineIso);
  // Service title for the hero ribbon. Routes through the shared
  // formatAppointmentSummary helper so visitDetail reads identically
  // to the schedule list, the popup preview, and the appointment
  // detail hero. Walk-in rows fall back to a generic label.
  const service = appointment
    ? formatAppointmentSummary(appointment) ||
      humaniseEventTypeLabel(appointment.event_type_label ?? null) ||
      (isWalkIn ? 'Walk-in' : 'Appointment')
    : isWalkIn
      ? 'Walk-in'
      : 'Appointment';

  // State-driven ribbon — every (visit status × cart status × walk-in
  // vs scheduled) combination resolves to a single triple of icon +
  // anchor + action prompt. The relative slot lands in the accent
  // colour, so action prompts there pull the operator's eye to the
  // next thing on the page (Add item / Take payment / Finish visit).
  const ribbon = buildVisitRibbon({
    visit,
    appointment,
    isWalkIn,
    cart,
    hasItems,
    outstandingPence,
    onShowTimeline,
  });

  // Pills row — visit status always; cart status when one exists and
  // the visit isn't terminated (a "Cart open" pill on an unsuitable
  // visit is misleading because the cart's locked anyway). On
  // completed visits we ALSO surface a fulfilment-method pill that
  // doubles as the Change-method button — staff scan the hero for
  // current state AND can tap the chip to flip in_person ↔ shipping
  // without leaving the hero.
  const pills: AppointmentHeroPill[] = [
    { tone: visitStatusTone(visit.status), label: visitStatusLabel(visit.status) },
  ];
  const isTerminated = visit.status === 'unsuitable' || visit.status === 'ended_early';
  // Refund axis pill. When money has been returned AND the cart is
  // net-out-of-pocket, displace the "Paid in full" cart status with
  // a refund label so the hero never reads as "Paid in full" when
  // funds were partially or fully clawed back (Dylan's UX call — one
  // pill, refund takes precedence).
  //
  // The pill reflects the CURRENT net state of the till, not the
  // cumulative refund history. A cycle of pay → refund → pay-again
  // ends at "Paid in full", not "Partially refunded" — because the
  // second payment cancelled out the prior refund. Reading
  // refundedToDatePence in isolation would loop the pill forever,
  // since that lifetime sum only ever grows. The check here gates
  // on whether the patient currently has MORE money out than in:
  //
  //   • amountPaidPence (from lng_visit_paid_status) is already net
  //     of every succeeded refund whose underlying payment is still
  //     succeeded. So when a refund has been compensated for by a
  //     subsequent payment, amountPaidPence climbs back up.
  //   • cartTotalPence anchors the "fully paid" threshold. If
  //     amountPaidPence >= cartTotalPence, the cart is settled
  //     regardless of how many refund/pay cycles preceded it.
  //
  // So:
  //   • net == 0 AND refunds exist           → "Refunded"
  //   • 0 < net < cartTotal AND refunds exist → "Partially refunded £X"
  //     where X is what's still outside the till net (cartTotal − net),
  //     i.e. what re-payment is needed to clear the bill again
  //   • otherwise (net >= cartTotal, or net > 0 with no refunds) →
  //     fall through to the regular cart-status pill
  const cartTotalPence = cart?.total_pence ?? 0;
  const isFullyRefunded = refundedToDatePence > 0 && amountPaidPence <= 0;
  const isPartiallyRefunded =
    refundedToDatePence > 0 &&
    amountPaidPence > 0 &&
    amountPaidPence < cartTotalPence;
  if (cart && !isTerminated) {
    if (isFullyRefunded || isPartiallyRefunded) {
      // Partial-refund amount = what's currently outside the till
      // (cartTotal − net), matching the "still owed by patient"
      // figure the cart breakdown shows. Reading
      // refundedToDatePence directly would be the lifetime
      // refund sum, which can be larger than the current
      // outstanding when re-payments have happened in between.
      const outstandingFromRefundsPence = Math.max(
        0,
        cartTotalPence - amountPaidPence,
      );
      pills.push({
        tone: 'refunded',
        label: isFullyRefunded
          ? 'Refunded'
          : `Partially refunded ${formatPence(outstandingFromRefundsPence)}`,
      });
    } else {
      pills.push({
        tone: cart.status === 'paid' ? 'arrived' : cart.status === 'open' ? 'neutral' : 'no_show',
        label: cartStatusLabel(cart.status),
      });
    }
  }
  if (visit.status === 'complete' && visit.fulfilment_method) {
    const isShipping = visit.fulfilment_method === 'shipping';
    const dispatched = !!visit.dispatch_ref;
    // Label distinguishes three states so the hero reads correctly
    // through the whole lifecycle:
    //   • Passed to patient  → patient walked out with the work
    //   • To be shipped       → fulfilment chosen, DPD label not yet created
    //   • Shipped to patient → DPD label exists; work is on its way
    // The previous code kept "To be shipped" forever even after the
    // shipment had gone out, which read as "still pending dispatch"
    // long after the parcel had been collected.
    const label = !isShipping
      ? 'Passed to patient'
      : dispatched
        ? 'Shipped to patient'
        : 'To be shipped';
    pills.push({
      tone: dispatched ? 'arrived' : isShipping ? 'pending' : 'arrived',
      label,
      icon: isShipping ? <Package size={12} aria-hidden /> : <UserCheck size={12} aria-hidden />,
      // Once a DPD label is issued, the change action locks — staff
      // must cancel the shipment first. Pill stays visible as a
      // status indicator without the onClick affordance.
      onClick: dispatched ? undefined : onChangeFulfilment,
      trailingHint: dispatched ? undefined : 'Change',
    });
  }

  // Subtitle — refs first (MP, LAP, JB), then the SourceGlyph + arrival
  // type. Switched from a plain string to JSX so the walk-in / widget
  // / Calendly icon (the same one the schedule cards show) sits inline
  // before the arrival-type label. Keeps the at-a-glance source signal
  // consistent across every surface a visit appears on. The icon is
  // driven by the appointment.source when present, falling back to
  // 'manual' for pure walk-ins with no calendar marker row — both
  // render the Footprints icon, so the visual is identical.
  const textParts: string[] = [];
  if (showableRef(patient?.internal_ref)) textParts.push(patient!.internal_ref);
  if (appointment?.appointment_ref) textParts.push(appointment.appointment_ref);
  if (appointment?.jb_ref) textParts.push(`JB${appointment.jb_ref}`);
  textParts.push(isWalkIn ? 'Walk-in' : 'Scheduled');
  const subtitleSource = (appointment?.source ?? 'manual') as AppointmentSource;
  // Render each ref token in a nowrap span so a narrow viewport
  // wraps BETWEEN tokens rather than mid-token. Without this the
  // mobile hero could break "LAP-00416" across two lines, which
  // looks like data corruption at a glance.
  const subtitle = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        rowGap: 2,
      }}
    >
      <SourceGlyph source={subtitleSource} size={12} />
      {textParts.map((part, i) => (
        <span key={`${part}|${i}`} style={{ whiteSpace: 'nowrap' }}>
          {i > 0 ? <span style={{ color: theme.color.inkSubtle, marginRight: 6 }}>·</span> : null}
          {part}
        </span>
      ))}
    </span>
  );

  // Suppress unused-arg warning until we surface the unsuitable-at
  // moment in the ribbon copy. Keeping the arg in the signature so
  // future enrichment doesn't need a callsite churn.
  void latestUnsuitable;

  return {
    patient: { name: patient ? patientFullName(patient) : 'Patient', avatarSrc: patient?.avatar_data ?? null },
    pills,
    subtitle,
    when: {
      dateLong,
      timeLine: ribbon.timeLine,
      relative: ribbon.relative,
      secondary: ribbon.secondary ?? null,
      service,
      tone: ribbon.tone,
      icon: ribbon.icon,
    },
  };
}

// Single source of truth for the visit ribbon. Each branch returns a
// fully-formed (icon + anchor + relative + tone) — no shared
// scaffolding, because the language for "stopped, case unsuitable"
// shouldn't look like the language for "patient in the clinic". The
// relative slot is the accent-coloured one in the renderer, so
// action prompts ("Build the cart", "Take payment", "Ready to
// finish") land there to pull the operator forward. Terminal states
// drop the prompt and use a relative time instead.
function buildVisitRibbon({
  visit,
  appointment,
  isWalkIn,
  cart,
  hasItems,
  outstandingPence,
  onShowTimeline,
}: {
  visit: VisitRow;
  appointment: VisitAppointmentContext | null;
  isWalkIn: boolean;
  cart: { status: 'open' | 'paid' | 'voided'; closed_at: string | null } | null;
  hasItems: boolean;
  // Pence still owed at the till after deposit / paid-in-full /
  // Shopify credit / earlier till payments. Drives the "Take payment"
  // vs "Ready to finish" prompt — a £0 outstanding (paid in full at
  // booking, fully covered by Shopify credit, etc.) means there is
  // literally nothing to collect, so the prompt must not say
  // "Take payment" or staff will tap into a £0 till flow.
  outstandingPence: number;
  /** When non-null, the active-visit ribbon appends an inline
   *  "Estimated appointment length" link that opens the phase
   *  timeline modal. Caller passes null when the live config has
   *  zero or one phase (no useful breakdown to show) or for walk-ins
   *  (no service-specific phase shape to project). */
  onShowTimeline: (() => void) | null;
}): {
  icon: ReactNode;
  timeLine: ReactNode;
  relative: string | null;
  /** Standalone affordance rendered on its own row beneath the time
   * anchor — used to surface "Estimated appointment length →" for
   * the live in-clinic state without dragging it inline. */
  secondary?: ReactNode | null;
  tone: AppointmentHeroTone;
} {
  // Terminal visit states ignore cart status — once a visit is
  // complete/unsuitable/ended_early the cart can't change, and
  // "stopped, case unsuitable" reads more clearly than mixing in
  // payment fact.
  if (visit.status === 'complete') {
    const closed = visit.closed_at ?? visit.opened_at;
    const rel = closed ? relativeMinutes(closed) : null;
    const isPaid = cart?.status === 'paid';
    return {
      icon: <CheckCircle2 size={16} aria-hidden />,
      timeLine: isPaid ? 'Visit complete, paid in full' : 'Visit complete',
      relative: rel,
      tone: 'accent',
    };
  }
  if (visit.status === 'unsuitable') {
    const closed = visit.closed_at ?? visit.opened_at;
    const rel = closed ? relativeMinutes(closed) : null;
    return {
      icon: <Ban size={16} aria-hidden />,
      timeLine: 'Stopped, case unsuitable',
      relative: rel,
      tone: 'warn',
    };
  }
  if (visit.status === 'ended_early') {
    const closed = visit.closed_at ?? visit.opened_at;
    const rel = closed ? relativeMinutes(closed) : null;
    return {
      icon: <CircleSlash size={16} aria-hidden />,
      timeLine: 'Visit ended early',
      relative: rel,
      tone: 'warn',
    };
  }

  // visit.status === 'arrived' from here on. Branch on cart state.
  if (cart?.status === 'paid') {
    return {
      icon: <BadgeCheck size={16} aria-hidden />,
      timeLine: 'Paid in full',
      relative: 'Ready to finish',
      tone: 'accent',
    };
  }
  if (cart?.status === 'voided') {
    return {
      icon: <RotateCcw size={16} aria-hidden />,
      timeLine: 'Payment voided',
      relative: 'Take payment again',
      tone: 'warn',
    };
  }

  // Cart is open (or absent). Anchor reads the chronological fact —
  // when the patient walked in plus, for scheduled visits, the slot
  // they were booked into. Scheduled visits show BOTH times so the
  // reception team and the patient can see at a glance how arrival
  // tracked against the booking ("Booked for 09:15 · Arrived 09:23").
  // Walk-ins show only the arrival time because there's no booking
  // slot to compare against. An "Estimated appointment length" link
  // sits after the times for scheduled visits whose service has a
  // multi-phase config — clicking opens the timeline modal anchored
  // on the actual arrival time (not the original booked time) so
  // the projection reflects reality from the moment the patient
  // walked in.
  const arrivedStr = formatTime(visit.opened_at);
  // Time anchor — kept clean of the Estimated-appointment-length
  // affordance. The link is surfaced on its own row via `secondary`
  // below so a narrow viewport never orphans a "·" separator above
  // it.
  const anchor: ReactNode = isWalkIn ? (
    `Walked in ${arrivedStr}`
  ) : appointment ? (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        flexWrap: 'wrap',
        gap: 6,
      }}
    >
      <span>Booked for {formatTime(appointment.start_at)}</span>
      <span style={{ color: theme.color.inkSubtle }}>·</span>
      <span>Arrived {arrivedStr}</span>
    </span>
  ) : (
    'Patient in clinic'
  );
  // Relative prompt ("Take payment" / "Build the cart" / "Ready to
  // finish") was reading as redundant alongside the primary CTA
  // further down the page — the operator already knows what to do.
  // Dropped from the ribbon so the time line is the only thing
  // there. Keep arrivedStr-aware variables in case we resurface a
  // contextual phrase later.
  void hasItems;
  void outstandingPence;
  return {
    icon: <UserCheck size={16} aria-hidden />,
    timeLine: anchor,
    relative: null,
    secondary: onShowTimeline ? <VisitTimelineLink onClick={onShowTimeline} /> : null,
    tone: 'accent',
  };
}

// Inline "Estimated appointment length" affordance. Same chrome as
// the AppointmentDetail TimelineLink — accent underlined pill with
// a trailing chevron — but defined locally on the visit page so the
// two surfaces evolve independently if they ever need to diverge.
function VisitTimelineLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        background: 'transparent',
        border: 'none',
        padding: 0,
        margin: 0,
        fontFamily: 'inherit',
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.semibold,
        color: theme.color.accent,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        textUnderlineOffset: 3,
        textDecoration: 'underline',
      }}
    >
      Estimated appointment length
      <ArrowRight size={12} aria-hidden />
    </button>
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

// Visit-status helpers. The DB stores the raw enum (opened /
// in_progress / complete / cancelled); the UI shows humanised copy
// to match the other status pills in the app.
function visitStatusLabel(s: 'arrived' | 'complete' | 'unsuitable' | 'ended_early'): string {
  switch (s) {
    case 'arrived':
      return 'Arrived';
    case 'complete':
      return 'Complete';
    case 'unsuitable':
      return 'Unsuitable';
    case 'ended_early':
      return 'Ended early';
  }
}
function visitStatusTone(s: 'arrived' | 'complete' | 'unsuitable' | 'ended_early') {
  switch (s) {
    case 'arrived':
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
      // Headline language used everywhere a paid sale appears (waiver
      // PDF, ledger pill, this hero). "Cart paid" reads as jargon —
      // "Paid in full" reads as plain English a non-staff onlooker
      // can interpret in a glance.
      return 'Paid in full';
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
  deposit,
  shopifyCreditPence,
  shopifyOrderName,
  tillCollectedPence,
  total,
  owedToPatientPence,
  refundedToDatePence,
  patientFirstName,
  onOpenRefund,
  hideTotalRow = false,
  dim = false,
  activeDiscount,
  onAmendDiscount,
  onRemoveDiscount,
  discountEditable = false,
}: {
  subtotal: number;
  discount: number;
  depositPence: number;
  /** Full deposit row so we can render a brand-aware suffix
   *  ("Stripe via venneir.com" for widget bookings vs the legacy
   *  "Stripe via Calendly"). Null when no deposit was taken. */
  deposit: AppointmentDeposit | null;
  shopifyCreditPence: number;
  shopifyOrderName: string | null;
  /** Pence already collected at the till (cash + card + BNPL combined),
   *  separate from the deposit and Shopify credit. Surfaces as an
   *  explicit "Collected -£X" line so the breakdown reconciles to
   *  the new outstanding number. */
  tillCollectedPence: number;
  total: number;
  /** Amount we owe back to the patient. Positive when amount_paid
   *  exceeds the cart total. Drives the bottom-row swap from
   *  "Outstanding £0.00" (which read as "all good") to
   *  "Owed back £60.00" in red. The full "We owe Dylan £60.00 ·
   *  Issue refund before completing" copy + Refund button live in
   *  this same row now — no separate banner above the cart. */
  owedToPatientPence: number;
  /** Sum of every succeeded refund tied to this visit (cart-payment
   *  refunds + deposit refunds combined). Surfaces as a "Refunded"
   *  line so the breakdown reconciles after a refund has clawed
   *  money back from the gross captures above. */
  refundedToDatePence: number;
  patientFirstName: string | null;
  onOpenRefund: () => void;
  /** When true, suppress the bottom "Outstanding £X.XX" hero row —
   * used when the cart is paid and the PaidHeader already states the
   * amount. */
  hideTotalRow?: boolean;
  /** When true, fade the breakdown rows so the eye stays on the
   * PaidHeader. Used when the cart is paid. */
  dim?: boolean;
  /** When set, renders the discount approver + reason as an indented
   *  hairline row immediately under the Discount line so staff can
   *  see at a glance what was applied + by whom. Used for cart-wide
   *  discounts (per-line discounts don't have an audit row). */
  activeDiscount?: { applier_name: string | null; reason: string } | null;
  onAmendDiscount?: () => void;
  onRemoveDiscount?: () => void;
  /** When true, the Amend / Remove buttons render under the
   *  approver row. Productive locks (paid / voided / unsuitable /
   *  ended-early) flip this off so the cart can't be mutated. */
  discountEditable?: boolean;
}) {
  // Any credit at all on the bill flips the headline label from
  // "Total" (full bill) to "Outstanding" (what's left after credits +
  // till payments). Includes till payments — a £248 cash payment on
  // a £298 cart is itself a credit even when no deposit exists.
  const hasCredit = depositPence > 0 || shopifyCreditPence > 0 || tillCollectedPence > 0;
  return (
    <div
      style={{
        marginTop: theme.space[6],
        paddingTop: theme.space[5],
        borderTop: `1px solid ${theme.color.border}`,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
        opacity: dim ? 0.55 : 1,
      }}
    >
      <Row label="Subtotal" value={formatPence(subtotal)} />
      {discount > 0 ? (
        activeDiscount ? (
          // Manager-approved cart discount: the Discount row AND
          // the approver row live inside the same accent banner so
          // the reduction + its authorisation read as one unit.
          <DiscountBanner
            amountPence={discount}
            applierName={activeDiscount.applier_name}
            reason={activeDiscount.reason}
            onAmend={discountEditable ? onAmendDiscount : undefined}
            onRemove={discountEditable ? onRemoveDiscount : undefined}
          />
        ) : (
          // Per-line discounts (no manager approval) — plain row.
          <Row label="Discount" value={`-${formatPence(discount)}`} />
        )
      ) : null}
      {/* Apply refunds against the gross captures so the breakdown
          reads as the NET money on file with no "+£5" cognitive
          load. Greedy waterfall: deposit absorbs first (the most
          common refund source), then till, then Shopify credit.
          Each row shows its net value; a small sub-line under the
          row spells out the gross + refund history in plain English
          ("£760.00 paid · £5.00 refunded back to James") so the
          audit is still visible at a glance. */}
      {(() => {
        let remainingRefund = refundedToDatePence;
        const depositRefund = Math.min(depositPence, remainingRefund);
        remainingRefund -= depositRefund;
        const tillRefund = Math.min(tillCollectedPence, remainingRefund);
        remainingRefund -= tillRefund;
        const shopifyRefund = Math.min(shopifyCreditPence, remainingRefund);
        const refundedAwayCopy = patientFirstName
          ? `refunded back to ${patientFirstName}`
          : 'refunded back to patient';
        return (
          <>
            {depositPence > 0 ? (
              <CreditRow
                label={`${deposit?.paidInFullAtBooking ? 'Paid in full' : 'Deposit'} (${formatDepositSourceSuffix(deposit)})`}
                grossPence={depositPence}
                refundedPence={depositRefund}
                refundedAwayCopy={refundedAwayCopy}
              />
            ) : null}
            {shopifyCreditPence > 0 ? (
              <CreditRow
                label={shopifyOrderName ? `Online order ${shopifyOrderName} (venneir.com)` : 'Online order (venneir.com)'}
                grossPence={shopifyCreditPence}
                refundedPence={shopifyRefund}
                refundedAwayCopy={refundedAwayCopy}
              />
            ) : null}
            {tillCollectedPence > 0 ? (
              <CreditRow
                label="Collected at till"
                grossPence={tillCollectedPence}
                refundedPence={tillRefund}
                refundedAwayCopy={refundedAwayCopy}
              />
            ) : null}
          </>
        );
      })()}
      {owedToPatientPence > 0 ? (
        // Overpaid state. The bottom row now folds the standalone
        // "We owe X" banner into itself so the explanation + Refund
        // button live alongside the amount. One alert block, not two.
        //
        // NOT gated on hideTotalRow — even when the cart is 'paid'
        // (PaidHeader rendering above), an owed-back amount must
        // still surface. Concrete case: visit ends early after a
        // paid-in-full booking, cart.status stays 'paid' but
        // subtotal drops to £0, so the patient is owed back what
        // they already paid. Without this row the staff has no
        // affordance to issue the refund and the "Resume visit"
        // button reads as the only action.
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[3],
            paddingTop: theme.space[3],
            marginTop: theme.space[2],
            borderTop: `1px solid ${theme.color.alert}`,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
            }}
          >
            <span
              style={{
                fontSize: theme.type.size.md,
                color: theme.color.alert,
                fontWeight: theme.type.weight.semibold,
              }}
            >
              Owed back
            </span>
            <span
              style={{
                fontSize: theme.type.size.xxl,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.alert,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatPence(owedToPatientPence)}
            </span>
          </div>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.sm,
              color: theme.color.alert,
              lineHeight: 1.5,
            }}
          >
            {patientFirstName ? `We owe ${patientFirstName} ` : 'We owe the patient '}
            {formatPence(owedToPatientPence)}. The cart dropped below what they
            paid. Issue a refund before completing the visit.
          </p>
          <button
            type="button"
            onClick={onOpenRefund}
            style={{
              alignSelf: 'flex-start',
              appearance: 'none',
              border: 'none',
              borderRadius: theme.radius.input,
              background: theme.color.alert,
              color: '#fff',
              padding: `${theme.space[2]}px ${theme.space[4]}px`,
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Refund {formatPence(owedToPatientPence)}
          </button>
        </div>
      ) : hideTotalRow ? null : (
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
            {hasCredit ? 'Outstanding' : 'Total'}
          </span>
          <span style={{ fontSize: theme.type.size.xxl, fontWeight: theme.type.weight.semibold, color: theme.color.ink, fontVariantNumeric: 'tabular-nums' }}>
            {formatPence(total)}
          </span>
        </div>
      )}
    </div>
  );
}

// PaidHeader — inline header rendered at the top of the Cart card when
// cart.status='paid'. Replaces the "Cart" h2 + "Add item" row entirely.
// Deliberately NOT a nested card — that earlier nesting read as visual
// noise. Just typography, an icon, and a divider so the card chrome
// stays one surface and the line items below read as a receipt.
//
//   ✓  Paid in full
//      £1.00  ·  Received in cash · today at 08:16
//   ─────────────────────────────────────────────────
//
// Multi-method splits roll up by method (e.g. "£50.00 cash + £50.00
// card") so a 3-payment cart still prints as a single line.
function PaidHeader({
  amountPence,
  paidAt,
  payments,
}: {
  amountPence: number;
  paidAt: string | null;
  payments: CartPaymentRow[];
}) {
  const methodBreakdown = formatMethodBreakdown(payments);
  const when = paidAt ? `${formatPaidAtDate(paidAt)} at ${formatTime(paidAt)}` : null;
  const meta = [methodBreakdown, when].filter(Boolean).join(' · ');
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        marginBottom: theme.space[4],
        paddingBottom: theme.space[4],
        borderBottom: `1px solid ${theme.color.border}`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 40,
          height: 40,
          borderRadius: theme.radius.pill,
          background: theme.color.accentBg,
          color: theme.color.accent,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <BadgeCheck size={20} aria-hidden />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
            lineHeight: 1.2,
          }}
        >
          Paid in full
          <span
            style={{
              marginLeft: theme.space[3],
              fontSize: theme.type.size.lg,
              color: theme.color.ink,
              fontVariantNumeric: 'tabular-nums',
              fontWeight: theme.type.weight.semibold,
            }}
          >
            {formatPence(amountPence)}
          </span>
        </h2>
        {meta ? (
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: 1.3,
            }}
          >
            {meta}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// Renders captured payments as a single human line. One method →
// "Received in cash." Two methods → "£50 cash + £50 card." Used by
// PaidBanner so the meta line stays compact regardless of split count.
function formatMethodBreakdown(payments: CartPaymentRow[]): string {
  if (payments.length === 0) return '';
  if (payments.length === 1) {
    return `Received in ${humanisePaymentMethod(payments[0]!.method)}`;
  }
  // Group by method so a 3-payment split (e.g. £20 cash + £20 cash +
  // £40 card) prints as "£40.00 cash + £40.00 card", not three rows.
  const totals = new Map<PaymentMethod, number>();
  for (const p of payments) {
    totals.set(p.method, (totals.get(p.method) ?? 0) + p.amount_pence);
  }
  const parts = Array.from(totals.entries()).map(
    ([m, sum]) => `${formatPence(sum)} ${humanisePaymentMethod(m)}`,
  );
  return parts.join(' + ');
}

// Builds the payment-method string the waiver document prints under
// the cart total. Single-method paid carts get the method name on its
// own ('cash' / 'card' / 'gift card'). Split payments get the unique
// methods joined ('cash + card'). The waiver renderer runs the result
// through properCase, so each word ends up capitalised in the PDF.
//
// 'paid' carts should always have at least one succeeded payment row
// (the trigger that flips status only fires once sum(succeeded) >=
// total), but if the row is missing we fall back to 'card' rather
// than printing an empty line. That fallback is the only place a
// hardcoded method survives — every real path now reflects what the
// patient actually paid with.
function deriveWaiverPaymentMethod(payments: CartPaymentRow[]): string {
  const methods: PaymentMethod[] = [];
  for (const p of payments) {
    if (!methods.includes(p.method)) methods.push(p.method);
  }
  if (methods.length === 0) return 'card';
  return methods.map((m) => humanisePaymentMethod(m)).join(' + ');
}

function humanisePaymentMethod(m: PaymentMethod): string {
  switch (m) {
    case 'cash':
      return 'cash';
    case 'card_terminal':
      return 'card';
    case 'gift_card':
      return 'gift card';
    case 'account_credit':
      return 'account credit';
    default:
      return m;
  }
}

function formatPaidAtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return 'today';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function ShopifyOrderCard({
  order,
}: {
  order: { id: string; name: string; pence: number; currency: string };
}) {
  // Loud, branded callout for visits that originated from a
  // venneir.com Shopify order. Anti-fraud guard rail — staff have
  // a one-click verification path (opens the order in Shopify
  // admin) so a claim like "they already paid £X online" can't
  // be taken on trust. Visual mirrors the MeetingLinkCard idiom
  // on AppointmentDetail (left-edge brand stripe + brand icon +
  // copy-style action row) so the two anchor surfaces read as
  // one family.
  const shopifyForest = '#5E8E3E';
  // shopify_order_id is the raw Shopify numeric id stored on
  // lng_appointments at booking time; admin.shopify.com routes
  // /store/venneir/orders/<id> straight to the order page once
  // the operator is signed into the admin.
  const adminUrl = `https://admin.shopify.com/store/venneir/orders/${order.id}`;
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        background: theme.color.surface,
        borderRadius: theme.radius.card,
        boxShadow: theme.shadow.card,
        border: `1px solid ${theme.color.border}`,
        borderLeft: `3px solid ${shopifyForest}`,
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginBottom: theme.space[3] }}>
        <ShopifyIcon size={18} title="Shopify" />
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Online order from venneir.com
        </span>
      </div>

      <a
        href={adminUrl}
        target="_blank"
        rel="noopener noreferrer"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          background: hovered ? 'rgba(94,142,62,0.10)' : 'rgba(94,142,62,0.06)',
          border: `1px solid rgba(94,142,62,${hovered ? '0.32' : '0.16'})`,
          borderRadius: 10,
          padding: `${theme.space[2] + 2}px ${theme.space[3]}px`,
          textDecoration: 'none',
          transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, gap: 2 }}>
          <span
            style={{
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              color: shopifyForest,
              fontVariantNumeric: 'tabular-nums',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {order.name}
          </span>
          <span
            style={{
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            Paid online · {formatPence(order.pence)} credited against the bill
          </span>
        </div>

        <div style={{ width: 1, height: 28, background: 'rgba(94,142,62,0.22)', flexShrink: 0 }} aria-hidden />

        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            fontSize: theme.type.size.xs,
            fontWeight: theme.type.weight.semibold,
            color: shopifyForest,
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          <ExternalLink size={13} aria-hidden />
          View in Shopify
        </span>
      </a>

      <p
        style={{
          margin: `${theme.space[2]}px 0 0`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkSubtle,
          lineHeight: theme.type.leading.snug,
        }}
      >
        Open the order in Shopify to confirm the patient paid {formatPence(order.pence)} {order.currency} online. The same amount is automatically credited against the cart below.
      </p>
    </div>
  );
}

function ApplyDiscountLink({ onClick }: { onClick: () => void }) {
  // Link-style affordance for the cart's "Apply discount" entry
  // point. A standard pill button reads as a primary action, but
  // the discount flow is a quiet secondary path the operator opts
  // into. Underlined-text-plus-glyph is the in-app cue for "this
  // takes you somewhere", same vocabulary as anchor links.
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        padding: 0,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[2],
        color: hover ? theme.color.ink : theme.color.inkMuted,
        fontFamily: 'inherit',
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.medium,
        textDecoration: 'underline',
        textUnderlineOffset: '3px',
      }}
    >
      <DiscountIcon size={14} />
      Apply discount
    </button>
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

// CreditRow — a Totals row for a payment-credit line (deposit /
// Shopify / till) that already knows about refunds against it.
// Renders the value as NET (gross - refunds) on the right so the
// reader doesn't have to do "+£5 means…" math. When a refund has
// chipped away at the gross, a muted sub-line under the row spells
// out the history in plain English ("£760.00 paid · £5.00 refunded
// back to James"). When refundedPence is zero the row reads
// identically to the old plain Row.
function CreditRow({
  label,
  grossPence,
  refundedPence,
  refundedAwayCopy,
}: {
  label: string;
  grossPence: number;
  refundedPence: number;
  refundedAwayCopy: string;
}) {
  const netPence = Math.max(0, grossPence - refundedPence);
  const hasRefund = refundedPence > 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>{label}</span>
        <span
          style={{
            color: theme.color.accent,
            fontVariantNumeric: 'tabular-nums',
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
          }}
        >
          {`-${formatPence(netPence)}`}
        </span>
      </div>
      {hasRefund ? (
        <span
          style={{
            display: 'block',
            textAlign: 'right',
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            lineHeight: 1.4,
          }}
        >
          {`${formatPence(grossPence)} paid · `}
          {/* Refund clause is the part staff need to spot at a
              glance — money has left the till. Bold + alert tone
              lifts it off the muted audit line so a quick scan
              registers "this column had a refund" without reading
              the whole sentence. */}
          <strong
            style={{
              color: theme.color.alert,
              fontWeight: theme.type.weight.semibold,
            }}
          >
            {`${formatPence(refundedPence)} ${refundedAwayCopy}`}
          </strong>
        </span>
      ) : null}
    </div>
  );
}

// Combined Discount row + approver banner. Renders the reduction
// amount and the authorising-manager / reason / controls inside
// one soft accent box so the bill, the approval, and the controls
// all read as a single unit. Mirrors the muted treatment used for
// status banners elsewhere (Waiver card, paid pill) without
// competing with them.
function DiscountBanner({
  amountPence,
  applierName,
  reason,
  onAmend,
  onRemove,
}: {
  amountPence: number;
  applierName: string | null;
  reason: string;
  onAmend: (() => void) | undefined;
  onRemove: (() => void) | undefined;
}) {
  return (
    <div
      style={{
        background: theme.color.accentBg,
        borderRadius: theme.radius.input,
        padding: `${theme.space[3]}px ${theme.space[3]}px`,
        marginTop: theme.space[1],
        marginBottom: theme.space[1],
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
      }}
    >
      {/* Top — the Discount amount line. Same layout as the other
          Totals rows so the eye lands on the same right-aligned
          number column. */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
        }}
      >
        <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          Discount
        </span>
        <span
          style={{
            color: theme.color.accent,
            fontVariantNumeric: 'tabular-nums',
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
          }}
        >
          -{formatPence(amountPence)}
        </span>
      </div>
      {/* Bottom — approver + controls. */}
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
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[2],
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            lineHeight: theme.type.leading.snug,
            minWidth: 0,
            fontWeight: theme.type.weight.medium,
          }}
        >
          <span style={{ display: 'inline-flex', flexShrink: 0 }} aria-hidden>
            <DiscountIcon size={14} color={theme.color.accent} />
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {applierName ? `Applied by ${applierName}` : 'Discount applied'}
            {reason ? ` · ${reason}` : ''}
          </span>
        </span>
        {(onAmend || onRemove) ? (
          <div style={{ display: 'flex', gap: theme.space[1], flexShrink: 0 }}>
            {onAmend ? (
              <Button variant="tertiary" size="sm" onClick={onAmend}>
                Amend
              </Button>
            ) : null}
            {onRemove ? (
              <Button variant="tertiary" size="sm" onClick={onRemove}>
                Remove
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Shipped items card ────────────────────────────────────────────────────────
// Collapsible section shown when the visit has a completed dispatch.
// On mount, fires fill-lng-parcel-code once as a fast path. The server-side
// pg_cron job (sync-parcel-codes, every 3 min) handles ongoing sync.
// Realtime on lng_visits drives all UI updates — no client polling.

const DPD_REGISTRATION_WINDOW_MS = 30 * 60 * 1000; // typical DPD registration time

function ShippedItemsCard({
  visit,
  onPrintLabel,
}: {
  visit: VisitRow;
  onPrintLabel: () => void;
}) {
  const addr = visit.shipping_address;
  const trackingUrl = visit.parcel_code
    ? `https://track.dpdlocal.co.uk/parcels/${visit.parcel_code}#results`
    : null;

  // One-shot fast path: trigger fill-lng-parcel-code immediately on mount.
  // If the parcel code is already in Checkpoint's queue this resolves in ~3s.
  // The pg_cron job handles the ongoing sync if DPD hasn't registered yet.
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (visit.parcel_code || !visit.tracking_number) return;

    const anonKey     = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
    let alive = true;

    setChecking(true);
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        await fetch(`${supabaseUrl}/functions/v1/fill-lng-parcel-code`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization:  `Bearer ${session?.access_token ?? anonKey}`,
            apikey:          anonKey,
          },
          body: JSON.stringify({ visit_id: visit.id }),
        });
        // Realtime picks up any parcel_code write and re-renders this component.
      } catch { /* non-fatal */ }
      if (alive) setChecking(false);
    })();

    return () => { alive = false; };
  }, [visit.id, visit.tracking_number, visit.parcel_code]); // eslint-disable-line react-hooks/exhaustive-deps

  // Progress bar: fills over DPD_REGISTRATION_WINDOW_MS from dispatch.
  // Computed once per render — updates whenever Realtime triggers a re-render.
  const elapsedMs = visit.dispatched_at
    ? Date.now() - new Date(visit.dispatched_at).getTime()
    : 0;
  const elapsedMin = Math.floor(elapsedMs / 60000);
  const progressPct = Math.min((elapsedMs / DPD_REGISTRATION_WINDOW_MS) * 100, 96);

  const addrLines = addr
    ? [addr.name, addr.address1, addr.address2, addr.city, addr.zip].filter(Boolean)
    : [];

  const dispatchedAt = visit.dispatched_at
    ? new Date(visit.dispatched_at).toLocaleString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : null;

  const emailSentAt = visit.shipping_email_sent_at
    ? new Date(visit.shipping_email_sent_at).toLocaleString('en-GB', {
        day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit',
      })
    : null;

  return (
    <CollapsibleCard
      icon={
        // Same 30px accent-tinted chip the Patient profile and the
        // RescheduleAfterArrivalNote headers use on this page —
        // without it the Shipped-items section read as a different
        // visual family from the rest of the page chrome. Truck
        // reads as shipping more directly than the generic Package
        // glyph the section used to carry.
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: theme.radius.pill,
            background: theme.color.accentBg,
            color: theme.color.accent,
            flexShrink: 0,
          }}
        >
          <Truck size={15} aria-hidden />
        </span>
      }
      title="Shipped items"
      defaultOpen
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>

        {/* Dispatch reference + timestamp */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
          <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium, color: theme.color.inkMuted }}>
            Dispatch reference
          </p>
          <p style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.ink, fontFamily: 'monospace', letterSpacing: theme.type.tracking.tight }}>
            {visit.dispatch_ref}
          </p>
          {dispatchedAt ? (
            <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
              {dispatchedAt}{visit.dispatched_by ? ` · ${visit.dispatched_by}` : ''}
            </p>
          ) : null}
        </div>

        <hr style={{ margin: 0, border: 'none', borderTop: `1px solid ${theme.color.border}` }} />

        {/* Tracking */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium, color: theme.color.inkMuted }}>
            DPD tracking
          </p>

          {visit.tracking_number ? (
            trackingUrl ? (
              <a
                href={trackingUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: theme.space[1],
                  color: theme.color.accent, fontSize: theme.type.size.base,
                  fontWeight: theme.type.weight.semibold, textDecoration: 'none',
                  fontFamily: 'monospace', letterSpacing: theme.type.tracking.tight,
                }}
              >
                {visit.tracking_number}
                <ExternalLink size={14} aria-hidden />
              </a>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
                <p style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.inkMuted, fontFamily: 'monospace', letterSpacing: theme.type.tracking.tight }}>
                  {visit.tracking_number}
                </p>

                {/* Progress bar */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                  <div style={{
                    height: 4, borderRadius: 999,
                    background: theme.color.border,
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      height: '100%',
                      width: `${progressPct}%`,
                      borderRadius: 999,
                      background: theme.color.accent,
                      transition: 'width 1.2s ease',
                    }} />
                  </div>
                  <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
                    {checking
                      ? 'Checking with DPD now...'
                      : elapsedMin < 1
                        ? 'Registering with DPD, usually takes a few minutes'
                        : elapsedMin < 30
                          ? `Registering with DPD · dispatched ${elapsedMin}m ago`
                          : `Dispatched ${elapsedMin}m ago · DPD registration taking longer than usual`}
                  </p>
                  <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkSubtle, opacity: 0.7 }}>
                    This page updates automatically when the link is ready.
                  </p>
                </div>
              </div>
            )
          ) : (
            <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              Tracking unavailable
            </p>
          )}
        </div>

        <hr style={{ margin: 0, border: 'none', borderTop: `1px solid ${theme.color.border}` }} />

        {/* Patient notification */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: theme.space[3] }}>
          <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium, color: theme.color.inkMuted }}>
            Patient notification
          </p>
          {emailSentAt ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1], fontSize: theme.type.size.xs, fontWeight: theme.type.weight.medium, color: theme.color.accent }}>
              <CheckCircle2 size={13} aria-hidden />
              Sent {emailSentAt}
            </span>
          ) : (
            <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
              {visit.parcel_code ? 'Notification pending' : 'Awaiting tracking confirmation'}
            </span>
          )}
        </div>

        <hr style={{ margin: 0, border: 'none', borderTop: `1px solid ${theme.color.border}` }} />

        {/* Delivery address */}
        {addrLines.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
            <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium, color: theme.color.inkMuted, display: 'flex', alignItems: 'center', gap: theme.space[1] }}>
              <MapPin size={12} aria-hidden /> Delivery address
            </p>
            {addrLines.map((line, i) => (
              <p key={i} style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.ink, fontWeight: i === 0 ? theme.type.weight.semibold : theme.type.weight.regular }}>
                {line}
              </p>
            ))}
          </div>
        ) : null}

        {/* Print label */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="secondary" size="sm" onClick={onPrintLabel} disabled={!visit.label_data}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <Printer size={14} aria-hidden />
              Print label
            </span>
          </Button>
        </div>
      </div>
    </CollapsibleCard>
  );
}

// VisitActionStack — quick-actions block surfaced beneath the
// reschedule-after-arrival note on every post-arrival visit page.
// Single Patient-profile row rendered with the same Card chrome
// SmilePhotosCard uses when collapsed (lg padding, 30px icon pill,
// h3 title, chevron trailing) so the post-arrival info column
// reads as one matched stack of cards instead of mixed surfaces.
// Reschedule is intentionally NOT here — see
// RescheduleAfterArrivalNote above.
function VisitActionStack({
  onPatientProfile,
}: {
  onPatientProfile: () => void;
}) {
  return (
    <Card padding="lg">
      <button
        type="button"
        onClick={onPatientProfile}
        aria-label="Open patient profile"
        style={{
          appearance: 'none',
          width: '100%',
          padding: 0,
          margin: 0,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'inherit',
          color: 'inherit',
          WebkitTapHighlightColor: 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[3],
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[3],
            minWidth: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 30,
              height: 30,
              borderRadius: theme.radius.pill,
              background: theme.color.accentBg,
              color: theme.color.accent,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <UserIcon size={15} aria-hidden />
          </span>
          <h2
            style={{
              margin: 0,
              // Matches the size every other section heading on this
              // page uses (CollapsibleCard's <h2> → theme.type.size.lg).
              // Patient profile was alone at .md, which made it read
              // as a sub-heading rather than a peer of the section
              // headers above and below it.
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
              lineHeight: 1.25,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            Patient profile
          </h2>
        </span>
        <ChevronRight size={18} color={theme.color.inkSubtle} aria-hidden />
      </button>
    </Card>
  );
}

// Operator-facing note shown above the actions block on every
// visit page (post-arrival). Replaces the Reschedule action that
// briefly lived on this page — once the patient is checked in,
// rescheduling would orphan the cart, the waiver signatures, the
// JB ref, and any payments already taken. The right flow is to
// End the visit and create a fresh booking.
function RescheduleAfterArrivalNote() {
  return (
    <div
      style={{
        display: 'flex',
        gap: theme.space[3],
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        borderRadius: theme.radius.input,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.bg,
      }}
    >
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
        <CalendarClock size={16} aria-hidden />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Need to move this appointment?
        </p>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          End this visit and create a new booking. This patient has already been
          booked in.
        </p>
      </div>
    </div>
  );
}

