import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { type GMap, type GMarker, loadMapsLib } from '../../lib/googleMaps.ts';
import { computeHoverCardPosition, type HoverPosition } from '../../lib/hoverCardPosition.ts';
import {
  type VisitorAddressMapData,
  type VisitorAddressPoint,
  type VisitorMapService,
  type VisitorMapServiceDef,
  useVisitorMapServices,
} from '../../lib/queries/reports.ts';
import type { AddressGeocode } from '../../lib/queries/addressGeocodes.ts';
import { formatPence } from '../../lib/queries/carts.ts';
import { logFailure } from '../../lib/failureLog.ts';
import {
  MAP_STYLE,
  MAP_BACKGROUND,
  colourForService,
  haloMarkerIcon,
} from '../../lib/visitorMapStyling.ts';

// Hierarchical filter — same shape as VisitorHeatmap. Three levels:
//   • 'all'     → every visit regardless of service
//   • 'service' → only points booking that service
//   • 'sub'     → only points booking that service's specific sub
//                 (e.g. a denture_repair point with a "Cracked
//                 denture" item, or a click_in_veneers point with
//                 'lower' arch).
type AddressMapFilter =
  | { level: 'all' }
  | { level: 'service'; service: VisitorMapService }
  | { level: 'sub'; service: VisitorMapService; subKey: string };

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
  const { data: services } = useVisitorMapServices();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<GMarker[]>([]);
  // Tracks the geocode set we last auto-fit the camera to. Filter
  // changes don't refit — only a new dataset (different geocodes)
  // does. Stops the camera jerking around when the user is just
  // narrowing within the same data, and avoids the tile-interpolation
  // flash that comes with rapid zoom changes.
  const lastFitGeoKeyRef = useRef<string>('');
  const [map, setMap] = useState<GMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [hover, setHover] = useState<HoverState | null>(null);
  // Hierarchical filter (all / service / sub) — same vocabulary as
  // VisitorHeatmap so admins moving between the two views aren't
  // re-learning controls.
  const [filter, setFilter] = useState<AddressMapFilter>({ level: 'all' });

  const geoIndex = useMemo(() => {
    const m = new Map<string, { lat: number; lng: number }>();
    for (const g of geocodes) {
      m.set(`${g.line1_norm}|${g.postcode_norm}`, { lat: g.lat, lng: g.lng });
    }
    return m;
  }, [geocodes]);

  // Visible points for the current filter level. The 'service' and
  // 'sub' levels narrow the set; 'all' returns the full set
  // unchanged. Marker colour later in the marker effect adapts to
  // the filter so a service drill-down repaints every dot in that
  // service's brand colour.
  const visiblePoints = useMemo(() => {
    if (filter.level === 'all') return data.points;
    if (filter.level === 'service') {
      return data.points.filter((p) =>
        p.services.some((s) => s.service === filter.service && s.count > 0),
      );
    }
    // 'sub'
    return data.points.filter((p) =>
      p.services.some(
        (s) =>
          s.service === filter.service &&
          s.subs.some((k) => k.key === filter.subKey && k.count > 0),
      ),
    );
  }, [data.points, filter]);

  // Marker colour adapts to the filter so a service drill-down
  // recolours every dot to that service. At the 'all' level we keep
  // each point's own dominant-service colour.
  const colourFor = (point: VisitorAddressPoint): string => {
    if (filter.level === 'all') return colourForService(point.dominant_service, services);
    return colourForService(filter.service, services);
  };

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
        for (const point of visiblePoints) {
          const geo = geoIndex.get(`${point.line1_norm}|${point.postcode_norm}`);
          if (!geo) continue;
          const coreRadius = max > 0 ? 6 + (point.total_visits / max) * 8 : 6;
          const colour = colourFor(point);
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
        }

        // Fit bounds only when the *dataset* changes, not on every
        // filter tweak. The bounds we fit to come from ALL geocoded
        // points (not the current filter) so the initial framing
        // shows the whole catchment regardless of which sub the
        // user has selected.
        const geoKey = Array.from(geoIndex.keys()).sort().join(',');
        if (geoKey && geoKey !== lastFitGeoKeyRef.current) {
          let north = -Infinity;
          let south = Infinity;
          let east = -Infinity;
          let west = Infinity;
          let any = false;
          for (const point of data.points) {
            const g = geoIndex.get(`${point.line1_norm}|${point.postcode_norm}`);
            if (!g) continue;
            if (g.lat > north) north = g.lat;
            if (g.lat < south) south = g.lat;
            if (g.lng > east) east = g.lng;
            if (g.lng < west) west = g.lng;
            any = true;
          }
          if (any) {
            map.fitBounds({ north, south, east, west }, 64);
            lastFitGeoKeyRef.current = geoKey;
          }
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
  }, [map, visiblePoints, geoIndex, data.points]);

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
      <ServiceFilter data={data} filter={filter} services={services} onChange={setFilter} />
      {hover ? <HoverCard hover={hover} services={services} containerRef={containerRef} /> : null}
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
// bottom-left corner of the map. Click expands into a hierarchical
// panel: top-level services drill into sub-categories (repair
// variants, appliance product keys, arches). The same wrapper
// element morphs between chip and panel — width and height
// transition with `transformOrigin: bottom left` so the growth
// reads as "unfolding from the chip's corner".
//
// Why dynamic open height:
//
//   The panel content varies — top level shows All + 5 services,
//   service level shows back + N sub-rows (3-6 typical), sub level
//   the same with one row highlighted. Hard-coding an open height
//   would either crop the largest variant or leave dead space at
//   the smallest. We measure the inner content with a ref and
//   `useLayoutEffect` after each render, then set the wrapper
//   height to that value — so the height transition still works,
//   but the target adapts to whatever the panel currently holds.
//
//   useLayoutEffect (not useEffect) so the height is committed
//   before the browser paints — no flash of "wrong size" between
//   render and effect.
const FILTER_CLOSED_HEIGHT = 38;
const FILTER_CLOSED_WIDTH = 188;
const FILTER_OPEN_WIDTH = 240;

