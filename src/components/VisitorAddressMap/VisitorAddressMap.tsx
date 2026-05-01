import { useEffect, useMemo, useRef, useState } from 'react';
import { theme } from '../../theme/index.ts';
import { type GMap, type GMarker, loadMapsLib } from '../../lib/googleMaps.ts';
import {
  type VisitorAddressMapData,
  type VisitorAddressPoint,
  type VisitorMapService,
  VISITOR_MAP_SERVICES,
} from '../../lib/queries/reports.ts';
import type { AddressGeocode } from '../../lib/queries/addressGeocodes.ts';
import { logFailure } from '../../lib/failureLog.ts';

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

const MARKER_COLOUR: Record<VisitorMapService, string> = {
  denture_repair: '#4F6F89',
  click_in_veneers: '#2D3539',
  same_day_appliance: theme.color.accent,
  impression_appointment: '#B36815',
  other: '#6B7378',
};

// Same dark/light-style trade-off as VisitorHeatmap — light premium
// minimalist basemap, no roads / POIs / transit / parcels.
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

  { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative.neighborhood', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
];

// SVG halo marker — outer glow, mid halo, inner core with white
// stroke. Tuned for visibility on the cream basemap.
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
          backgroundColor: '#F7F6F2',
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
          background: '#F7F6F2',
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

function ServiceFilter({
  value,
  onChange,
}: {
  value: VisitorMapService | 'all';
  onChange: (next: VisitorMapService | 'all') => void;
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
        minWidth: 220,
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

// HoverCard — surfaces full-address detail. The point.line1 and
// point.postcode are presented in their original (non-normalised)
// form so the address reads as the patient typed it. Up to 6 visits
// are listed; if there are more, a "+N more" footer makes it clear
// the list is truncated.
function HoverCard({ hover }: { hover: HoverState }) {
  const visibleVisits = hover.point.visits.slice(0, 6);
  const overflow = hover.point.visits.length - visibleVisits.length;
  const displayPostcode = formatPostcodeForDisplay(hover.point.postcode);
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
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        boxShadow: theme.shadow.raised,
        border: `1px solid ${theme.color.border}`,
        minWidth: 240,
        maxWidth: 360,
        pointerEvents: 'none',
        zIndex: 10,
        fontFamily: 'inherit',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[2],
          marginBottom: theme.space[1],
        }}
      >
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: MARKER_COLOUR[hover.point.dominant_service],
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          {hover.point.line1}
        </span>
      </div>
      <div
        style={{
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: theme.type.tracking.wide,
          marginBottom: theme.space[2],
        }}
      >
        {displayPostcode}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: theme.space[2],
          marginBottom: theme.space[2],
        }}
      >
        <span
          style={{
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1.1,
          }}
        >
          {hover.point.total_visits.toLocaleString('en-GB')}
        </span>
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          visit{hover.point.total_visits === 1 ? '' : 's'}
          {hover.point.patient_count > 1
            ? ` · ${hover.point.patient_count} patients`
            : ''}
        </span>
      </div>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: `${theme.space[2]}px 0 0`,
          borderTop: `1px solid ${theme.color.border}`,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[2],
        }}
      >
        {visibleVisits.map((v) => (
          <li
            key={v.visit_id}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[1],
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
              }}
            >
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatVisitDate(v.visit_date)}
              </span>
              {v.appointment_ref ? (
                <span
                  style={{
                    fontVariantNumeric: 'tabular-nums',
                    fontWeight: theme.type.weight.semibold,
                    color: theme.color.ink,
                  }}
                >
                  {v.appointment_ref}
                </span>
              ) : null}
            </div>
            <div style={{ fontSize: theme.type.size.sm, color: theme.color.ink, lineHeight: 1.4 }}>
              {v.items.map((it) => it.label).join(', ')}
            </div>
          </li>
        ))}
        {overflow > 0 ? (
          <li
            style={{
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              paddingTop: theme.space[1],
            }}
          >
            +{overflow} earlier visit{overflow === 1 ? '' : 's'} not shown
          </li>
        ) : null}
      </ul>
    </div>
  );
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
