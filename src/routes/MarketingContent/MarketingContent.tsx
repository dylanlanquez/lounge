import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarSearch, ChevronDown, ChevronLeft, ChevronRight, ImageOff, Megaphone } from 'lucide-react';
import { Button, Card, EmptyState, SegmentedControl, Skeleton, StatCard } from '../../components/index.ts';
import { PhotoLightbox, type LightboxPhoto } from '../../components/PhotoLightbox/PhotoLightbox.tsx';
import { BOTTOM_NAV_HEIGHT } from '../../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../../theme/index.ts';
import { useIsMobile } from '../../lib/useIsMobile.ts';
import { formatDateLongOrdinal } from '../../lib/dateFormat.ts';
import { signedUrlFor, useSignedPhotoUrl } from '../../lib/queries/patientFiles.ts';
import {
  type MarketingAppointment,
  type MarketingKind,
  type MarketingPhoto,
  KIND_LABEL,
  useMarketingContent,
} from '../../lib/queries/marketingContent.ts';

const CARD_W = 230;
const THUMB_H = 168;

// Every window option for the appointment list, always shown as
// segmented tabs rather than tucked behind a picker someone has to
// open first. Rolling windows (not calendar-boundary presets like
// "this month") so the count next to each tab means the same thing
// no matter what day of the month it is.
type RangeId = '7' | '30' | '90' | 'all';
const RANGE_OPTIONS: { value: RangeId; label: string }[] = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
];
const RANGE_LABEL: Record<RangeId, string> = Object.fromEntries(
  RANGE_OPTIONS.map((o) => [o.value, o.label]),
) as Record<RangeId, string>;
const DEFAULT_RANGE: RangeId = '30';

// The earliest instant an appointment's startAt must fall on or after
// to count as "within" this range. null means no lower bound (All time).
function rangeFloorMs(id: RangeId): number | null {
  if (id === 'all') return null;
  return Date.now() - Number(id) * 24 * 60 * 60 * 1000;
}

function kindChipStyle(kind: MarketingKind): CSSProperties {
  const base: CSSProperties = {
    fontSize: theme.type.size.xs,
    fontWeight: theme.type.weight.semibold,
    letterSpacing: theme.type.tracking.wide,
    textTransform: 'uppercase',
    padding: `2px ${theme.space[2]}px`,
    borderRadius: theme.radius.pill,
    lineHeight: 1.6,
  };
  if (kind === 'after') {
    return { ...base, background: theme.color.accentBg, color: theme.color.accent };
  }
  if (kind === 'marketing') {
    return { ...base, background: theme.color.accent, color: theme.color.surface };
  }
  return {
    ...base,
    background: theme.color.bg,
    color: theme.color.inkMuted,
    border: `1px solid ${theme.color.border}`,
  };
}

function KindChip({ kind }: { kind: MarketingKind }) {
  return <span style={kindChipStyle(kind)}>{KIND_LABEL[kind]}</span>;
}

// One photo in the carousel. Signs lazily; shows a quiet placeholder
// until the image lands so the row height never jumps.
function PhotoCard({
  photo,
  onOpen,
}: {
  photo: MarketingPhoto;
  onOpen: () => void;
}) {
  const { url, failed, onImgError } = useSignedPhotoUrl(photo.thumbnailPath ?? photo.filePath);
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        flex: `0 0 ${CARD_W}px`,
        width: CARD_W,
        scrollSnapAlign: 'start',
        padding: 0,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        background: theme.color.surface,
        boxShadow: theme.shadow.card,
        cursor: 'pointer',
        overflow: 'hidden',
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          height: THUMB_H,
          background: theme.color.bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {url ? (
          <img
            src={url}
            alt={photo.fileName}
            loading="lazy"
            onError={onImgError}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : failed ? (
          <ImageOff size={22} color={theme.color.inkSubtle} aria-hidden />
        ) : (
          <Skeleton height="100%" radius={0} />
        )}
        <span style={{ position: 'absolute', top: theme.space[2], left: theme.space[2] }}>
          <KindChip kind={photo.kind} />
        </span>
      </div>
    </button>
  );
}

