import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { type GMap, type GMarker, loadMapsLib } from '../../lib/googleMaps.ts';
import {
  type VisitorMapData,
  type VisitorMapPoint,
  type VisitorMapService,
  VISITOR_MAP_SERVICES,
} from '../../lib/queries/reports.ts';
import type { PostcodeGeocode } from '../../lib/queries/postcodeGeocodes.ts';
import { logFailure } from '../../lib/failureLog.ts';

// Hierarchical filter state. Three levels:
//   • 'all'     → every visitor regardless of service
//   • 'service' → restrict to a single service across the cohort
//   • 'sub'     → drill into a sub-category of that service
//                 (repair_variant for denture_repair, product_key for
//                 same_day_appliance, arch for click_in_veneers /
//                 impression_appointment)
//
// The heatmap component owns the state internally so a parent only
// needs to feed it data + geocodes. Callers that want external
// observation can pass `onFilterChange` later if needed.
export type VisitorMapFilter =
  | { level: 'all' }
  | { level: 'service'; service: VisitorMapService }
  | { level: 'sub'; service: VisitorMapService; subKey: string };

export interface VisitorHeatmapProps {
  data: VisitorMapData;
  geocodes: PostcodeGeocode[];
}

// Categorical palette for the heatmap and its legend.
//
// Why not the base theme colours: theme.color.alert is the project's
// red for *errors and warnings*. Using it on "Denture repair" reads
// as if the service itself is bad. A categorical legend needs colours
// that distinguish without implying status — calm, dashboard-grade,
// no semantic baggage.
//
// The palette is anchored on the brand green for "Same-day appliance"
// (the closest category to a Lounge default), then opposes it across
// the colour wheel for separation: slate-blue, charcoal, ochre, stone.
const MARKER_COLOUR: Record<VisitorMapService, string> = {
  denture_repair: '#4F6F89',         // slate blue — calm, dominant
  click_in_veneers: '#2D3539',        // charcoal — premium feel
  same_day_appliance: theme.color.accent, // brand green
  impression_appointment: '#B36815',  // ochre (kept from theme.warn)
  other: '#6B7378',                   // stone grey
};

function colourFor(service: VisitorMapService): string {
  return MARKER_COLOUR[service];
}

