import { theme } from '../theme/index.ts';
import type { VisitorMapService } from './queries/reports.ts';

// Shared visual language for the two visitor heatmaps in Reports →
// Demographics. Both `VisitorHeatmap` (outward-postcode resolution,
// all staff) and `VisitorAddressMap` (per-address resolution,
// admin-only) render markers on top of a Google Maps basemap; the
// styling needs to feel like one product even though their data
// shapes differ. Lifting the basemap style, the marker palette, and
// the SVG-icon factory into one file keeps that promise — a tweak
// to the road colour or halo opacity lands in both maps in the same
// commit.
//
// Why these choices look the way they do:
//
//   • Detailed basemap (not a stripped minimal one). At the zoom an
//     address pin sits at, you need roads and place labels to make
//     sense of where the dot is. The earlier "remove everything"
//     style traded legibility for tidiness — wrong trade-off for
//     a working dashboard.
//
//   • Cream / warm-stone palette anchored on theme.color.bg
//     (#F7F6F2). The map sits inside cream-coloured cards, so the
//     basemap can't be the same cream or it disappears against the
//     card; we shift one notch warmer/cooler for each layer to
//     create depth without going off-brand.
//
//   • POI categories that aren't useful to clinical leadership
//     (businesses, medical pins, schools, places of worship) are
//     hidden — they're noise on a catchment map. Parks and natural
//     features stay because they shape how people actually move
//     through an area.
//
//   • Roads layered: highways with a warm fill + warmer stroke,
//     arterial in white-on-cream, local in white. Same pattern
//     Apple Maps and Mapbox Streets use — the eye picks the road
//     hierarchy without reading labels.

export const MAP_STYLE: Array<Record<string, unknown>> = [
  // ── Base layers ─────────────────────────────────────────────────
  { elementType: 'geometry', stylers: [{ color: '#F7F6F2' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#5F6B72' }] },
  // White text-stroke at weight 3 keeps labels legible when they
  // overlap a road or water feature.
  { elementType: 'labels.text.stroke', stylers: [{ color: '#FFFFFF' }, { weight: 3 }] },

  // ── Land ────────────────────────────────────────────────────────
  // Two-tone landscape: man-made surfaces sit at the cream base, with
  // a slightly darker tone for natural land so urban / non-urban
  // separation reads at a glance.
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#F7F6F2' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#F0EFE8' }] },
  { featureType: 'landscape.natural.terrain', elementType: 'geometry', stylers: [{ color: '#EAE7DD' }] },

  // ── Water ───────────────────────────────────────────────────────
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#C8D8DD' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#7A8A92' }] },

  // ── Parks and natural POIs ─────────────────────────────────────
  // Kept visible and tinted in a soft sage green — open spaces are
  // useful context for "where is this dot" reading.
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#DDE4D4' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#6F7D6F' }] },

  // ── Roads ───────────────────────────────────────────────────────
  // Highway: warm tan, slightly darker stroke. Reads as the most
  // prominent road type without being shouty.
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#EBDFC4' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#D4C49E' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#6B5E48' }] },
  // Arterial + local: white fill so they read as "the streets" against
  // the cream land but stay quiet.
  { featureType: 'road.arterial', elementType: 'geometry.fill', stylers: [{ color: '#FFFFFF' }] },
  { featureType: 'road.arterial', elementType: 'geometry.stroke', stylers: [{ color: '#E2DFD6' }] },
  { featureType: 'road.arterial', elementType: 'labels.text.fill', stylers: [{ color: '#7A8389' }] },
  { featureType: 'road.local', elementType: 'geometry.fill', stylers: [{ color: '#FFFFFF' }] },
  { featureType: 'road.local', elementType: 'geometry.stroke', stylers: [{ color: '#EAE8E1' }] },
  { featureType: 'road.local', elementType: 'labels.text.fill', stylers: [{ color: '#9AA5AB' }] },
  // Hide road icons (highway shields, etc.) — they clutter at this scale.
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },

  // ── Administrative ─────────────────────────────────────────────
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#D8DAD6' }, { weight: 1 }] },
  { featureType: 'administrative.country', elementType: 'labels.text.fill', stylers: [{ color: '#3C4448' }] },
  { featureType: 'administrative.province', elementType: 'labels.text.fill', stylers: [{ color: '#4F5A60' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#5F6B72' }] },

  // ── Strip noise ────────────────────────────────────────────────
  // Anything that adds clutter without orienting value.
  { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.medical', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.attraction', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.school', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.place_of_worship', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.sports_complex', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.government', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative.neighborhood', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
];

// Categorical palette for the heatmap and its legend. Picked for
// separation across the colour wheel — brand green leads (closest
// to a Lounge default), then slate-blue, charcoal, ochre, plum,
// teal — so adjacent legend rows never bleed into each other.
//
// Why not the base theme alert/warn/etc colours: those are *status*
// colours (red = error, amber = warning) and would read as a value
// judgement on the service category. Categorical colour shouldn't
// editorialise.
const PALETTE: string[] = [
  theme.color.accent, // brand green
  '#4F6F89',          // slate blue
  '#2D3539',          // charcoal
  '#B36815',          // ochre
  '#8C2A5A',          // plum
  '#3D8FA0',          // muted teal
  '#6B6F2A',          // olive
  '#A0593A',          // terracotta
];

const OTHER_COLOUR = '#6B7378';

/** Resolve the marker colour for a service. 'Other' always lands
 *  on the stable grey; every other service is assigned a palette
 *  slot by its index in the live services list, so the same
 *  service keeps its colour across renders even as the list
 *  grows. Wraps around the palette when more than 8 services
 *  exist (rare; categorical clarity starts breaking down well
 *  before that). */
export function colourForService(
  serviceId: VisitorMapService,
  services: ReadonlyArray<{ id: VisitorMapService }>,
): string {
  if (serviceId === 'other') return OTHER_COLOUR;
  const idx = services.findIndex((s) => s.id === serviceId);
  if (idx < 0) return OTHER_COLOUR;
  return PALETTE[idx % PALETTE.length]!;
}

// Build a layered SVG marker — outer glow, mid halo, inner core
// with white stroke. The triple-layer fade gives a luminous look
// without paying the cost of CSS animations on every marker.
//
// `scaleCore` is the inner-dot radius in pixels; the halo expands
// proportionally. Halo opacities are tuned for the cream basemap —
// strong enough to read against #F7F6F2 but soft enough to feel
// luminous rather than stamped.
export function haloMarkerIcon(
  colour: string,
  scaleCore: number,
): {
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

// Background colour the map container should paint while Maps JS
// loads, so there's no flash of mismatched cream while tiles arrive.
// Matches the `geometry` styler at the top of MAP_STYLE.
export const MAP_BACKGROUND = '#F7F6F2';
