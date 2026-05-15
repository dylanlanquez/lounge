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
import { PaymentChoiceCard } from '../PaymentChoiceCard.tsx';
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
        // 32px breathing room from the step title — this step has
        // no intro paragraph between StepTitle and the form, so the
        // tight 6px StepTitle bottom margin alone made the inputs
        // hug the heading.
        marginTop: 32,
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

      {/* Booking review — appointment summary + price total.
          16px above the card (matches the form's internal row gap)
          so the textarea bottom and the card top read as a tight
          continuation of the same column, not as two disconnected
          regions. The card's own 20px top padding gives the
          "Your booking" heading enough breathing room from the
          card border. */}
      <div style={{ marginTop: 16 }}>
        <BookingReview api={api} copy={copy} accent={accent} />
      </div>

      {/* Payment selector — only renders when the booking type has
          two or more enabled payment options (deposit / pay-in-full /
          pay-on-the-day). Renders nothing for free services and for
          single-option bookings, where the footer's Next button
          carries the action by itself. */}
      <PaymentChoiceCard api={api} accent={accent} />
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
const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 46,
  padding: '0 14px',
  borderRadius: QUIZ.R_INPUT,
  border: 'none',
  background: QUIZ.SURFACE,
  color: QUIZ.INK,
  fontFamily: 'inherit',
  fontSize: 15,
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
  fontSize: 15,
  resize: 'vertical',
  outline: 'none',
  boxSizing: 'border-box',
  boxShadow: 'none',
  transition: 'box-shadow 0.15s ease',
};