function ServiceFilter({
  data,
  filter,
  services,
  onChange,
}: {
  data: VisitorAddressMapData;
  filter: AddressMapFilter;
  services: ReadonlyArray<VisitorMapServiceDef>;
  onChange: (next: AddressMapFilter) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // The measured content height when the panel is expanded — used
  // as the wrapper's `height` so it sizes to whatever drill-down
  // level is currently rendered. Recomputed on every relevant
  // change.
  const [measuredHeight, setMeasuredHeight] = useState(0);

  useLayoutEffect(() => {
    if (!expanded) return;
    const el = contentRef.current;
    if (!el) return;
    setMeasuredHeight(el.scrollHeight);
  }, [expanded, filter, data.points]);

  // Aggregate top-level service totals across the dataset so the
  // top-level rows can show counts to the right of each service
  // name — same affordance the outward heatmap uses.
  const serviceTotals = useMemo(() => {
    const totals = new Map<VisitorMapService, number>();
    for (const p of data.points) {
      for (const s of p.services) {
        totals.set(s.service, (totals.get(s.service) ?? 0) + s.count);
      }
    }
    return totals;
  }, [data.points]);

  const totalAll = useMemo(
    () => data.points.reduce((acc, p) => acc + p.total_visits, 0),
    [data.points],
  );

  const activeLabel = labelForFilter(filter, services);
  const activeColour =
    filter.level === 'all' ? theme.color.inkSubtle : colourForService(filter.service, services);

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
        transformOrigin: 'bottom left',
        width: expanded ? FILTER_OPEN_WIDTH : FILTER_CLOSED_WIDTH,
        height: expanded ? measuredHeight || FILTER_CLOSED_HEIGHT : FILTER_CLOSED_HEIGHT,
        transition: `width ${theme.motion.duration.base}ms ${theme.motion.easing.spring}, height ${theme.motion.duration.base}ms ${theme.motion.easing.spring}, box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      {/* Compact chip — visible when collapsed. */}
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

      {/* Full panel — visible when expanded. Always rendered so the
          ref-based height measurement works even before the morph. */}
      <div
        ref={contentRef}
        aria-hidden={!expanded}
        style={{
          position: 'absolute',
          inset: 0,
          padding: theme.space[3],
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[1],
          opacity: expanded ? 1 : 0,
          pointerEvents: expanded ? 'auto' : 'none',
          transition: `opacity ${theme.motion.duration.base}ms ${theme.motion.easing.standard}`,
        }}
      >
        <PanelHeader
          title={
            filter.level === 'all'
              ? 'Service'
              : services.find((s) => s.id === filter.service)?.label ?? filter.service
          }
          onClose={() => setExpanded(false)}
        />
        {filter.level === 'all' ? (
          <>
            <FilterRow
              active={false}
              highlighted
              colour={theme.color.inkSubtle}
              label="All visits"
              count={totalAll}
              onClick={() => onChange({ level: 'all' })}
            />
            {services.map((s) => (
              <FilterRow
                key={s.id}
                active={false}
                colour={colourForService(s.id, services)}
                label={s.label}
                count={serviceTotals.get(s.id) ?? 0}
                chevron
                onClick={() => onChange({ level: 'service', service: s.id })}
              />
            ))}
          </>
        ) : (
          <ServiceDrilldown data={data} filter={filter} services={services} onChange={onChange} />
        )}
      </div>
    </div>
  );
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
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
          // Allow the title to truncate gracefully on long service
          // labels so the close button always stays at the edge.
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </span>
      <button
        type="button"
        onClick={onClose}
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
          flexShrink: 0,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <ChevronDown size={14} aria-hidden />
      </button>
    </div>
  );
}

// Drill-down rows for a service-level or sub-level filter. Mirrors
// the same structure the outward heatmap uses: back row + a "All
// {service}" row + per-sub rows.
function ServiceDrilldown({
  data,
  filter,
  services,
  onChange,
}: {
  data: VisitorAddressMapData;
  filter: Extract<AddressMapFilter, { level: 'service' | 'sub' }>;
  services: ReadonlyArray<VisitorMapServiceDef>;
  onChange: (next: AddressMapFilter) => void;
}) {
  const service = filter.service;
  const serviceLabel = services.find((s) => s.id === service)?.label ?? service;
  const subTotals = useMemo(() => aggregateAddressSubs(data, service), [data, service]);
  const serviceTotal = useMemo(() => {
    let n = 0;
    for (const p of data.points) {
      const s = p.services.find((x) => x.service === service);
      if (s) n += s.count;
    }
    return n;
  }, [data, service]);
  return (
    <>
      <BackRow onClick={() => onChange({ level: 'all' })} />
      <FilterRow
        active={filter.level === 'service'}
        colour={colourForService(service, services)}
        label={`All ${serviceLabel.toLowerCase()}`}
        count={serviceTotal}
        onClick={() => onChange({ level: 'service', service })}
      />
      {subTotals.length === 0 ? (
        <span
          style={{
            margin: 0,
            fontSize: theme.type.size.xs,
            color: theme.color.inkSubtle,
            paddingLeft: theme.space[3],
          }}
        >
          No further breakdown for this service.
        </span>
      ) : (
        subTotals.map((s) => {
          const isActive = filter.level === 'sub' && filter.subKey === s.key;
          return (
            <FilterRow
              key={s.key}
              active={isActive}
              colour={colourForService(service, services)}
              label={s.label}
              count={s.count}
              onClick={() =>
                onChange({ level: 'sub', service, subKey: s.key })
              }
            />
          );
        })
      )}
    </>
  );
}

function BackRow({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: theme.color.inkMuted,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[1],
        padding: `${theme.space[1]}px ${theme.space[2]}px`,
        marginLeft: -theme.space[2],
        marginBottom: theme.space[1],
        fontFamily: 'inherit',
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.medium,
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <ArrowLeft size={12} aria-hidden />
      All services
    </button>
  );
}

function aggregateAddressSubs(
  data: VisitorAddressMapData,
  service: VisitorMapService,
): { key: string; label: string; count: number }[] {
  const totals = new Map<string, { label: string; count: number }>();
  for (const p of data.points) {
    const s = p.services.find((x) => x.service === service);
    if (!s) continue;
    for (const sub of s.subs) {
      const prior = totals.get(sub.key);
      if (prior) prior.count += sub.count;
      else totals.set(sub.key, { label: sub.label, count: sub.count });
    }
  }
  return Array.from(totals.entries())
    .map(([key, v]) => ({ key, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count);
}

function labelForFilter(
  filter: AddressMapFilter,
  services: ReadonlyArray<VisitorMapServiceDef>,
): string {
  if (filter.level === 'all') return 'All visits';
  const serviceLabel =
    services.find((s) => s.id === filter.service)?.label ?? filter.service;
  return serviceLabel;
}

function FilterRow({
  active,
  highlighted,
  colour,
  label,
  count,
  chevron,
  onClick,
}: {
  active: boolean;
  highlighted?: boolean;
  colour: string;
  label: string;
  count: number;
  chevron?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        border: active ? `1px solid ${theme.color.ink}` : '1px solid transparent',
        background: active || highlighted ? theme.color.bg : 'transparent',
        color: active ? theme.color.ink : theme.color.inkMuted,
        cursor: 'pointer',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto auto',
        alignItems: 'center',
        gap: theme.space[2],
        padding: `${theme.space[2]}px ${theme.space[3]}px`,
        borderRadius: theme.radius.input,
        fontFamily: 'inherit',
        fontSize: theme.type.size.sm,
        fontWeight: active || highlighted ? theme.type.weight.semibold : theme.type.weight.medium,
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
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span
        style={{
          fontVariantNumeric: 'tabular-nums',
          color: theme.color.inkSubtle,
          fontSize: theme.type.size.xs,
        }}
      >
        {count.toLocaleString('en-GB')}
      </span>
      {chevron ? (
        <span aria-hidden style={{ color: theme.color.inkSubtle, lineHeight: 0 }}>
          ›
        </span>
      ) : (
        <span aria-hidden />
      )}
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

function HoverCard({
  hover,
  services,
  containerRef,
}: {
  hover: HoverState;
  services: ReadonlyArray<VisitorMapServiceDef>;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const point = hover.point;
  const recent = point.visits.slice(0, RECENT_LIMIT);
  const overflow = point.visits.length - recent.length;
  const displayPostcode = formatPostcodeForDisplay(point.postcode);
  const namesLabel = composeNames(point.patient_names);

  // First render: tooltipRef is set but position hasn't been
  // computed yet. Render with opacity 0 (still measurable in the
  // DOM) so useLayoutEffect can read its size, then flip opacity
  // to 1 once we know where to place it. useLayoutEffect runs
  // before paint, so the user never sees the un-positioned state.
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<HoverPosition | null>(null);

  useLayoutEffect(() => {
    const tip = tipRef.current;
    const container = containerRef.current;
    if (!tip || !container) return;
    const rect = tip.getBoundingClientRect();
    setPos(
      computeHoverCardPosition({
        cursorX: hover.x,
        cursorY: hover.y,
        tipWidth: rect.width,
        tipHeight: rect.height,
        containerWidth: container.clientWidth,
      }),
    );
  }, [hover.x, hover.y, hover.point, containerRef]);

  return (
    <div
      ref={tipRef}
      role="tooltip"
      style={{
        position: 'absolute',
        left: pos?.left ?? hover.x,
        top: pos?.top ?? hover.y - 14,
        transform: pos?.transform ?? 'translate(-50%, -100%)',
        opacity: pos ? 1 : 0,
        transition: `opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
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
              background: colourForService(point.dominant_service, services),
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
