// Google Maps JS API loader. Mirrors the bootstrap pattern in
// Meridian's portal-page (shopify-address-finder.md), ported to
// the Vite/TS world.
//
// Why bootstrap (not <script src=>): the new Places API
// (`AutocompleteSuggestion`, `AutocompleteSessionToken`) is only
// reachable through `google.maps.importLibrary('places')`, which
// is installed by Google's documented loader stub. A plain script
// tag with `loading=async` does NOT attach `importLibrary`, and
// the legacy `places.Autocomplete` widget is the wrong UX (Google
// chrome bolted onto the form). Stay on the new API.
//
// Loading is lazy: nothing happens until `loadPlacesLib()` is
// called, which the address autocomplete only triggers on first
// focus. So the rest of the app pays no startup cost for an
// unused dependency.

import { env } from './env.ts';

declare global {
  interface Window {
    google?: {
      maps?: {
        importLibrary?: (lib: string) => Promise<unknown>;
        __ib__?: () => void;
      };
    };
    gm_authFailure?: () => void;
  }
}

// Surface a console warning (rather than silently failing) when the
// API key is rejected by Google's referrer check. Useful during
// initial deploy while the GCP referrer allowlist is being set up.
function installAuthFailureHandler(): void {
  if (typeof window === 'undefined') return;
  if (window.gm_authFailure) return;
  window.gm_authFailure = () => {
    // eslint-disable-next-line no-console
    console.warn('[lng-places] Google auth failed — check the API key restriction in GCP.');
  };
}

// Inject the bootstrap stub once. Subsequent calls are no-ops.
function installBootstrap(apiKey: string): void {
  if (typeof window === 'undefined') return;
  const win = window as Window;
  if (win.google?.maps?.importLibrary) return;

  installAuthFailureHandler();

  // The body below is Google's documented loader stub, lightly
  // typed for TS. Keeping the original variable names so a diff
  // against the upstream snippet is readable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((g: any) => {
    let h: Promise<unknown> | null = null;
    let a: HTMLScriptElement;
    let k: string;
    const m = document;
    const b = (window as unknown as Record<string, unknown>);
    const w: Record<string, unknown> = (b['google'] as Record<string, unknown>) || (b['google'] = {} as Record<string, unknown>);
    const d: Record<string, unknown> = (w.maps as Record<string, unknown>) || (w.maps = {} as Record<string, unknown>);
    const r = new Set<string>();
    const e = new URLSearchParams();
    const u = () => {
      if (h) return h;
      h = new Promise((f, n) => {
        a = m.createElement('script');
        e.set('libraries', Array.from(r).join(','));
        for (k in g) {
          e.set(k.replace(/[A-Z]/g, (t) => '_' + (t[0] ?? '').toLowerCase()), g[k]);
        }
        e.set('callback', 'google.maps.__ib__');
        a.src = 'https://maps.googleapis.com/maps/api/js?' + e.toString();
        d['__ib__'] = f as () => void;
        a.onerror = () => {
          h = null;
          n(new Error('Google Maps load failed'));
        };
        m.head.appendChild(a);
      });
      return h;
    };
    if (!d['importLibrary']) {
      d['importLibrary'] = (f: string, ...rest: unknown[]) => {
        r.add(f);
        const args: [string, ...unknown[]] = [f, ...rest];
        return u().then(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (d['importLibrary'] as any).apply(d, args);
        });
      };
    }
  })({ key: apiKey, v: 'weekly' });
}

// Internal cache of the resolved places library so multiple consumers
// (or a remount) share one load.
let placesLibPromise: Promise<PlacesLib | null> | null = null;

// Subset of the new Places API surface we actually use.
export interface PlacesLib {
  AutocompleteSuggestion: {
    fetchAutocompleteSuggestions(request: {
      input: string;
      sessionToken?: unknown;
      includedRegionCodes?: string[];
      includedPrimaryTypes?: string[];
    }): Promise<{ suggestions: AutocompleteSuggestion[] }>;
  };
  AutocompleteSessionToken: { new (): unknown };
}

export interface AutocompleteSuggestion {
  placePrediction?: {
    mainText?: { text?: string };
    secondaryText?: { text?: string };
    text?: { text?: string };
    toPlace(): {
      fetchFields(req: { fields: string[] }): Promise<void>;
      addressComponents?: AddressComponent[];
      formattedAddress?: string;
    };
  };
}

