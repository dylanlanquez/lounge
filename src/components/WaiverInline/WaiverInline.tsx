import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '../Button/Button.tsx';
import { Input } from '../Input/Input.tsx';
import { SignaturePad, svgFromPath } from '../SignaturePad/SignaturePad.tsx';
import { theme } from '../../theme/index.ts';
import { signWaiver, type WaiverSection } from '../../lib/queries/waiver.ts';

// Inline variant of the waiver flow used by the arrival wizard's step 3.
// Walks the patient through each required section as a single page —
// Terms list, signature pad, witnessed-by, confirmation tick — and
// flips to the next section without changing screens.
//
// WaiverSheet (the modal version) is kept unchanged for the visit page,
// where signing is a one-off context that warrants a popover. The
// arrival flow needs the consent step to live inline so it reads as
// part of one continuous document the patient is reviewing.

const PAD_WIDTH = 600;
const PAD_HEIGHT = 220;

export interface WaiverInlineProps {
  patientId: string | null;
  // Visit doesn't exist yet at intake time. Pass null and the parent
  // will resolve the row at submit time via patient_id-scoped lookups.
  visitId: string | null;
  sections: WaiverSection[];
  patientName: string;
  // Pre-filled with the staff member's name. Editable in case a
  // colleague is the actual witness on the day.
  defaultWitnessName: string;
  onAllSigned: () => void;
}

export function WaiverInline({
  patientId,
  visitId,
  sections,
  patientName,
  defaultWitnessName,
  onAllSigned,
}: WaiverInlineProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [path, setPath] = useState('');
  const [witness, setWitness] = useState(defaultWitnessName);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedKeys, setSignedKeys] = useState<Set<string>>(new Set());
  const [padKey, setPadKey] = useState(0);

  const currentSection = sections[stepIndex];
  const isLast = stepIndex === sections.length - 1;
  const empty = path.trim().length === 0;

  // Reset transient state whenever the parent feeds in a new sections
  // list (e.g. the patient just changed their mind on which line items
  // they're agreeing to and re-rendered the consent step).
  useEffect(() => {
    setStepIndex(0);
    setPath('');
    setConfirmed(false);
    setSignedKeys(new Set());
    setPadKey((k) => k + 1);
  }, [sections]);

  const headerCopy = useMemo(() => {
    if (!currentSection) return { title: 'Consent', sub: '' };
    return {
      title: currentSection.title,
      sub: 'Customer reads and signs',
    };
  }, [currentSection]);

  if (!currentSection) {
    // Empty sections list = nothing to sign. Render a calm completed
    // state rather than nothing — the wizard's step gate already
    // accepts this as ready.
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: theme.space[3],
          padding: theme.space[8],
          textAlign: 'center',
          color: theme.color.inkMuted,
        }}
      >
        <CheckCircle2 size={32} color={theme.color.accent} />
        <p style={{ margin: 0 }}>No consent needed for this appointment.</p>
      </div>
    );
  }

  const submit = async () => {
    if (!patientId || empty || !confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const svg = svgFromPath(path, PAD_WIDTH, PAD_HEIGHT);
      await signWaiver({
        patient_id: patientId,
        visit_id: visitId,
        section: currentSection,
        signature_svg: svg,
      });
      const nextSigned = new Set(signedKeys);
      nextSigned.add(currentSection.key);
      setSignedKeys(nextSigned);
      if (isLast) {
        onAllSigned();
      } else {
        setStepIndex(stepIndex + 1);
        setPath('');
        setConfirmed(false);
        setPadKey((k) => k + 1);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save signature');
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !empty && confirmed && !busy && witness.trim().length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <header>
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.xl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
          }}
        >
          {headerCopy.title}
        </h2>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            color: theme.color.inkMuted,
            fontSize: theme.type.size.base,
          }}
        >
          {headerCopy.sub}
        </p>
      </header>

      <ProgressChips
        sections={sections}
        stepIndex={stepIndex}
        signedKeys={signedKeys}
      />

      <div
        style={{
          padding: `${theme.space[5]}px ${theme.space[6]}px`,
          borderRadius: theme.radius.card,
          border: `1px solid ${theme.color.border}`,
          background: theme.color.surface,
        }}
      >
        <h3
          style={{
            margin: `0 0 ${theme.space[3]}px`,
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          Terms and Conditions
        </h3>
        <p
          style={{
            margin: `0 0 ${theme.space[3]}px`,
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
          }}
        >
          By signing below, {patientName} acknowledges and agrees to the following:
        </p>
        <ol
          style={{
            margin: 0,
            paddingLeft: theme.space[5],
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[3],
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            lineHeight: 1.6,
          }}
        >
          {currentSection.terms.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
      </div>

      <div>
        <p
          style={{
            margin: `0 0 ${theme.space[2]}px`,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.medium,
            color: theme.color.ink,
          }}
        >
          Customer signature
        </p>
        <SignaturePad
          key={padKey}
          width={PAD_WIDTH}
          height={PAD_HEIGHT}
          ariaLabel={`Signature for ${currentSection.title}`}
          onChange={(d) => setPath(d)}
        />
        <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
          Version {currentSection.version}.
        </p>
      </div>

      <Input
        label="Witnessed by"
        value={witness}
        onChange={(e) => setWitness(e.currentTarget.value)}
      />

      <Checkbox
        checked={confirmed}
        onChange={setConfirmed}
        label="I confirm the customer has read and signed the waiver"
      />

      {error ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: theme.space[3],
            borderRadius: theme.radius.input,
            border: `1px solid ${theme.color.alert}`,
            background: theme.color.surface,
            color: theme.color.alert,
            fontSize: theme.type.size.sm,
          }}
        >
          {error}
        </p>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          variant="primary"
          onClick={submit}
          disabled={!canSubmit}
          loading={busy}
          showArrow={!isLast}
        >
          {busy
            ? 'Saving…'
            : isLast
              ? 'Sign and finish'
              : 'Sign and continue'}
        </Button>
      </div>
    </div>
  );
}

