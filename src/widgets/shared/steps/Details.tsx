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
import type { WidgetCopy } from '../copy.ts';

// Details step — first name, last name, email, phone, notes.
// Identity is always persisted to localStorage (rememberMe default
// is true; the opt-out checkbox was removed for simplicity).
// Terms checkbox lives in the footer.
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
}: {
  api: BookingStateApi;
  copy: WidgetCopy;
}) {
  void copy;
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
        // No marginTop — StepBody's flex `gap` (sourced from
        // STEP_TITLE_BOTTOM_SPACE) is the single source of truth
        // for the title-to-content rhythm across every step. Adding
        // a local marginTop here would stack on top of the gap and
        // re-introduce the per-step drift Dylan flagged.
        marginTop: 0,
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
          gap: 24,
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
            style={textareaStyle}
            onFocus={(e) => {
              e.currentTarget.style.boxShadow = `0 0 0 2px ${QUIZ.ACCENT}`;
            }}
            onBlur={(e) => {
              e.currentTarget.style.boxShadow = 'none';
            }}
          />
        </label>

      </div>

      {/* Booking summary + payment selector both live on the next
          step ('review') now. Splitting kept the payment choice off
          the below-the-fold zone on phones, where it was getting
          missed by customers who thought the form was broken. */}
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
        gap: 24,
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
        onBlur={(e) => {
          e.currentTarget.style.boxShadow = showError ? `0 0 0 2px ${QUIZ.ALERT}` : 'none';
          onBlur?.();
        }}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-required={required || undefined}
        aria-invalid={showError || undefined}
        aria-describedby={showError ? errorId : undefined}
        style={{
          ...inputStyle,
          boxShadow: showError ? `0 0 0 2px ${QUIZ.ALERT}` : 'none',
        }}
        onFocus={(e) => {
          e.currentTarget.style.boxShadow = showError
            ? `0 0 0 2px ${QUIZ.ALERT}`
            : `0 0 0 2px ${QUIZ.ACCENT}`;
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
  // Track input focus so the composite outer ring lights up
  // accent like a normal text input. Without this, focusing the
  // number input gave no visual confirmation the field was active,
  // making the mobile-number field feel "broken".
  const [focused, setFocused] = useState(false);
  const ringShadow = showError
    ? `0 0 0 2px ${QUIZ.ALERT}`
    : focused
      ? `0 0 0 2px ${QUIZ.ACCENT}`
      : 'none';
  return (
    <div>
      <LabelText required>Mobile number</LabelText>
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          border: 'none',
          borderRadius: QUIZ.R_INPUT,
          background: QUIZ.SURFACE,
          overflow: 'hidden',
          height: 46,
          boxShadow: ringShadow,
          transition: 'box-shadow 0.15s ease',
        }}
      >
        <CountryPicker value={countryCode} onChange={onCountryChange} />
        <input
          type="tel"
          value={number}
          onChange={(e) => onNumberChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
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
            padding: '0 14px',
            fontFamily: 'inherit',
            // 16px stops iOS Safari auto-zooming on focus. Any value
            // under 16 triggers the zoom; matched to inputStyle below
            // so every field reads the same size at rest.
            fontSize: 16,
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
        marginBottom: 8,
        fontSize: 15,
        fontWeight: 400,
        color: QUIZ.INK,
        lineHeight: 1.3,
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

// Borderless inputs against the modal's #f4f4f4 surface. The
// white field contrasts the page background enough to read as
// "input here"; a focus ring (via box-shadow) takes over on focus
// so the active field still gets clear visual feedback without
// the resting state shouting at the patient with 2px borders.
//
// fontSize sits at 16px (not 15) because iOS Safari auto-zooms
// the viewport on focus when an input's font-size is below 16px.
// Every text input the customer can focus must hit this threshold
// or they get a disorienting page-zoom mid-form.
const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 46,
  padding: '0 14px',
  borderRadius: QUIZ.R_INPUT,
  border: 'none',
  background: QUIZ.SURFACE,
  color: QUIZ.INK,
  fontFamily: 'inherit',
  fontSize: 16,
  outline: 'none',
  boxSizing: 'border-box',
  boxShadow: 'none',
  transition: 'box-shadow 0.15s ease',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  borderRadius: QUIZ.R_INPUT,
  border: 'none',
  background: QUIZ.SURFACE,
  color: QUIZ.INK,
  fontFamily: 'inherit',
  fontSize: 16,
  resize: 'vertical',
  outline: 'none',
  boxSizing: 'border-box',
  boxShadow: 'none',
  transition: 'box-shadow 0.15s ease',
};
