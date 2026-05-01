import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { type GMap, type GMarker, loadMapsLib } from '../../lib/googleMaps.ts';
import {
  type VisitorAddressMapData,
  type VisitorAddressPoint,
  type VisitorMapService,
  VISITOR_MAP_SERVICES,
} from '../../lib/queries/reports.ts';
import type { AddressGeocode } from '../../lib/queries/addressGeocodes.ts';
import { formatPence } from '../../lib/queries/carts.ts';
import { logFailure } from '../../lib/failureLog.ts';
import {
  MAP_STYLE,
  MAP_BACKGROUND,
  MARKER_COLOUR,
  haloMarkerIcon,
} from '../../lib/visitorMapStyling.ts';

// VisitorAddressMap — admin-only address-resolution heatmap.
//
// One marker per unique patient address (line1 + postcode). Hovering
// a marker surfaces a styled card with the address, the visit count,
// the distinct patient count, and a list of every visit at that
// address with date, LAP appointment ref, and cart items.
//
// Visual approach mirrors VisitorHeatmap (light cream basemap,
// halo-icon markers, theme tokens throughout) so the two components
// feel like the same surface even though their data shapes differ.
//
// The component does NOT enforce the admin gate itself — the parent
// (DemographicsTab) gates instantiation on account flags. This file
// stays presentational so it can be re-used in any future surface
// that already established admin-level access.

export interface VisitorAddressMapProps {
  data: VisitorAddressMapData;
  geocodes: AddressGeocode[];
}

interface HoverState {
  point: VisitorAddressPoint;
  x: number;
  y: number;
}

