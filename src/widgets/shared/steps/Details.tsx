import { useEffect, useId, useMemo, useState } from 'react';
import type { BookingStateApi } from '../state.ts';
import { persistRememberedIdentity } from '../state.ts';
import {
  validateEmail,
  validateFirstName,
  validateLastName,
  validatePhone,
} from '../validation.ts';
import { CountryPicker } from '../CountryPicker.tsx';
import { QUIZ } from '../quizTokens.ts';
import { BookingReview } from '../BookingReview.tsx';
import type { WidgetCopy } from '../copy.ts';

// Details step — first name, last name, email, phone, notes,
// Remember me checkbox. Terms checkbox has moved to the footer on
// the Summary step.
//
// Visual language matches the retainer-cart inputs: 2px borders at
// 8px radius, focus border switches to the brand accent, error
// state turns red and surfaces the validator's message under the
// field. Layout is a wrapped grid that collapses to single-column
// on narrow widths.

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

export function DetailsStep({
  api,
  copy,
  accent = QUIZ.ACCENT,
}: {
  api: BookingStateApi;
  copy: WidgetCopy;
  accent?: string;
}) {
  const d = api.state.details;
  const [touched, setTouched] = useState<TouchedMap>(ALL_UNTOUCHED);

  useEffect(() => {
    if (d.rememberMe) persistRememberedIdentity(d);
  }, [d]);

  const update = <K extends keyof typeof d>(
    field: K,
    value: (typeof d)[K],
  ) => {
    api.setState((prev) => ({
      ...prev,
      details: { ...prev.details, [field]: value },
    }));
  };

  const markTouched = (field: keyof TouchedMap) => {
    setTouched((t) => (t[field] ? t : { ...t, [field]: true }));
  };

  const errors = useMemo(
    () => ({
      firstName: touched.firstName ? validateFirstName(d.firstName) : null,
      lastName: touched.lastName ? validateLastName(d.lastName) : null,
      email: touched.email ? validateEmail(d.email) : null,
      phoneNumber: touched.phoneNumber
        ? validatePhone(d.phoneNumber, d.phoneCountry)
        : null,
    }),
    [d.firstName, d.lastName, d.email, d.phoneNumber, d.phoneCountry, touched],
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        // Single shared column for both the form and the booking
        // review. 720px keeps form pairs readable on desktop and
        // collapses cleanly to single-column on mobile via the
        // inner Row's auto-fit grid.
        maxWidth: 720,
        margin: '0 auto',
        width: '100%',
        animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
      }}
    >
      {/* Form block — individually-bordered fields on the modal's
          #f4f4f4 surface (no outer card; the step title already
          frames the form). */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          width: '100%',
        }}
      >
        <Row>
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
        </Row>

        <Row>
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
        </Row>

        <label style={{ display: 'block' }}>
          <LabelText>Notes or comments (optional)</LabelText>
          <textarea
            value={d.notes}
            onChange={(e) => update('notes', e.target.value)}
            rows={3}
            placeholder="Anything we should know about beforehand?"
            style={{
              ...textareaStyle,
              borderColor: QUIZ.BORDER,
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = QUIZ.ACCENT;
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = QUIZ.BORDER;
            }}
          />
        </label>

        <RememberCheckbox
          checked={d.rememberMe}
          onChange={(c) => update('rememberMe', c)}
        />
      </div>

      {/* Booking review — appointment summary + price total.
          The customer fills the form above and reviews the booking
          below before ticking terms in the footer and committing.
          Each section inside BookingReview opens with its own
          small-caps label + 1px hairline, so an additional <hr>
          here would only stack two hairlines next to the first
          label. The 32px wrapper margin below is enough visual
          breathing room from the form's last input row. */}
      <div style={{ marginTop: 32 }}>
        <BookingReview api={api} copy={copy} accent={accent} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Layout helpers
// ─────────────────────────────────────────────────────────────────

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Form primitives
// ─────────────────────────────────────────────────────────────────

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
          borderColor: showError ? QUIZ.ALERT : QUIZ.BORDER,
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = showError ? QUIZ.ALERT : QUIZ.ACCENT;
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
          border: `2px solid ${showError ? QUIZ.ALERT : QUIZ.BORDER}`,
          borderRadius: QUIZ.R_INPUT,
          background: QUIZ.SURFACE,
          overflow: 'hidden',
          height: 46,
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
            padding: '0 12px',
            fontFamily: 'inherit',
            fontSize: 15,
            color: QUIZ.INK,
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
  return (
    <span
      style={{
        display: 'block',
        marginBottom: 6,
        fontSize: 13,
        fontWeight: 600,
        color: QUIZ.INK,
      }}
    >
      {children}
      {required ? (
        <>
          <span aria-hidden style={{ color: QUIZ.ALERT, marginLeft: 4 }}>
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

function ErrorLine({
  children,
  id,
}: {
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <p
      id={id}
      role="alert"
      style={{
        margin: '6px 0 0',
        fontSize: 12,
        color: QUIZ.ALERT,
        fontWeight: 600,
      }}
    >
      {children}
    </p>
  );
}

function RememberCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'flex-start',
        gap: 8,
        cursor: 'pointer',
        fontSize: 13,
        color: QUIZ.MUTED_2,
        lineHeight: 1.45,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{
          width: 16,
          height: 16,
          marginTop: 2,
          accentColor: QUIZ.ACCENT,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      />
      <span>Remember me on this device. Untick if you're on a public computer.</span>
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 46,
  padding: '0 14px',
  borderRadius: QUIZ.R_INPUT,
  border: `2px solid ${QUIZ.BORDER}`,
  background: QUIZ.SURFACE,
  color: QUIZ.INK,
  fontFamily: 'inherit',
  fontSize: 15,
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s ease',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  borderRadius: QUIZ.R_INPUT,
  border: `2px solid ${QUIZ.BORDER}`,
  background: QUIZ.SURFACE,
  color: QUIZ.INK,
  fontFamily: 'inherit',
  fontSize: 15,
  resize: 'vertical',
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s ease',
};
