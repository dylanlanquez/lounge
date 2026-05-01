import { useEffect, useMemo, useRef, useState } from 'react';
import { theme } from '../../theme/index.ts';
import { type GMap, type GCircle, loadMapsLib } from '../../lib/googleMaps.ts';
import {
  type VisitorMapData,
  type VisitorMapPoint,
  type VisitorMapService,
  VISITOR_MAP_SERVICES,
} from '../../lib/queries/reports.ts';
import type { PostcodeGeocode } from '../../lib/queries/postcodeGeocodes.ts';
import { logFailure } from '../../lib/failureLog.ts';

export interface VisitorHeatmapProps {
  data: VisitorMapData;
  geocodes: PostcodeGeocode[];
  // Selected service from the legend, or null for "all".
  selectedService: VisitorMapService | null;
  onSelectService: (service: VisitorMapService | null) => void;
}

// Hand-tuned palette for the five service kinds. Pulled from the
// theme rather than hardcoded — denture_repair = alert tone,
// click_in_veneers = ink, same_day_appliance = accent, impression
// = warn, other = inkSubtle. Matches the rest of Lounge's reports
// so the legend reads as part of the same visual language.
function colourFor(service: VisitorMapService): string {
  switch (service) {
    case 'denture_repair':
      return theme.color.alert;
    case 'click_in_veneers':
      return theme.color.ink;
    case 'same_day_appliance':
      return theme.color.accent;
    case 'impression_appointment':
      return theme.color.warn;
    case 'other':
      return theme.color.inkSubtle;
  }
}

