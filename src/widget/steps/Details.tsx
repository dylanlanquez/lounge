import { useEffect, useMemo } from 'react';
import { theme } from '../../theme/index.ts';
import type { BookingStateApi } from '../state.ts';
import { persistRememberedIdentity } from '../state.ts';

// Step 5 — Your Details.
//
// Form: first name, last name, email, phone (with country picker),
// notes (optional), Remember me, Terms checkbox.
//
// The "primary action" (Book appointment / Continue to payment)
// lives in the Summary panel on desktop and the sticky bottom dock
// on mobile, NOT inside this form. The Widget shell wires it to the
// step engine. So this step has no submit button of its own — it
// just owns the inputs and writes them back to state on every
// keystroke. Validation is checked by the parent CTA before
// advancing.
//
// Persists identity to localStorage when "Remember me" is ticked
// (default), so the next time someone books from this device the
// widget greets them by name on Step 1.

const COUNTRIES: { code: string; flag: string; dial: string; label: string }[] = [
  { code: 'GB', flag: '🇬🇧', dial: '+44', label: 'United Kingdom' },
  { code: 'IE', flag: '🇮🇪', dial: '+353', label: 'Ireland' },
  { code: 'US', flag: '🇺🇸', dial: '+1', label: 'United States' },
  { code: 'CA', flag: '🇨🇦', dial: '+1', label: 'Canada' },
  { code: 'AU', flag: '🇦🇺', dial: '+61', label: 'Australia' },
];

export function DetailsStep({ api }: { api: BookingStateApi }) {
  const d = api.state.details;

  // Persist identity whenever the form changes AND remember-me is on.
  // Debounce-free; localStorage writes are cheap and the form is
  // not large enough to thrash.
  useEffect(() => {
    if (d.rememberMe) persistRememberedIdentity(d);
  }, [d]);

  const update = <K extends keyof typeof d>(field: K, value: (typeof d)[K]) => {
    api.setState((prev) => ({ ...prev, details: { ...prev.details, [field]: value } }));
  };

  const country = useMemo(
    () => COUNTRIES.find((c) => c.code === d.phoneCountry) ?? COUNTRIES[0]!,
    [d.phoneCountry],
  );

  return (
    <div
      style={{
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: theme.space[5],
        boxShadow: theme.shadow.card,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[4],
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: theme.space[3],
        }}
      >
        <Field
          label="First name"
          value={d.firstName}
          onChange={(v) => update('firstName', v)}
          autoComplete="given-name"
        />
        <Field
          label="Last name"
          value={d.lastName}
          onChange={(v) => update('lastName', v)}
          autoComplete="family-name"
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: theme.space[3],
        }}
      >
        <Field
          label="Email"
          type="email"
          value={d.email}
          onChange={(v) => update('email', v)}
          autoComplete="email"
          placeholder="you@example.com"
        />
        <PhoneField
          country={country}
          value={d.phoneNumber}
          onCountryChange={(c) => update('phoneCountry', c)}
          onChange={(v) => update('phoneNumber', v)}
        />
      </div>

      <div>
        <Label>Notes or comments (optional)</Label>
        <textarea
          value={d.notes}
          onChange={(e) => update('notes', e.target.value)}
          rows={3}
          placeholder="Anything we should know about beforehand?"
          style={{
            width: '100%',
            padding: theme.space[3],
            borderRadius: theme.radius.input,
            border: `1px solid ${theme.color.border}`,
            background: theme.color.surface,
            color: theme.color.ink,
            fontFamily: 'inherit',
            fontSize: theme.type.size.base,
            resize: 'vertical',
            outline: 'none',
            boxSizing: 'border-box',
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = theme.color.ink;
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = theme.color.border;
          }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        <Checkbox
          checked={d.rememberMe}
          onChange={(c) => update('rememberMe', c)}
          label="Remember me on this device. Untick if you're on a public computer."
        />
        <Checkbox
          checked={d.agreeTerms}
          onChange={(c) => update('agreeTerms', c)}
          label={
            <>
              I agree to the{' '}
              <a
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: theme.color.accent, fontWeight: theme.type.weight.semibold }}
              >
                terms and conditions
              </a>
              .
            </>
          }
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Form primitives
// ─────────────────────────────────────────────────────────────────────────────

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        style={inputStyle}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = theme.color.ink;
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = theme.color.border;
        }}
      />
    </div>
  );
}

function PhoneField({
  country,
  value,
  onCountryChange,
  onChange,
}: {
  country: (typeof COUNTRIES)[number];
  value: string;
  onCountryChange: (code: string) => void;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label>Mobile number</Label>
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.input,
          background: theme.color.surface,
          overflow: 'hidden',
          height: 44,
        }}
      >
        <select
          value={country.code}
          onChange={(e) => onCountryChange(e.target.value)}
          style={{
            appearance: 'none',
            border: 'none',
            background: theme.color.bg,
            padding: `0 ${theme.space[3]}px`,
            fontFamily: 'inherit',
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            cursor: 'pointer',
            outline: 'none',
            borderRight: `1px solid ${theme.color.border}`,
            minWidth: 96,
            boxSizing: 'border-box',
          }}
          aria-label="Country code"
        >
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.flag} {c.dial}
            </option>
          ))}
        </select>
        <input
          type="tel"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="7700 900000"
          autoComplete="tel-national"
          style={{
            flex: 1,
            border: 'none',
            background: 'transparent',
            padding: `0 ${theme.space[3]}px`,
            fontFamily: 'inherit',
            fontSize: theme.type.size.base,
            color: theme.color.ink,
            outline: 'none',
            minWidth: 0,
          }}
        />
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        marginBottom: theme.space[1],
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.semibold,
        color: theme.color.ink,
      }}
    >
      {children}
    </p>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'flex-start',
        gap: theme.space[2],
        cursor: 'pointer',
        fontSize: theme.type.size.sm,
        color: theme.color.ink,
        lineHeight: theme.type.leading.snug,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{
          width: 18,
          height: 18,
          marginTop: 2,
          accentColor: theme.color.ink,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      />
      <span>{label}</span>
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 44,
  padding: `0 ${theme.space[3]}px`,
  borderRadius: theme.radius.input,
  border: `1px solid ${theme.color.border}`,
  background: theme.color.surface,
  color: theme.color.ink,
  fontFamily: 'inherit',
  fontSize: theme.type.size.base,
  outline: 'none',
  boxSizing: 'border-box',
};