function ProgressChips({
  sections,
  stepIndex,
  signedKeys,
}: {
  sections: WaiverSection[];
  stepIndex: number;
  signedKeys: Set<string>;
}) {
  if (sections.length <= 1) return null;
  return (
    <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
      {sections.map((s, i) => {
        const isSigned = signedKeys.has(s.key);
        const isCurrent = i === stepIndex;
        const styles: CSSProperties = {
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[1],
          padding: `${theme.space[1]}px ${theme.space[3]}px`,
          borderRadius: theme.radius.pill,
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.medium,
          background: isSigned
            ? theme.color.accentBg
            : isCurrent
              ? theme.color.ink
              : theme.color.surface,
          color: isSigned
            ? theme.color.accent
            : isCurrent
              ? theme.color.surface
              : theme.color.inkMuted,
          border: isSigned || isCurrent ? 'none' : `1px solid ${theme.color.border}`,
        };
        return (
          <span key={s.key} style={styles}>
            {isSigned ? <CheckCircle2 size={14} /> : null}
            {s.title}
          </span>
        );
      })}
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        cursor: 'pointer',
        padding: theme.space[3],
        borderRadius: theme.radius.input,
        border: `1px solid ${checked ? theme.color.ink : theme.color.border}`,
        background: theme.color.surface,
        userSelect: 'none',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          borderRadius: 6,
          background: checked ? theme.color.ink : theme.color.surface,
          border: `1px solid ${checked ? theme.color.ink : theme.color.border}`,
          color: theme.color.surface,
          flexShrink: 0,
        }}
      >
        {checked ? <CheckCircle2 size={16} /> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
      />
      <span style={{ fontSize: theme.type.size.base, color: theme.color.ink }}>{label}</span>
    </label>
  );
}
