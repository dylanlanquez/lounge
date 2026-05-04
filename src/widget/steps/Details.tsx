import { useEffect, useId, useMemo, useState } from 'react';
import { theme } from '../../theme/index.ts';
import type { BookingStateApi } from '../state.ts';
import { persistRememberedIdentity } from '../state.ts';
import {
  validateEmail,
  validateFirstName,
  validateLastName,
  validatePhone,
} from '../validation.ts';
import { CountryPicker } from '../CountryPicker.tsx';

// Step 5 — Your Details.
//
// Form: first name, last name, email, phone (with country picker),
// notes (optional), Remember me, Terms checkbox.
//
// The "primary action" (Book appointment / Continue to payment)
// lives in the Summary panel on desktop and the sticky bottom dock
// on mobile, NOT inside this form. The Widget shell wires it to the
// step engine and gates it on the same validation rules used here
// (see widget/validation.ts) so the form's "valid" state is the
// single source of truth.
//
// Validation strategy: errors only surface after the field has been
// touched (blurred at least once) so we don't yell at the user as
// they type. Once an error is shown, it clears as soon as the input
// becomes valid — no need to blur again.
//
// Persists identity to localStorage when "Remember me" is ticked
// (default), so the next time someone books from this device the
// widget greets them by name on Step 1.

type TouchedMap = {
  firstName: boolean;
  lastName: boolean;
  email: boolean;
  phoneNumber: boolean;
};

const ALL_UNTOUCHED: TouchedMap = {
  firstName: false,
  lastName: false,
  email: false,
  phoneNumber: false,
};

export function DetailsStep({ api }: { api: BookingStateApi }) {
  const d = api.state.details;
  const [touched, setTouched] = useState<TouchedMap>(ALL_UNTOUCHED);

  // Persist identity whenever the form changes AND remember-me is on.
  // Debounce-free; localStorage writes are cheap and the form is
  // not large enough to thrash.
  useEffect(() => {
    if (d.rememberMe) persistRememberedIdentity(d);
  }, [d]);

  const update = <K extends keyof typeof d>(field: K, value: (typeof d)[K]) => {
    api.setState((prev) => ({ ...prev, details: { ...prev.details, [field]: value } }));
  };

  const markTouched = (field: keyof TouchedMap) => {
    setTouched((t) => (t[field] ? t : { ...t, [field]: true }));
  };

  const errors = useMemo(
    () => ({
      firstName: touched.firstName ? validateFirstName(d.firstName) : null,
      lastName: touched.lastName ? validateLastName(d.lastName) : null,
      email: touched.email ? validateEmail(d.email) : null,
      phoneNumber: touched.phoneNumber ? validatePhone(d.phoneNumber, d.phoneCountry) : null,
    }),
    [d.firstName, d.lastName, d.email, d.phoneNumber, d.phoneCountry, touched],
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
          required
          value={d.firstName}
          onChange={(v) => update('firstName', v)}
          onBlur={() => markTouched('firstName')}
          autoComplete="given-name"
          error={errors.firstName}
        />
        <Field
          label="Last name"
          required
          value={d.lastName}
          onChange={(v) => update('lastName', v)}
          onBlur={() => markTouched('lastName')}
          autoComplete="family-name"
          error={errors.lastName}
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
          required
          type="email"
          value={d.email}
          onChange={(v) => update('email', v)}
          onBlur={() => markTouched('email')}
          autoComplete="email"
          placeholder="you@example.com"
          error={errors.email}
        />
        <PhoneField
          countryCode={d.phoneCountry}
          number={d.phoneNumber}
          onCountryChange={(c) => update('phoneCountry', c)}
          onNumberChange={(v) => update('phoneNumber', v)}
          onBlur={() => markTouched('phoneNumber')}
          error={errors.phoneNumber}
        />
      </div>

      <label style={{ display: 'block' }}>
        <LabelText>Notes or comments (optional)</LabelText>
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
      </label>

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
  onBlur,
  type = 'text',
  placeholder,
  autoComplete,
  required = false,
  error = null,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  error?: string | null;
}) {
  const showError = Boolean(error);
  const errorId = useId();
  // Wrapping input in <label> implicitly associates the two for
  // screen readers without needing matching id/htmlFor pairs.
  return (
    <label style={{ display: 'block' }}>
      <LabelText required={required}>{label}</LabelText>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-required={required || undefined}
        aria-invalid={showError || undefined}
        aria-describedby={showError ? errorId : undefined}
        style={{
          ...inputStyle,
          borderColor: showError ? theme.color.alert : theme.color.border,
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = showError
            ? theme.color.alert
            : theme.color.ink;
        }}
      />
      {showError ? <ErrorLine id={errorId}>{error}</ErrorLine> : null}
    </label>
  );
}

function PhoneField({
  countryCode,
  number,
  onCountryChange,
  onNumberChange,
  onBlur,
  error = null,
}: {
  countryCode: string;
  number: string;
  onCountryChange: (code: string) => void;
  onNumberChange: (v: string) => void;
  onBlur?: () => void;
  error?: string | null;
}) {
  const showError = Boolean(error);
  const errorId = useId();
  return (
    <div>
      <LabelText required>Mobile number</LabelText>
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          border: `1px solid ${showError ? theme.color.alert : theme.color.border}`,
          borderRadius: theme.radius.input,
          background: theme.color.surface,
          overflow: 'hidden',
          height: 44,
        }}
      >
        <CountryPicker value={countryCode} onChange={onCountryChange} />
        <input
          type="tel"
          value={number}
          onChange={(e) => onNumberChange(e.target.value)}
          onBlur={onBlur}
          placeholder="7700 900000"
          autoComplete="tel-national"
          aria-label="Mobile number"
          aria-required
          aria-invalid={showError || undefined}
          aria-describedby={showError ? errorId : undefined}
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
      {showError ? <ErrorLine id={errorId}>{error}</ErrorLine> : null}
    </div>
  );
}

function LabelText({
  children,
  required = false,
}: {
  children: React.ReactNode;
  required?: boolean;
}) {
  // Span (not <p>) so this renders as phrasing content inside a
  // wrapping <label>. Adds a visible required marker plus a
  // hidden "(required)" string so screen readers announce
  // "Last name (required)" rather than "Last name star".
  return (
    <span
      style={{
        display: 'block',
        marginBottom: theme.space[1],
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.semibold,
        color: theme.color.ink,
      }}
    >
      {children}
      {required ? (
        <>
          <span aria-hidden style={{ color: theme.color.alert, marginLeft: 4 }}>
            *
          </span>
          <span style={SR_ONLY}> (required)</span>
        </>
      ) : null}
    </span>
  );
}

const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
};

function ErrorLine({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <p
      id={id}
      role="alert"
      style={{
        margin: `${theme.space[1]}px 0 0`,
        fontSize: theme.type.size.xs,
        color: theme.color.alert,
        fontWeight: theme.type.weight.semibold,
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