// Light basemap style. Premium minimalist look — Apple Maps /
// Stripe-light aesthetic: cream land, soft blue-grey water,
// barely-there admin borders. POIs / roads / transit / parcels
// stripped so the data overlays carry the visual weight.
const MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#F7F6F2' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#F7F6F2' }, { weight: 3 }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#6B7378' }] },

  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#FAF8F4' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#FAF8F4' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#D7E0E5' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#8C9AA0' }] },

  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#D8DAD6' }, { weight: 1 }] },
  { featureType: 'administrative.country', elementType: 'labels.text.fill', stylers: [{ color: '#3C4448' }] },
  { featureType: 'administrative.province', elementType: 'labels.text.fill', stylers: [{ color: '#5F6B72' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#7A8389' }] },

  // Strip noise so the data overlays own the canvas.
  { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative.neighborhood', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
];

// Build a layered SVG marker — outer glow, mid halo, inner core
// with white stroke. The triple-layer fade gives a luminous look
// without the overhead of CSS animations on a hundred markers.
// `scaleCore` is the inner-dot radius in pixels; the halo expands
// proportionally. Halo opacities are tuned for the light basemap:
// stronger than they would need to be on dark, because a 14% red
// glow against cream is invisible.
function haloMarkerIcon(colour: string, scaleCore: number): {
  url: string;
  scaledSize: { width: number; height: number };
  anchor: { x: number; y: number };
} {
  const outer = scaleCore * 3.0;
  const mid = scaleCore * 1.9;
  const inner = scaleCore;
  const size = Math.ceil(outer * 2);
  const c = size / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${c}" cy="${c}" r="${outer}" fill="${colour}" opacity="0.18"/><circle cx="${c}" cy="${c}" r="${mid}" fill="${colour}" opacity="0.38"/><circle cx="${c}" cy="${c}" r="${inner}" fill="${colour}" stroke="#FFFFFF" stroke-width="2" opacity="1"/></svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: { width: size, height: size },
    anchor: { x: c, y: c },
  };
}

interface ResolvedPoint {
  outward: string;
  count: number;
  colour: string;
}

export function VisitorHeatmap({ data, geocodes }: VisitorHeatmapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<GMarker[]>([]);
  // The map is held in state — not a ref — so the marker-drawing
  // effect re-runs once the map finishes loading. With a ref, a fast
  // cache return for geocodes would let the effect fire before the
  // map exists, return early, and never re-fire.
  const [map, setMap] = useState<GMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [filter, setFilter] = useState<VisitorMapFilter>({ level: 'all' });

  const geoIndex = useMemo(() => {
    const m = new Map<string, { lat: number; lng: number }>();
    for (const g of geocodes) m.set(g.outward, { lat: g.lat, lng: g.lng });
    return m;
  }, [geocodes]);

  // Resolve points + colour according to the active filter level. The
  // filter is the source of truth for both what to render and what
  // colour to use for it; downstream code stays declarative.
  const resolvedPoints: ResolvedPoint[] = useMemo(() => {
    if (filter.level === 'all') {
      return data.points.map((p) => ({
        outward: p.outward,
        count: p.total,
        colour: dominantServiceColour(p),
      }));
    }
    if (filter.level === 'service') {
      const colour = colourFor(filter.service);
      const out: ResolvedPoint[] = [];
      for (const p of data.points) {
        const svc = p.services.find((s) => s.service === filter.service);
        if (!svc || svc.count === 0) continue;
        out.push({ outward: p.outward, count: svc.count, colour });
      }
      return out;
    }
    // 'sub'
    const colour = colourFor(filter.service);
    const out: ResolvedPoint[] = [];
    for (const p of data.points) {
      const svc = p.services.find((s) => s.service === filter.service);
      if (!svc) continue;
      const sub = svc.subs.find((s) => s.key === filter.subKey);
      if (!sub || sub.count === 0) continue;
      out.push({ outward: p.outward, count: sub.count, colour });
    }
    return out;
  }, [data.points, filter]);

  const totalsForBadges = useMemo(
    () => ({
      visitors: resolvedPoints.reduce((s, p) => s + p.count, 0),
      areas: resolvedPoints.length,
    }),
    [resolvedPoints],
  );

  // Map creation runs once on mount. setMap is the trigger that lets
  // the circle effect downstream run with a real map — see comment on
  // the `map` state above.
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
          backgroundColor: '#F7F6F2',
          gestureHandling: 'greedy',
        });
        setMap(instance);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Map failed to load';
        setError(message);
        await logFailure({
          source: 'reports.visitor_heatmap',
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

  // Redraw markers whenever the map, resolved points, or geocodes
  // change. The map dep is what makes this correct under fast caches:
  // if geocodes resolve before the map mounts, this still re-runs on
  // setMap and the markers render.
  //
  // Markers (not Circle) are used because Circle radius is in METERS
  // — at country zoom 25 km is a faint dot, at street zoom it covers
  // a whole region. Markers are pixel-sized and stay legible across
  // zooms, which is what graduated-symbol maps need.
  //
  // We compute the bounding rect manually as a LatLngBoundsLiteral
  // ({ north, south, east, west }) rather than instantiating
  // google.maps.LatLngBounds. In the modular Maps API
  // (importLibrary), LatLngBounds lives in the 'core' library, not
  // 'maps' — `lib.LatLngBounds` is therefore undefined on the
  // 'maps' import. Passing a literal sidesteps the issue and one
  // fewer Google API surface to track.
  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    void (async () => {
      try {
        const lib = await loadMapsLib();
        if (cancelled || !lib) return;
        for (const m of markersRef.current) m.setMap(null);
        markersRef.current = [];
        if (resolvedPoints.length === 0) return;

        const max = Math.max(...resolvedPoints.map((p) => p.count));
        let north = -Infinity;
        let south = Infinity;
        let east = -Infinity;
        let west = Infinity;
        let drew = 0;
        for (const point of resolvedPoints) {
          const geo = geoIndex.get(point.outward);
          if (!geo) continue;
          // Inner-core radius in pixels. min 6 (one visit at this
          // outward), max 14 (the busiest in the cohort). The halo
          // is layered on top in the SVG icon and extends to ~3.2x
          // this radius — so the visible footprint is ~40px at the
          // top of the range, large enough to dominate the basemap
          // without occluding nearby outwards.
          const coreRadius = max > 0 ? 6 + (point.count / max) * 8 : 6;
          const marker = new lib.Marker({
            map,
            position: { lat: geo.lat, lng: geo.lng },
            title: `${point.outward}: ${point.count} visit${point.count === 1 ? '' : 's'}`,
            icon: haloMarkerIcon(point.colour, coreRadius),
            // Stack larger markers above smaller ones so a busy
            // outward doesn't bury an adjacent quieter one.
            zIndex: Math.round(point.count * 100),
          });
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
        const message = e instanceof Error ? e.message : 'Heatmap render failed';
        setError(message);
        await logFailure({
          source: 'reports.visitor_heatmap',
          severity: 'error',
          message,
          context: { stage: 'marker_render', point_count: resolvedPoints.length },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [map, resolvedPoints, geoIndex]);

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
        aria-label={`Map of where customers come from. ${resolvedPoints.length} outward postcode${resolvedPoints.length === 1 ? '' : 's'} shown.`}
        style={{
          width: '100%',
          minHeight: 480,
          borderRadius: theme.radius.input,
          // Cream backdrop matches the basemap so there's no flash
          // of mismatched colour while Maps JS loads.
          background: '#F7F6F2',
          border: `1px solid ${theme.color.border}`,
          overflow: 'hidden',
        }}
      />
      <KpiBadges visitors={totalsForBadges.visitors} areas={totalsForBadges.areas} />
      <Legend data={data} filter={filter} onChange={setFilter} />
    </div>
  );
}

function KpiBadges({ visitors, areas }: { visitors: number; areas: number }) {
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
      <Badge label="Visitors" value={visitors} />
      <span aria-hidden style={{ width: 1, background: theme.color.border, alignSelf: 'stretch' }} />
      <Badge label="Areas" value={areas} />
    </div>
  );
}

function Badge({ label, value }: { label: string; value: number }) {
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
      </span>
    </div>
  );
}

// Legend renders one of three views depending on the filter level:
//   • 'all'     — service rows, click drills into 'service'
//   • 'service' — back button + sub-category rows, click drills into 'sub'
//   • 'sub'     — same shape as 'service' with the active sub highlighted
// The "All visitors" row is always at the top of the 'all' view.
function Legend({
  data,
  filter,
  onChange,
}: {
  data: VisitorMapData;
  filter: VisitorMapFilter;
  onChange: (next: VisitorMapFilter) => void;
}) {
  // Aggregate service totals across every outward so the top-level
  // legend can show visitor counts per service. (The map itself
  // doesn't need this — but the legend item label benefits from
  // surfacing the headline count next to each service name.)
  const serviceTotals = useMemo(() => {
    const totals = new Map<VisitorMapService, number>();
    for (const p of data.points) {
      for (const s of p.services) {
        totals.set(s.service, (totals.get(s.service) ?? 0) + s.count);
      }
    }
    return totals;
  }, [data.points]);

  if (filter.level === 'all') {
    return (
      <LegendShell title="Service">
        <LegendRow
          active={false}
          colour={theme.color.inkSubtle}
          label="All visitors"
          count={data.total_visitors}
          onClick={() => undefined}
          highlighted
        />
        {VISITOR_MAP_SERVICES.map((s) => (
          <LegendRow
            key={s.id}
            active={false}
            colour={colourFor(s.id)}
            label={s.label}
            count={serviceTotals.get(s.id) ?? 0}
            chevron
            onClick={() => onChange({ level: 'service', service: s.id })}
          />
        ))}
      </LegendShell>
    );
  }

  // Drill into a service. Compose sub-totals across outwards.
  const service = filter.service;
  const serviceLabel = VISITOR_MAP_SERVICES.find((s) => s.id === service)?.label ?? service;
  const subTotals = aggregateSubTotals(data, service);

  return (
    <LegendShell title={serviceLabel}>
      <BackRow onClick={() => onChange({ level: 'all' })} />
      <LegendRow
        active={filter.level === 'service'}
        colour={colourFor(service)}
        label={`All ${serviceLabel.toLowerCase()}`}
        count={serviceTotals.get(service) ?? 0}
        onClick={() => onChange({ level: 'service', service })}
      />
      {subTotals.length === 0 ? (
        <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
          No further breakdown — items in this service have no recorded sub-category.
        </p>
      ) : (
        subTotals.map((s) => {
          const isActive = filter.level === 'sub' && filter.subKey === s.key;
          return (
            <LegendRow
              key={s.key}
              active={isActive}
              colour={colourFor(service)}
              label={s.label}
              count={s.count}
              onClick={() =>
                onChange({ level: 'sub', service, subKey: s.key })
              }
            />
          );
        })
      )}
    </LegendShell>
  );
}

function LegendShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: theme.space[3],
        left: theme.space[3],
        background: theme.color.surface,
        borderRadius: theme.radius.input,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        boxShadow: theme.shadow.card,
        border: `1px solid ${theme.color.border}`,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
        minWidth: 220,
        maxWidth: 280,
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
        {title}
      </span>
      {children}
    </div>
  );
}

function LegendRow({
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
        width: '100%',
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
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
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

function aggregateSubTotals(
  data: VisitorMapData,
  service: VisitorMapService,
): { key: string; label: string; count: number }[] {
  const totals = new Map<string, { label: string; count: number }>();
  for (const p of data.points) {
    const s = p.services.find((x) => x.service === service);
    if (!s) continue;
    for (const sub of s.subs) {
      const prior = totals.get(sub.key);
      if (prior) {
        prior.count += sub.count;
      } else {
        totals.set(sub.key, { label: sub.label, count: sub.count });
      }
    }
  }
  return Array.from(totals.entries())
    .map(([key, v]) => ({ key, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count);
}

function dominantServiceColour(point: VisitorMapPoint): string {
  let best: VisitorMapService = 'other';
  let bestCount = -1;
  for (const s of point.services) {
    if (s.count > bestCount) {
      best = s.service;
      bestCount = s.count;
    }
  }
  return colourFor(best);
}