// Light, low-contrast Google Maps style. Keeps the UK background as
// a quiet canvas so the patient-density circles are the foreground
// element. Built once and passed to every Map instance — Google
// caches by reference.
const MAP_STYLE = [
  { featureType: 'all', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#d0d4d4' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#f0eee9' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#e6e8ea' }] },
  { featureType: 'road', elementType: 'all', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', elementType: 'all', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi', elementType: 'all', stylers: [{ visibility: 'off' }] },
];

export function VisitorHeatmap({
  data,
  geocodes,
  selectedService,
  onSelectService,
}: VisitorHeatmapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<GMap | null>(null);
  const circlesRef = useRef<GCircle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  // outward → lat/lng for fast O(1) lookup during render.
  const geoIndex = useMemo(() => {
    const m = new Map<string, { lat: number; lng: number }>();
    for (const g of geocodes) m.set(g.outward, { lat: g.lat, lng: g.lng });
    return m;
  }, [geocodes]);

  // Filtered points reflect the legend selection — when "all" is
  // selected we render every point; when a service is selected we
  // render points whose by_service[service] > 0, sized by that
  // count instead of the total.
  const filteredPoints = useMemo(() => {
    if (!selectedService) return data.points;
    return data.points
      .map((p) => ({ ...p, total: p.by_service[selectedService] }))
      .filter((p) => p.total > 0);
  }, [data.points, selectedService]);

  // Mount + style the map once, then redraw circles on every data
  // change. Mounting is async because we lazy-load the Maps library.
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
        // UK-centric initial view. Bounds ranged over Lands' End to
        // John o'Groats so every UK outward sits within the frame.
        const map = new lib.Map(containerRef.current, {
          center: { lat: 54.0, lng: -2.5 },
          zoom: 6,
          disableDefaultUI: false,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          styles: MAP_STYLE,
          backgroundColor: theme.color.bg,
          gestureHandling: 'greedy',
        });
        mapRef.current = map;
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

  // Redraw whenever the data, filter, or geocode set changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let cancelled = false;
    void (async () => {
      const lib = await loadMapsLib();
      if (cancelled || !lib) return;
      // Tear down prior circles. Google's circles aren't auto-cleaned
      // on data changes; explicit setMap(null) detaches them.
      for (const c of circlesRef.current) {
        c.setMap(null);
      }
      circlesRef.current = [];
      if (filteredPoints.length === 0) return;

      const max = Math.max(...filteredPoints.map((p) => p.total));
      const bounds = new lib.LatLngBounds();
      for (const point of filteredPoints) {
        const geo = geoIndex.get(point.outward);
        if (!geo) continue;
        const colour = pickPointColour(point, selectedService);
        // Radius scales between 4km (smallest) and 25km (largest)
        // based on relative count so even one-visit outwards are
        // visible without smothering the map at high counts.
        const radiusMeters = 4000 + (max > 0 ? (point.total / max) * 21000 : 0);
        const circle = new lib.Circle({
          map,
          center: { lat: geo.lat, lng: geo.lng },
          radius: radiusMeters,
          strokeColor: colour,
          strokeOpacity: 0.55,
          strokeWeight: 1,
          fillColor: colour,
          fillOpacity: 0.35,
          clickable: false,
        });
        circlesRef.current.push(circle);
        bounds.extend({ lat: geo.lat, lng: geo.lng });
      }
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, 64);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filteredPoints, geoIndex, selectedService]);

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
        aria-label={`Map of where customers come from. ${filteredPoints.length} outward postcode${filteredPoints.length === 1 ? '' : 's'} shown.`}
        style={{
          width: '100%',
          minHeight: 480,
          borderRadius: theme.radius.input,
          background: theme.color.bg,
          border: `1px solid ${theme.color.border}`,
          overflow: 'hidden',
        }}
      />
      <KpiBadges
        visitors={filteredPoints.reduce((s, p) => s + p.total, 0)}
        areas={filteredPoints.length}
      />
      <Legend
        selected={selectedService}
        onSelect={onSelectService}
      />
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

function Legend({
  selected,
  onSelect,
}: {
  selected: VisitorMapService | null;
  onSelect: (s: VisitorMapService | null) => void;
}) {
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
        minWidth: 180,
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
        onClick={() => onSelect(null)}
        style={legendItemStyle(selected === null)}
      >
        <span style={legendDotStyle(theme.color.inkSubtle)} aria-hidden />
        <span style={{ flex: 1, textAlign: 'left' }}>All visitors</span>
      </button>
      {VISITOR_MAP_SERVICES.map((s) => {
        const active = selected === s.id;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(active ? null : s.id)}
            style={legendItemStyle(active)}
          >
            <span style={legendDotStyle(colourFor(s.id))} aria-hidden />
            <span style={{ flex: 1, textAlign: 'left' }}>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function legendItemStyle(active: boolean) {
  return {
    appearance: 'none' as const,
    border: 'none' as const,
    background: active ? theme.color.bg : 'transparent',
    color: active ? theme.color.ink : theme.color.inkMuted,
    cursor: 'pointer' as const,
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: theme.space[2],
    padding: `${theme.space[2]}px ${theme.space[3]}px`,
    borderRadius: theme.radius.input,
    fontFamily: 'inherit',
    fontSize: theme.type.size.sm,
    fontWeight: active ? theme.type.weight.semibold : theme.type.weight.medium,
    width: '100%',
    textAlign: 'left' as const,
    WebkitTapHighlightColor: 'transparent' as const,
  };
}

function legendDotStyle(colour: string) {
  return {
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: colour,
    flexShrink: 0,
  };
}

function pickPointColour(point: VisitorMapPoint, selectedService: VisitorMapService | null): string {
  if (selectedService) return colourFor(selectedService);
  // No selection: pick the dominant service's colour for the
  // outward. Ties broken by the service order in VISITOR_MAP_SERVICES.
  let best: VisitorMapService = 'other';
  let bestCount = -1;
  for (const s of VISITOR_MAP_SERVICES) {
    const c = point.by_service[s.id];
    if (c > bestCount) {
      best = s.id;
      bestCount = c;
    }
  }
  return colourFor(best);
}
