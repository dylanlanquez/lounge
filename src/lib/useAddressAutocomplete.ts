import { useEffect, useRef, useState } from 'react';
import {
  loadPlacesLib,
  type AddressComponent,
  type AutocompleteSuggestion,
  type PlacesLib,
} from './googleMaps.ts';

// Parsed address shape returned to the caller after a place is
// selected. Mirrors Meridian portal-page's field mapping so the
// arrival form and the customer portal hand back identical data
// for the same Google place.
export interface ParsedAddress {
  address1: string;
  address2: string;
  city: string;
  postcode: string;
  countryCode: string;
}

export interface AutocompleteState {
  loading: boolean;
  suggestions: AutocompleteSuggestion[];
  error: string | null;
}

const SUGGEST_DEBOUNCE_MS = 180;
const MIN_QUERY_LENGTH = 3;

// Hook that drives Places autocomplete against an external `query`
// string. The consumer owns the input value (so it integrates with
// a controlled form); the hook fetches predictions when the query
// looks meaningful and exposes a `selectSuggestion(index)` that
// resolves the chosen place into a ParsedAddress and resets the
// session token (one token per autocomplete session, per Google's
// billing recipe).
//
// Returns null Places when the API key is missing — UI should fall
// back to a plain input in that case.
export function useAddressAutocomplete(opts: {
  query: string;
  // Whether to actively fetch suggestions. Set false while the
  // input isn't focused so a stale value doesn't keep polling.
  active: boolean;
  onSelect: (parsed: ParsedAddress) => void;
}): {
  state: AutocompleteState;
  selectSuggestion: (index: number) => Promise<void>;
  ready: boolean;
} {
  const [state, setState] = useState<AutocompleteState>({
    loading: false,
    suggestions: [],
    error: null,
  });
  const placesRef = useRef<PlacesLib | null>(null);
  const sessionTokenRef = useRef<unknown | null>(null);
  const [ready, setReady] = useState(false);

  // Lazy-load the Places library on first activation. Subsequent
  // mounts share the same loader promise from googleMaps.ts.
  useEffect(() => {
    if (!opts.active) return;
    if (placesRef.current) return;
    let cancelled = false;
    void (async () => {
      const lib = await loadPlacesLib();
      if (cancelled) return;
      if (!lib) {
        setReady(false);
        return;
      }
      placesRef.current = lib;
      sessionTokenRef.current = new lib.AutocompleteSessionToken();
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [opts.active]);

  // Debounced fetch. Cancelled by query/active change so a fast
  // typist never sees stale suggestions for an old keystroke.
  useEffect(() => {
    if (!opts.active) {
      setState({ loading: false, suggestions: [], error: null });
      return;
    }
    const places = placesRef.current;
    const session = sessionTokenRef.current;
    if (!places || !session) return;

    const trimmed = opts.query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setState({ loading: false, suggestions: [], error: null });
      return;
    }

    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setState((s) => ({ ...s, loading: true }));
      try {
        const res = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: trimmed,
          sessionToken: session,
          includedRegionCodes: ['gb'],
          // Street-level types only — no businesses or POIs in the
          // suggestions, since this is a delivery-address form.
          includedPrimaryTypes: ['street_address', 'premise', 'subpremise', 'route'],
        });
        if (cancelled) return;
        setState({ loading: false, suggestions: res.suggestions ?? [], error: null });
      } catch (err) {
        if (cancelled) return;
        setState({
          loading: false,
          suggestions: [],
          error: err instanceof Error ? err.message : 'Could not fetch suggestions',
        });
      }
    }, SUGGEST_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [opts.query, opts.active, ready]);

  const selectSuggestion = async (index: number) => {
    const places = placesRef.current;
    const sug = state.suggestions[index];
    if (!places || !sug?.placePrediction) return;
    try {
      const place = sug.placePrediction.toPlace();
      await place.fetchFields({ fields: ['addressComponents', 'formattedAddress'] });
      const parsed = parseAddress(place.addressComponents ?? [], place.formattedAddress);
      opts.onSelect(parsed);
      // Mint a fresh token for the next autocomplete session — one
      // token covers many keystrokes plus exactly one selection in
      // Google's billing model.
      sessionTokenRef.current = new places.AutocompleteSessionToken();
      setState({ loading: false, suggestions: [], error: null });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[lng-places] selection failed', err);
    }
  };

  return { state, selectSuggestion, ready };
}

function lookupComponent(
  components: AddressComponent[],
  type: string,
  prop: 'longText' | 'shortText' = 'longText'
): string {
  for (const c of components) {
    if (c.types?.includes(type)) {
      return c[prop] ?? '';
    }
  }
  return '';
}

function parseAddress(components: AddressComponent[], formattedAddress?: string): ParsedAddress {
  const streetNum = lookupComponent(components, 'street_number');
  const route = lookupComponent(components, 'route');
  // postal_town is the UK-canonical "city" (e.g. "Glasgow").
  // locality covers the rest of the world.
  const city = lookupComponent(components, 'postal_town') || lookupComponent(components, 'locality');
  const postcode = (lookupComponent(components, 'postal_code') || '').toUpperCase();
  const country = (lookupComponent(components, 'country', 'shortText') || 'GB').toUpperCase();
  let address1 = `${streetNum} ${route}`.trim();
  if (!address1 && formattedAddress) {
    address1 = formattedAddress.split(',')[0]?.trim() ?? '';
  }
  return {
    address1,
    // address2 cleared on selection — picking a new place should
    // reset the unit/flat line, since it belongs to the previous
    // address. Mirrors the portal flow.
    address2: '',
    city,
    postcode,
    countryCode: country,
  };
}