// Horizontal, scroll-snapped strip with momentum on touch and chevron
// nudges on pointer devices. Chevrons fade out at each end.
function PhotoStrip({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      setCanPrev(el.scrollLeft > 4);
      setCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);

  const nudge = (dir: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * (CARD_W + 12) * 2, behavior: 'smooth' });
  };

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={ref}
        style={{
          display: 'flex',
          gap: theme.space[3],
          overflowX: 'auto',
          padding: `${theme.space[2]}px 2px ${theme.space[3]}px`,
          scrollSnapType: 'x mandatory',
          scrollBehavior: 'smooth',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
        }}
      >
        {children}
      </div>
      <StripButton side="left" show={canPrev} onClick={() => nudge(-1)} />
      <StripButton side="right" show={canNext} onClick={() => nudge(1)} />
    </div>
  );
}

function StripButton({
  side,
  show,
  onClick,
}: {
  side: 'left' | 'right';
  show: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={side === 'left' ? 'Scroll left' : 'Scroll right'}
      onClick={onClick}
      style={{
        position: 'absolute',
        top: '50%',
        [side]: -6,
        transform: 'translateY(-50%)',
        width: 36,
        height: 36,
        borderRadius: theme.radius.pill,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        boxShadow: theme.shadow.raised,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        opacity: show ? 1 : 0,
        pointerEvents: show ? 'auto' : 'none',
        transition: `opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        color: theme.color.ink,
      }}
    >
      {side === 'left' ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
    </button>
  );
}

function kindCounts(photos: MarketingPhoto[]): { kind: MarketingKind; count: number }[] {
  const order: MarketingKind[] = ['before', 'after', 'marketing'];
  return order
    .map((kind) => ({ kind, count: photos.filter((p) => p.kind === kind).length }))
    .filter((k) => k.count > 0);
}

function AppointmentRow({ appt }: { appt: MarketingAppointment }) {
  const [open, setOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [lightboxUrls, setLightboxUrls] = useState<(string | null)[]>([]);

  // Pre-sign full URLs for the lightbox only when a photo is opened, so
  // the gallery doesn't sign everything up front.
  const openLightbox = async (index: number) => {
    setLightboxIndex(index);
    const urls = await Promise.all(appt.photos.map((p) => signedUrlFor(p.filePath, 600)));
    setLightboxUrls(urls);
  };

  const lightboxPhotos: LightboxPhoto[] = appt.photos.map((p, i) => ({
    url: lightboxUrls[i] ?? '',
    label: KIND_LABEL[p.kind],
    caption: `${appt.patientName} · ${appt.ref}`,
  }));

  const meta = [
    appt.startAt ? formatDateLongOrdinal(appt.startAt) : null,
    appt.serviceLabel,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div style={{ borderTop: `1px solid ${theme.color.border}` }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[2],
          padding: `${theme.space[3]}px 0`,
          width: '100%',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          color: 'inherit',
          fontFamily: 'inherit',
        }}
      >
        {/* Name + chevron share a row, chips get their own row below.
            An appointment with three chips (before/after/marketing) on
            a phone-width screen used to share the name's row, and the
            name column would collapse to nothing rather than truncate.
            Splitting the rows means the chip count can never push the
            patient's name off the card. */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: theme.space[3] }}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.base,
                fontWeight: theme.type.weight.medium,
                color: theme.color.ink,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {appt.patientName}
            </p>
            {meta && (
              <p
                style={{
                  margin: '2px 0 0',
                  fontSize: theme.type.size.sm,
                  color: theme.color.inkMuted,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {meta}
              </p>
            )}
          </div>
          <ChevronDown
            size={18}
            aria-hidden
            style={{
              flexShrink: 0,
              marginTop: 2,
              color: theme.color.inkSubtle,
              transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
              transform: open ? 'rotate(180deg)' : 'none',
            }}
          />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: theme.space[2] }}>
          {kindCounts(appt.photos).map(({ kind, count }) => (
            <span key={kind} style={kindChipStyle(kind)}>
              {count} {KIND_LABEL[kind]}
            </span>
          ))}
        </div>
      </button>

      {open && (
        <div style={{ paddingBottom: theme.space[2] }}>
          <PhotoStrip>
            {appt.photos.map((photo, i) => (
              <PhotoCard key={photo.id} photo={photo} onOpen={() => void openLightbox(i)} />
            ))}
          </PhotoStrip>
        </div>
      )}

      <PhotoLightbox photos={lightboxPhotos} index={lightboxIndex} onChange={setLightboxIndex} />
    </div>
  );
}

function HeroFeatured({
  featured,
  totalPhotos,
  totalAppointments,
  isMobile,
}: {
  featured: NonNullable<ReturnType<typeof useMarketingContent>['data']>['featured'];
  totalPhotos: number;
  totalAppointments: number;
  isMobile: boolean;
}) {
  const { url, failed, onImgError } = useSignedPhotoUrl(
    featured ? (featured.photo.thumbnailPath ?? featured.photo.filePath) : null,
  );
  if (!featured) return null;
  return (
    <Card padding="none" elevation="raised">
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row' }}>
        <div
          style={{
            flex: isMobile ? '0 0 auto' : '0 0 44%',
            height: isMobile ? 220 : 260,
            background: theme.color.bg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {url ? (
            <img
              src={url}
              alt={featured.photo.fileName}
              onError={onImgError}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : failed ? (
            <ImageOff size={26} color={theme.color.inkSubtle} aria-hidden />
          ) : (
            <Skeleton height="100%" radius={0} />
          )}
          <span style={{ position: 'absolute', top: theme.space[3], left: theme.space[3] }}>
            <KindChip kind={featured.photo.kind} />
          </span>
        </div>
        <div
          style={{
            flex: 1,
            padding: theme.space[6],
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: theme.space[2],
          }}
        >
          <span
            style={{
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.wide,
              textTransform: 'uppercase',
              color: theme.color.inkSubtle,
            }}
          >
            Latest content
          </span>
          <p
            style={{
              margin: 0,
              fontSize: isMobile ? theme.type.size.lg : theme.type.size.xl,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
              lineHeight: theme.type.leading.snug,
              color: theme.color.ink,
            }}
          >
            {featured.appointment.patientName}
          </p>
          <p style={{ margin: 0, fontSize: theme.type.size.md, color: theme.color.inkMuted }}>
            {totalPhotos} {totalPhotos === 1 ? 'photo' : 'photos'} across{' '}
            {totalAppointments} {totalAppointments === 1 ? 'appointment' : 'appointments'}, ready
            for the marketing team.
          </p>
        </div>
      </div>
    </Card>
  );
}

export function MarketingContent() {
  const isMobile = useIsMobile(640);
  const { data, loading, error } = useMarketingContent();
  const [rangeId, setRangeId] = useState<RangeId>(DEFAULT_RANGE);

  // The gallery keeps every photo ever captured, so the list of
  // appointments only grows. Scope the browsable list to the selected
  // window (by appointment date, not upload date) so a clinic running
  // for years doesn't turn this into an endless scroll. Defaults to
  // the last 30 days; "All time" removes the filter.
  const filteredAppointments = useMemo(() => {
    if (!data) return [];
    const floor = rangeFloorMs(rangeId);
    if (floor === null) return data.appointments;
    return data.appointments.filter((a) => a.startAt !== null && new Date(a.startAt).getTime() >= floor);
  }, [data, rangeId]);

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: isMobile ? theme.space[4] : theme.space[6],
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + ${
          isMobile ? theme.space[4] : theme.space[6]
        }px + env(safe-area-inset-top, 0px))`,
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${
          isMobile ? theme.space[6] : theme.space[8]
        }px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div style={{ maxWidth: theme.layout.pageMaxWidth, margin: '0 auto' }}>
        <div style={{ marginBottom: theme.space[5] }}>
          <h1
            style={{
              margin: 0,
              fontSize: isMobile ? theme.type.size.xl : theme.type.size.xxl,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            Marketing content
          </h1>
          <p
            style={{
              margin: `${theme.space[2]}px 0 0`,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
              maxWidth: 640,
            }}
          >
            Before and after shots and finished-result photos captured at appointments, ready for
            the marketing team. Tap an appointment to flick through its photos.
          </p>
        </div>

        {error ? (
          <Card padding="lg">
            <p style={{ margin: 0, color: theme.color.alert }}>
              Could not load marketing content: {error}
            </p>
          </Card>
        ) : loading || !data ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
            <Skeleton height={260} />
            <Skeleton height={120} />
            <Skeleton height={280} />
          </div>
        ) : data.totalPhotos === 0 ? (
          <Card padding="lg">
            <EmptyState
              icon={<Megaphone size={20} />}
              title="No marketing content yet"
              description="Add photos from the Before & after or Marketing content sections on a visit. They gather here, grouped by appointment, ready for the marketing team."
            />
          </Card>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
            <HeroFeatured
              featured={data.featured}
              totalPhotos={data.totalPhotos}
              totalAppointments={data.totalAppointments}
              isMobile={isMobile}
            />

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                gap: theme.space[3],
              }}
            >
              <StatCard label="Appointments" value={String(data.totalAppointments)} />
              <StatCard label="Photos" value={String(data.totalPhotos)} tone="accent" />
              <StatCard label="Before & after" value={String(data.beforeAfterPhotos)} />
              <StatCard label="Marketing" value={String(data.marketingPhotos)} />
            </div>

            <Card padding="lg">
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  alignItems: isMobile ? 'stretch' : 'center',
                  gap: theme.space[3],
                  marginBottom: theme.space[4],
                }}
              >
                <div>
                  <h2
                    style={{
                      margin: 0,
                      fontSize: theme.type.size.lg,
                      fontWeight: theme.type.weight.semibold,
                      letterSpacing: theme.type.tracking.tight,
                      color: theme.color.ink,
                    }}
                  >
                    Every appointment
                  </h2>
                  <p
                    style={{
                      margin: `${theme.space[1]}px 0 0`,
                      fontSize: theme.type.size.sm,
                      color: theme.color.inkMuted,
                    }}
                  >
                    {filteredAppointments.length}{' '}
                    {filteredAppointments.length === 1 ? 'appointment' : 'appointments'} ·{' '}
                    {RANGE_LABEL[rangeId]}
                  </p>
                </div>
                {/* Every option sits on the page already, tap to switch.
                    Nothing to open, nothing hidden behind a trigger. */}
                <SegmentedControl
                  ariaLabel="Filter appointments by date"
                  options={RANGE_OPTIONS}
                  value={rangeId}
                  onChange={setRangeId}
                  size={isMobile ? 'sm' : 'md'}
                  scrollable={isMobile}
                />
              </div>
              {filteredAppointments.length === 0 ? (
                <EmptyState
                  icon={<CalendarSearch size={20} />}
                  title="No appointments in this range"
                  description={`No before and after or marketing photos were captured in ${RANGE_LABEL[
                    rangeId
                  ].toLowerCase()}. Widen the range to see older appointments.`}
                  action={
                    rangeId !== 'all' ? (
                      <Button variant="secondary" size="sm" onClick={() => setRangeId('all')}>
                        Show all time
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div>
                  {filteredAppointments.map((appt) => (
                    <AppointmentRow key={appt.appointmentId} appt={appt} />
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </main>
  );
}
