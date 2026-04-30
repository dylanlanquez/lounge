import { type CSSProperties, useRef, useState } from 'react';
import { theme } from '../../theme/index.ts';
import {
  useAddressAutocomplete,
  type ParsedAddress,
} from '../../lib/useAddressAutocomplete.ts';

// Address line 1 input with Google Places autocomplete dropdown.
// Same chrome as the arrival form's EditableFieldCard so it
// nests inside the customer-step grid without standing out — the
// only addition is the suggestion list that pops below the input
// once the patient starts typing.
//
// On selection the parent receives a ParsedAddress (line1, line2,
// city, postcode, countryCode) and is responsible for writing
// each field into form state. Address line 2 is intentionally
// CLEARED on selection (Places never returns sub-premise data
// reliably enough to repopulate it) so the patient can re-enter
// "Flat 3" or whatever applies to the new address.

export interface AddressAutocompleteFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSelectPlace: (parsed: ParsedAddress) => void;
  required?: boolean;
  helper?: string;
}

const cardLabelStyle: CSSProperties = {
  fontSize: theme.type.size.xs,
  fontWeight: theme.type.weight.medium,
  color: theme.color.inkMuted,
};

export function AddressAutocompleteField({
  label,
  value,
  onChange,
  onSelectPlace,
  required = false,
  helper,
}: AddressAutocompleteFieldProps) {
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const blurTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { state, selectSuggestion, availability } = useAddressAutocomplete({
    query: value,
    // Only fetch while the input is focused. Defocus pauses
    // suggestion polling so a stale value doesn't keep hitting
    // Google after the patient has moved on.
    active: focused,
    onSelect: (parsed) => {
      onSelectPlace(parsed);
      // Pull focus to address line 2 so the patient can type a
      // flat / unit number if they have one. Same handoff Meridian
      // portal uses.
      setActiveIndex(-1);
      window.setTimeout(() => {
        const form = inputRef.current?.form;
        if (!form) return;
        const next = form.elements.namedItem('portal_ship_line2');
        if (next instanceof HTMLElement) next.focus();
      }, 0);
    },
  });

  // Open the dropdown as soon as the query crosses the minimum
  // length, but only when autocomplete is actually wired up. If
  // the API key is missing or "Places API (New)" isn't enabled,
  // availability flips to 'unavailable' and the field falls back
  // to a plain input — no dropdown, no permanent spinner.
  const trimmed = value.trim();
  const queryReady = trimmed.length >= 3;
  const visibleDropdown = focused && queryReady && availability !== 'unavailable';
  const showSpinner = availability === 'loading' || state.loading;
  const showEmpty =
    availability === 'ready' && !state.loading && state.suggestions.length === 0 && !state.error;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!visibleDropdown) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, state.suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      void selectSuggestion(activeIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setActiveIndex(-1);
      inputRef.current?.blur();
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <label
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[2],
          padding: `${theme.space[3]}px ${theme.space[4]}px`,
          borderRadius: theme.radius.input,
          background: theme.color.surface,
          border: `1px solid ${focused ? theme.color.ink : theme.color.border}`,
          transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
          cursor: 'text',
        }}
      >
        <span style={cardLabelStyle}>
          {label}
          {required ? <RequiredMark /> : null}
        </span>
        <input
          ref={inputRef}
          name="portal_ship_line1"
          autoComplete="address-line1"
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          onFocus={() => {
            if (blurTimerRef.current) {
              window.clearTimeout(blurTimerRef.current);
              blurTimerRef.current = null;
            }
            setFocused(true);
          }}
          onBlur={() => {
            // Delay so a mousedown on a suggestion can fire before
            // we tear the dropdown down (mousedown → blur → click,
            // and click would hit the now-unmounted item).
            blurTimerRef.current = window.setTimeout(() => {
              setFocused(false);
              setActiveIndex(-1);
            }, 140);
          }}
          onKeyDown={handleKeyDown}
          aria-required={required || undefined}
          aria-autocomplete="list"
          aria-expanded={visibleDropdown}
          style={{
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            outline: 'none',
            padding: 0,
            fontFamily: 'inherit',
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
            width: '100%',
            minWidth: 0,
          }}
        />
        {helper ? (
          <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
            {helper}
          </span>
        ) : null}
      </label>

      {visibleDropdown ? (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            // Above the page chrome (sticky stepper at 20, fixed
            // ActionBar at 20). 50 leaves headroom for any future
            // overlay without a refactor.
            zIndex: 50,
            background: theme.color.surface,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.input,
            boxShadow: theme.shadow.card,
            maxHeight: 280,
            overflowY: 'auto',
          }}
        >
          {state.error ? (
            <div
              role="status"
              style={{
                padding: `${theme.space[3]}px ${theme.space[4]}px`,
                fontSize: theme.type.size.sm,
                color: theme.color.alert,
              }}
            >
              Couldn't reach Places. Type the address manually.
            </div>
          ) : showSpinner ? (
            <div
              role="status"
              style={{
                padding: `${theme.space[3]}px ${theme.space[4]}px`,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
              }}
            >
              Searching addresses…
            </div>
          ) : showEmpty ? (
            <div
              role="status"
              style={{
                padding: `${theme.space[3]}px ${theme.space[4]}px`,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
              }}
            >
              No matches. Try a longer query, or fill the rest manually.
            </div>
          ) : (
            state.suggestions.map((sug, i) => {
              const main = sug.placePrediction?.mainText?.text ?? sug.placePrediction?.text?.text ?? '';
              const secondary = sug.placePrediction?.secondaryText?.text ?? '';
              const active = i === activeIndex;
              return (
                <button
                  key={i}
                  type="button"
                  role="option"
                  aria-selected={active}
                  // mousedown not click — click fires after blur and
                  // the dropdown is gone by then.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    void selectSuggestion(i);
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                  style={{
                    appearance: 'none',
                    width: '100%',
                    textAlign: 'left',
                    background: active ? theme.color.bg : 'transparent',
                    border: 'none',
                    borderBottom: `1px solid ${theme.color.border}`,
                    padding: `${theme.space[3]}px ${theme.space[4]}px`,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    WebkitTapHighlightColor: 'transparent',
                  }}
                >
                  <span
                    style={{
                      fontSize: theme.type.size.sm,
                      fontWeight: theme.type.weight.semibold,
                      color: theme.color.ink,
                    }}
                  >
                    {main}
                  </span>
                  {secondary ? (
                    <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                      {secondary}
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

function RequiredMark() {
  return (
    <span
      aria-hidden
      style={{
        color: theme.color.alert,
        marginLeft: 4,
        fontWeight: theme.type.weight.semibold,
      }}
    >
      *
    </span>
  );
}