export interface AddressComponent {
  types?: string[];
  longText?: string;
  shortText?: string;
}

// Subset of the core Maps library we use for the visitor heatmap.
// Typed loosely — Google's full Maps types come from
// @googlemaps/types but we're avoiding the dependency, so we declare
// just the surface area the heatmap needs.
//
// (Defined as `any` aliases under interfaces because Google's runtime
// objects mutate in ways TS can't usefully model without their full
// type packs. The map / circle handlers stay strongly typed at the
// call site through a thin wrapper inside the component.)
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GMap = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GMarker = any;

// SymbolPath.CIRCLE = 0 in google.maps.SymbolPath. Using the literal
// keeps us off the global google.maps namespace (modular API) — the
// constant lives on the global namespace, not the imported library
// surface. Hard-coding it is the convention Google's own samples use.
export const SYMBOL_PATH_CIRCLE = 0;

// MapsLib is a *composed* surface: Map comes from the 'maps' library,
// Marker comes from the 'marker' library. In Google's modular API
// each importLibrary() call returns only the constructors that
// belong to that library — there's no single "everything" import.
// We assemble the subset the heatmap needs into one object so
// callers don't have to know which Google library each constructor
// lives in.
export interface MapsLib {
  Map: new (el: HTMLElement, options: Record<string, unknown>) => GMap;
  Marker: new (options: Record<string, unknown>) => GMarker;
}

let mapsLibPromise: Promise<MapsLib | null> | null = null;

// Resolve the composed Maps surface. Pattern mirrors loadPlacesLib —
// shared bootstrap, lazy first-use, null when no key is configured.
export function loadMapsLib(): Promise<MapsLib | null> {
  if (!env.GOOGLE_MAPS_API_KEY) return Promise.resolve(null);
  if (mapsLibPromise) return mapsLibPromise;
  mapsLibPromise = (async () => {
    installBootstrap(env.GOOGLE_MAPS_API_KEY!);
    const win = window as Window;
    const importLibrary = win.google?.maps?.importLibrary;
    if (!importLibrary) {
      // eslint-disable-next-line no-console
      console.warn('[lng-maps] importLibrary not installed; bootstrap may have been blocked.');
      return null;
    }
    // Two parallel imports — Google deduplicates the underlying
    // script load, and these are independent libraries with no
    // ordering dependency.
    const [mapsLib, markerLib] = (await Promise.all([
      importLibrary('maps'),
      importLibrary('marker'),
    ])) as [Partial<MapsLib> | undefined, Partial<MapsLib> | undefined];
    if (!mapsLib?.Map) {
      // eslint-disable-next-line no-console
      console.warn('[lng-maps] Maps library missing Map — enable "Maps JavaScript API" in the GCP project.');
      return null;
    }
    if (!markerLib?.Marker) {
      // eslint-disable-next-line no-console
      console.warn('[lng-maps] Marker library missing Marker — enable "Maps JavaScript API" (marker is bundled with it).');
      return null;
    }
    return { Map: mapsLib.Map, Marker: markerLib.Marker };
  })();
  return mapsLibPromise;
}

// Resolve the Places library once Google has loaded. Returns null
// when no API key is configured — callers fall back to a plain
// input. Throwing would force every caller into a try/catch and
// the consequence (no autocomplete) is benign, so a null return
// is the cleaner contract.
export function loadPlacesLib(): Promise<PlacesLib | null> {
  if (!env.GOOGLE_MAPS_API_KEY) return Promise.resolve(null);
  if (placesLibPromise) return placesLibPromise;

  placesLibPromise = (async () => {
    installBootstrap(env.GOOGLE_MAPS_API_KEY!);
    const win = window as Window;
    const importLibrary = win.google?.maps?.importLibrary;
    if (!importLibrary) {
      // eslint-disable-next-line no-console
      console.warn('[lng-places] importLibrary not installed; bootstrap may have been blocked.');
      return null;
    }
    const lib = (await importLibrary('places')) as PlacesLib | undefined;
    if (!lib?.AutocompleteSuggestion) {
      // eslint-disable-next-line no-console
      console.warn(
        '[lng-places] AutocompleteSuggestion missing — enable "Places API (New)" in the GCP project.'
      );
      return null;
    }
    return lib;
  })();

  return placesLibPromise;
}