export function VisitorAddressMap({ data, geocodes }: VisitorAddressMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<GMarker[]>([]);
  const [map, setMap] = useState<GMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [hover, setHover] = useState<HoverState | null>(null);
  // Service filter — top-level only. Address-level subs are already
  // visible in the hover card, so a sub-drilldown legend would be
  // redundant.
  const [serviceFilter, setServiceFilter] = useState<VisitorMapService | 'all'>('all');

  const geoIndex = useMemo(() => {
    const m = new Map<string, { lat: number; lng: number }>();
    for (const g of geocodes) {
      m.set(`${g.line1_norm}|${g.postcode_norm}`, { lat: g.lat, lng: g.lng });
    }
    return m;
  }, [geocodes]);

  const visiblePoints = useMemo(() => {
    if (serviceFilter === 'all') return data.points;
    return data.points.filter((p) =>
      p.visits.some((v) => v.dominant_service === serviceFilter),
    );
  }, [data.points, serviceFilter]);

  const totals = useMemo(() => {
    let visits = 0;
    let placed = 0;
    for (const p of visiblePoints) {
      visits += p.total_visits;
      if (geoIndex.has(`${p.line1_norm}|${p.postcode_norm}`)) placed += 1;
    }
    return { visits, placed, total: visiblePoints.length };
  }, [visiblePoints, geoIndex]);

  // Map creation runs once on mount — same pattern as VisitorHeatmap.
  // setMap is the trigger that lets the marker effect downstream run
  // with a real map.
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const lib = await loadMapsLib();
        if (cancelled) return;
        if (!lib) {
          setUnavailable(true);
          return;
        }
        if (!containerRef.current) return;
        const instance = new lib.Map(containerRef.current, {
          center: { lat: 54.0, lng: -2.5 },
          zoom: 6,
          disableDefaultUI: false,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          zoomControl: true,
          clickableIcons: false,
          styles: MAP_STYLE,
          backgroundColor: MAP_BACKGROUND,
          gestureHandling: 'greedy',
        });
        setMap(instance);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Map failed to load';
        setError(message);
        await logFailure({
          source: 'reports.visitor_address_map',
          severity: 'error',
          message,
          context: {},
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    void (async () => {
      try {
        const lib = await loadMapsLib();
        if (cancelled || !lib) return;
        for (const m of markersRef.current) m.setMap(null);
        markersRef.current = [];
        if (visiblePoints.length === 0) return;

        const max = Math.max(...visiblePoints.map((p) => p.total_visits));
        let north = -Infinity;
        let south = Infinity;
        let east = -Infinity;
        let west = Infinity;
        let drew = 0;
        for (const point of visiblePoints) {
          const geo = geoIndex.get(`${point.line1_norm}|${point.postcode_norm}`);
          if (!geo) continue;
          const coreRadius = max > 0 ? 6 + (point.total_visits / max) * 8 : 6;
          const colour = MARKER_COLOUR[point.dominant_service];
          const marker = new lib.Marker({
            map,
            position: { lat: geo.lat, lng: geo.lng },
            icon: haloMarkerIcon(colour, coreRadius),
            zIndex: Math.round(point.total_visits * 100),
          });
          marker.addListener('mouseover', (event: { domEvent?: MouseEvent }) => {
            const rect = containerRef.current?.getBoundingClientRect();
            const dom = event.domEvent;
            if (!rect || !dom) return;
            setHover({
              point,
              x: dom.clientX - rect.left,
              y: dom.clientY - rect.top,
            });
          });
          marker.addListener('mouseout', () => setHover(null));
          markersRef.current.push(marker);

          if (geo.lat > north) north = geo.lat;
          if (geo.lat < south) south = geo.lat;
          if (geo.lng > east) east = geo.lng;
          if (geo.lng < west) west = geo.lng;
          drew += 1;
        }
        if (drew > 0) {
          map.fitBounds({ north, south, east, west }, 64);
        }
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Address heatmap render failed';
        setError(message);
        await logFailure({
          source: 'reports.visitor_address_map',
          severity: 'error',
          message,
          context: { stage: 'marker_render', point_count: visiblePoints.length },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [map, visiblePoints, geoIndex]);

  if (unavailable) {
    return (
      <div
        style={{
          padding: theme.space[4],
          borderRadius: theme.radius.input,
          background: theme.color.bg,
          border: `1px dashed ${theme.color.border}`,
          color: theme.color.inkMuted,
          fontSize: theme.type.size.sm,
        }}
      >
        The visitor map needs a Google Maps API key. Configure VITE_GOOGLE_MAPS_API_KEY and reload.
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      {error ? (
        <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>{error}</p>
      ) : null}
      <div
        ref={containerRef}
        role="img"
        aria-label={`Address heatmap. ${totals.placed} address${totals.placed === 1 ? '' : 'es'} plotted, ${totals.visits} visit${totals.visits === 1 ? '' : 's'}.`}
        style={{
          width: '100%',
          minHeight: 480,
          borderRadius: theme.radius.input,
          background: MAP_BACKGROUND,
          border: `1px solid ${theme.color.border}`,
          overflow: 'hidden',
        }}
      />
      <KpiBadges placed={totals.placed} total={totals.total} visits={totals.visits} />
      <ServiceFilter value={serviceFilter} onChange={setServiceFilter} />
      {hover ? <HoverCard hover={hover} /> : null}
    </div>
  );
}

function KpiBadges({ placed, total, visits }: { placed: number; total: number; visits: number }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        top: theme.space[3],
        left: theme.space[3],
        display: 'flex',
        gap: theme.space[2],
        background: theme.color.surface,
        boxShadow: theme.shadow.card,
        borderRadius: theme.radius.input,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <Badge label="Visits" value={visits} />
      <span aria-hidden style={{ width: 1, background: theme.color.border, alignSelf: 'stretch' }} />
      <Badge
        label="Addresses"
        value={placed}
        suffix={placed === total ? null : `/ ${total}`}
      />
    </div>
  );
}

function Badge({ label, value, suffix }: { label: string; value: number; suffix?: string | null }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
      <span
        style={{
          fontSize: theme.type.size.xs,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
          color: theme.color.inkMuted,
          fontWeight: theme.type.weight.medium,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: theme.type.size.lg,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value.toLocaleString('en-GB')}
        {suffix ? (
          <span
            style={{
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.medium,
              color: theme.color.inkMuted,
              marginLeft: theme.space[1],
            }}
          >
            {suffix}
          </span>
        ) : null}
      </span>
    </div>
  );
}

// Service filter — collapsed by default to a compact chip in the
// bottom-left corner of the map. Click expands into the full panel
// of service rows; the panel's header carries a retract chevron
// that brings it back to the chip.
//
// The expand/collapse animation morphs the chip *into* the panel
// rather than fading them as separate elements: the same wrapper
// transitions its width and height, anchored to bottom-left so the
// growth feels like it unfolds from the chip's corner. Both
// content layers are rendered at all times and cross-faded by
// opacity so the dimensions transition has something coherent
// behind the curtain — no content jump, no layout flash.
//
// Sizing: a fixed open height is needed for a CSS dimension
// transition to work (auto-height can't be transitioned). Open
// dimensions are sized for the six legend rows + header padding;
// closed dimensions are tuned for the longest active label
// ("Same-day appliance") with safe overflow margin.
const FILTER_OPEN_HEIGHT = 308;
const FILTER_OPEN_WIDTH = 224;
const FILTER_CLOSED_HEIGHT = 38;
const FILTER_CLOSED_WIDTH = 188;

function ServiceFilter({
  value,
  onChange,
}: {
  value: VisitorMapService | 'all';
  onChange: (next: VisitorMapService | 'all') => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const activeLabel =
    value === 'all'
      ? 'All visits'
      : VISITOR_MAP_SERVICES.find((s) => s.id === value)?.label ?? 'Service';
  const activeColour = value === 'all' ? theme.color.inkSubtle : MARKER_COLOUR[value];

  return (
    <div
      style={{
        position: 'absolute',
        bottom: theme.space[3],
        left: theme.space[3],
        background: theme.color.surface,
        borderRadius: theme.radius.input,
        boxShadow: theme.shadow.card,
        border: `1px solid ${theme.color.border}`,
        overflow: 'hidden',
        // Bottom-left transform origin so the morph reads as
        // "growing out of the chip's corner".
        transformOrigin: 'bottom left',
        width: expanded ? FILTER_OPEN_WIDTH : FILTER_CLOSED_WIDTH,
        height: expanded ? FILTER_OPEN_HEIGHT : FILTER_CLOSED_HEIGHT,
        transition: `width ${theme.motion.duration.base}ms ${theme.motion.easing.spring}, height ${theme.motion.duration.base}ms ${theme.motion.easing.spring}, box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      {/* Compact chip — rendered always, faded out when expanded.
          pointer-events disabled when invisible so its click target
          doesn't shadow the panel underneath. */}
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-expanded={expanded}
        aria-label="Open service filter"
        style={{
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          width: '100%',
          height: FILTER_CLOSED_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[2],
          padding: `0 ${theme.space[3]}px`,
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.medium,
          color: theme.color.ink,
          textAlign: 'left',
          opacity: expanded ? 0 : 1,
          pointerEvents: expanded ? 'none' : 'auto',
          transition: `opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: activeColour,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {activeLabel}
        </span>
        <ChevronUp size={14} aria-hidden style={{ color: theme.color.inkMuted, flexShrink: 0 }} />
      </button>

      {/* Full panel — rendered always, faded in when expanded.
          Pointer events disabled in the closed state so the chip's
          click target wins. */}
      <div
        aria-hidden={!expanded}
        style={{
          position: 'absolute',
          inset: 0,
          padding: `${theme.space[3]}px ${theme.space[3]}px`,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[1],
          opacity: expanded ? 1 : 0,
          pointerEvents: expanded ? 'auto' : 'none',
          // Slight delay on the panel fade-in so the morph reads as
          // "size first, content second". On collapse the chip
          // fades in last for the same reason.
          transition: `opacity ${theme.motion.duration.base}ms ${theme.motion.easing.standard}`,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingBottom: theme.space[1],
          }}
        >
          <span
            style={{
              fontSize: theme.type.size.xs,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
              color: theme.color.inkMuted,
              fontWeight: theme.type.weight.medium,
            }}
          >
            Service
          </span>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Close service filter"
            style={{
              appearance: 'none',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: theme.space[1],
              margin: -theme.space[1],
              borderRadius: theme.radius.input,
              color: theme.color.inkMuted,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <ChevronDown size={14} aria-hidden />
          </button>
        </div>
        <FilterRow
          active={value === 'all'}
          colour={theme.color.inkSubtle}
          label="All visits"
          onClick={() => onChange('all')}
        />
        {VISITOR_MAP_SERVICES.map((s) => (
          <FilterRow
            key={s.id}
            active={value === s.id}
            colour={MARKER_COLOUR[s.id]}
            label={s.label}
            onClick={() => onChange(s.id)}
          />
        ))}
      </div>
    </div>
  );
}

function FilterRow({
  active,
  colour,
  label,
  onClick,
}: {
  active: boolean;
  colour: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        border: active ? `1px solid ${theme.color.ink}` : '1px solid transparent',
        background: active ? theme.color.bg : 'transparent',
        color: active ? theme.color.ink : theme.color.inkMuted,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[2],
        padding: `${theme.space[2]}px ${theme.space[3]}px`,
        borderRadius: theme.radius.input,
        fontFamily: 'inherit',
        fontSize: theme.type.size.sm,
        fontWeight: active ? theme.type.weight.semibold : theme.type.weight.medium,
        textAlign: 'left',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: colour,
          flexShrink: 0,
        }}
      />
      <span>{label}</span>
    </button>
  );
}

// HoverCard — full-address detail with five clearly-divided sections,
// joined by hairline rules:
//
//   1. Address line + postcode (with the dominant-service colour dot
//      so it's visually keyed to the marker).
//   2. Patient name(s) at the address. One name → that name; two →
//      both, comma-separated; three or more → first two + "+N more".
//   3. Aggregate metrics: total orders + total spent, side by side.
//   4. The three most recent orders. Date · LAP-xxxxx on top line,
//      items underneath. Tabular-nums on the figures keeps columns
//      aligned vertically across rows.
//   5. "+N earlier orders" footer when the list is truncated.
//
// Tighter vertical rhythm than the previous design — ~space[2]
// between sections, line-height 1.3 on the body. Hairline separators
// (1px borderTop on each section) carry the structure rather than
// padding.
const RECENT_LIMIT = 3;

function HoverCard({ hover }: { hover: HoverState }) {
  const point = hover.point;
  const recent = point.visits.slice(0, RECENT_LIMIT);
  const overflow = point.visits.length - recent.length;
  const displayPostcode = formatPostcodeForDisplay(point.postcode);
  const namesLabel = composeNames(point.patient_names);
  return (
    <div
      role="tooltip"
      style={{
        position: 'absolute',
        left: hover.x,
        top: hover.y - 14,
        transform: 'translate(-50%, -100%)',
        background: theme.color.surface,
        color: theme.color.ink,
        borderRadius: theme.radius.input,
        boxShadow: theme.shadow.raised,
        border: `1px solid ${theme.color.border}`,
        minWidth: 260,
        maxWidth: 320,
        pointerEvents: 'none',
        zIndex: 10,
        fontFamily: 'inherit',
        // Sections handle their own padding via the row component
        // below, so the outer card has none — keeps separators flush.
        padding: 0,
        overflow: 'hidden',
      }}
    >
      {/* 1. Address */}
      <Section first>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: MARKER_COLOUR[point.dominant_service],
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              lineHeight: 1.25,
            }}
          >
            {point.line1}
          </span>
        </div>
        <div
          style={{
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: theme.type.tracking.wide,
            // Sit just under the address with no extra section padding.
            marginTop: 2,
            paddingLeft: theme.space[2] + 8 /* match dot + gap inset */,
          }}
        >
          {displayPostcode}
        </div>
      </Section>

      {/* 2. Patient name(s) */}
      {namesLabel ? (
        <Section>
          <div
            style={{
              fontSize: theme.type.size.sm,
              color: theme.color.ink,
              lineHeight: 1.3,
            }}
          >
            {namesLabel}
          </div>
        </Section>
      ) : null}

      {/* 3. Metrics row */}
      <Section>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: theme.space[3],
          }}
        >
          <Metric value={point.total_visits} label={point.total_visits === 1 ? 'order' : 'orders'} />
          <Metric value={formatPence(point.total_spent_pence)} label="spent" align="right" />
        </div>
      </Section>

      {/* 4. Recent orders. Each row after the first has a subtle
            hairline above it — softer than the full-strength section
            dividers (0.05 vs 0.08 opacity) so the eye reads the row
            split as "within the section" rather than "between
            sections". The line sits within the section's horizontal
            padding so it's already inset from the card edges. */}
      <Section>
        <SectionLabel>Recent orders</SectionLabel>
        <ul
          style={{
            listStyle: 'none',
            margin: `${theme.space[2]}px 0 0`,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {recent.map((v, i) => (
            <li
              key={v.visit_id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                paddingTop: i === 0 ? 0 : theme.space[2],
                marginTop: i === 0 ? 0 : theme.space[2],
                borderTop: i === 0 ? 'none' : '1px solid rgba(14, 20, 20, 0.05)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: theme.space[2],
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                <span>{formatVisitDate(v.visit_date)}</span>
                {v.appointment_ref ? (
                  <span style={{ fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
                    {v.appointment_ref}
                  </span>
                ) : null}
              </div>
              <div style={{ fontSize: theme.type.size.sm, color: theme.color.ink, lineHeight: 1.3 }}>
                {v.items.map((it) => it.label).join(', ')}
              </div>
            </li>
          ))}
        </ul>
      </Section>

      {/* 5. Overflow footer */}
      {overflow > 0 ? (
        <Section>
          <div
            style={{
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
            }}
          >
            +{overflow} earlier order{overflow === 1 ? '' : 's'}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

// Section — one band of the hover card, separated from the band
// above by a hairline rule. `first` skips the rule so the card's
// outer border carries the top edge.
function Section({ first, children }: { first?: boolean; children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: `${theme.space[2]}px ${theme.space[3]}px`,
        borderTop: first ? undefined : `1px solid ${theme.color.border}`,
      }}
    >
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: theme.type.tracking.wide,
        color: theme.color.inkMuted,
        fontWeight: theme.type.weight.medium,
      }}
    >
      {children}
    </span>
  );
}

function Metric({
  value,
  label,
  align = 'left',
}: {
  value: number | string;
  label: string;
  align?: 'left' | 'right';
}) {
  const display = typeof value === 'number' ? value.toLocaleString('en-GB') : value;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: theme.space[1],
        textAlign: align,
      }}
    >
      <span
        style={{
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.1,
        }}
      >
        {display}
      </span>
      <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>{label}</span>
    </div>
  );
}

// Compose a friendly name string from a small list:
//   []           → null   (nothing to show)
//   ['A']        → "A"
//   ['A','B']    → "A, B"
//   ['A','B','C','D'] → "A, B + 2 more"
function composeNames(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]}, ${names[1]}`;
  const head = `${names[0]}, ${names[1]}`;
  const remaining = names.length - 2;
  return `${head} + ${remaining} more`;
}

// "G718PH" → "G71 8PH". Postcodes are stored normalised in the
// data point, but we want to show them human-friendly in the
// hover. The split is at length-3-from-the-end (UK inward is
// always 3 chars).
function formatPostcodeForDisplay(stored: string): string {
  const compact = stored.replace(/\s+/g, '').toUpperCase();
  if (compact.length <= 3) return compact;
  return `${compact.slice(0, compact.length - 3)} ${compact.slice(-3)}`;
}

function formatVisitDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
