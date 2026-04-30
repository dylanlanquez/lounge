import { type ReactNode, useMemo, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  Box,
  CalendarCheck,
  CheckCircle2,
  CheckCircle,
  ChevronRight,
  Circle,
  CircleSlash,
  CreditCard,
  Hash,
  Loader2,
  Plus,
  ShoppingCart,
  UserPlus,
} from 'lucide-react';
import {
  BeforeAfterGallery,
  Breadcrumb,
  Button,
  Card,
  EmptyState,
  MarketingGallery,
  Skeleton,
  StatusPill,
  Toast,
  VisitTimeline,
  WaiverSheet,
} from '../components/index.ts';
import { usePatientProfileFiles } from '../lib/queries/patientProfile.ts';
import { CartLineItem } from '../components/CartLineItem/CartLineItem.tsx';
import { CataloguePicker } from '../components/CataloguePicker/CataloguePicker.tsx';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { formatVisitCrumb, useVisitDetail } from '../lib/queries/visits.ts';
import { patientFullName } from '../lib/queries/patients.ts';
import {
  formatPence,
  removeCartItem,
  updateCartItemQuantity,
  useCart,
} from '../lib/queries/carts.ts';
import {
  inferServiceTypeFromEventLabel,
  requiredSectionsForServiceTypes,
  sectionSignatureState,
  summariseWaiverFlag,
  useWaiverSections,
  usePatientWaiverState,
  type WaiverSection,
} from '../lib/queries/waiver.ts';

export function VisitDetail() {
  const { id } = useParams<{ id: string }>();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { visit, patient, deposit, appointment, loading } = useVisitDetail(id);
  const { data: galleryFiles, loading: galleryFilesLoading, refresh: refreshGalleryFiles } =
    usePatientProfileFiles(patient?.id ?? null);
  const { cart, items, loading: cartLoading, refresh, ensureOpen } = useCart(id);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiverOpen, setWaiverOpen] = useState(false);
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
  const requiredSections = useMemo<WaiverSection[]>(() => {
    if (waiverSections.length === 0) return [];
    if (items.length > 0) {
      return requiredSectionsForServiceTypes(
        items.map((it) => it.service_type),
        waiverSections
      );
    }
    const inferred = inferServiceTypeFromEventLabel(appointment?.event_type_label ?? null);
    return requiredSectionsForServiceTypes(inferred ? [inferred] : [], waiverSections);
  }, [appointment?.event_type_label, items, waiverSections]);
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
                  {items.map((it) => (
                    <CartLineItem
                      key={it.id}
                      name={it.name}
                      description={cartItemSubtitle(it)}
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
                  ))}
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
              <div style={{ marginTop: theme.space[6], display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
                <Button
                  variant="primary"
                  size="lg"
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
        onAllSigned={refreshSignatures}
      />
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

function visitStatusIcon(s: 'opened' | 'in_progress' | 'complete' | 'cancelled') {
  switch (s) {
    case 'opened':
      return <Circle size={12} />;
    case 'in_progress':
      return <Loader2 size={12} />;
    case 'complete':
      return <CheckCircle size={12} />;
    case 'cancelled':
      return <CircleSlash size={12} />;
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
function visitStatusLabel(s: 'opened' | 'in_progress' | 'complete' | 'cancelled'): string {
  switch (s) {
    case 'opened':
      return 'Opened';
    case 'in_progress':
      return 'In progress';
    case 'complete':
      return 'Complete';
    case 'cancelled':
      return 'Cancelled';
  }
}
function visitStatusTone(s: 'opened' | 'in_progress' | 'complete' | 'cancelled') {
  switch (s) {
    case 'opened':
      return 'in_progress' as const;
    case 'in_progress':
      return 'in_progress' as const;
    case 'complete':
      return 'complete' as const;
    case 'cancelled':
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
// snapshot — arch / shade / notes — so the receptionist sees what was
// configured without opening the row.
function cartItemSubtitle(item: {
  description: string | null;
  arch: 'upper' | 'lower' | 'both' | null;
  shade: string | null;
  notes: string | null;
}): string | null {
  const parts: string[] = [];
  if (item.arch === 'upper') parts.push('Upper');
  else if (item.arch === 'lower') parts.push('Lower');
  else if (item.arch === 'both') parts.push('Upper and lower');
  if (item.shade) parts.push(`shade ${item.shade}`);
  if (item.notes) parts.push(item.notes);
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
