import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Checkbox } from '../Checkbox/Checkbox.tsx';
import { Input } from '../Input/Input.tsx';
import { StatusPill } from '../StatusPill/StatusPill.tsx';
import { SignaturePad, svgFromPath } from '../SignaturePad/SignaturePad.tsx';
import { theme } from '../../theme/index.ts';
import {
  signWaiver,
  type WaiverSection,
} from '../../lib/queries/waiver.ts';

// Walks the receptionist (or patient on the kiosk) through each section
// the visit requires, one section at a time. Earlier-signed sections
// flash the green tick and skip ahead.
//
// Output: one row per section in lng_waiver_signatures, immutable. The
// sheet does not mutate parent state — the caller passes onSigned() to
// refresh whatever surfaces depend on the patient's waiver state
// (banner clears, visit page shows "Signed", etc).

const PAD_WIDTH = 600;
const PAD_HEIGHT = 180;

export interface WaiverSheetProps {
  open: boolean;
  onClose: () => void;
  patientId: string | null;
  visitId: string | null;
  // Sections to walk through. Caller has already filtered to "missing or
  // stale" — sections already at current version aren't included.
  sections: WaiverSection[];
  // Patient name for the header copy. Helps the witnessing receptionist
  // confirm they have the right person on the pad.
  patientName: string;
  // Pre-filled "Witnessed by" — the staff member viewing the sheet.
  // Editable in case a colleague is the actual witness on the day.
  // Mirrors the Arrival flow's WaiverInline so the audit row stamps a
  // real human-meaningful witness, not just the signed-in account FK.
  defaultWitnessName: string;
  onAllSigned: () => void;
}

export function WaiverSheet({
  open,
  onClose,
  patientId,
  visitId,
  sections,
  patientName,
  defaultWitnessName,
  onAllSigned,
}: WaiverSheetProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track signed sections in this session so we can show the green ticks
  // in the progress strip as the receptionist works through them.
  const [signedKeys, setSignedKeys] = useState<Set<string>>(new Set());
  // Reset the pad between sections by remounting it with a fresh key.
  const [padKey, setPadKey] = useState(0);
  // Witness + receptionist confirmation. Persists across the
  // section-by-section walk — the same staff member witnesses every
  // section in one sitting, so we don't reset between steps.
  const [witness, setWitness] = useState(defaultWitnessName);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (open) {
      setStepIndex(0);
      setPath('');
      setBusy(false);
      setError(null);
      setSignedKeys(new Set());
      setPadKey((k) => k + 1);
      setWitness(defaultWitnessName);
      setConfirmed(false);
    }
  }, [open, defaultWitnessName]);

  const currentSection = sections[stepIndex];
  const isLast = stepIndex === sections.length - 1;
  const empty = path.trim().length === 0;
  const witnessReady = witness.trim().length > 0;
  const ready = !empty && confirmed && witnessReady && !busy;

  const headerCopy = useMemo(() => {
    if (!currentSection) return { title: 'Waiver', sub: '' };
    const ordinal = `${stepIndex + 1} of ${sections.length}`;
    return {
      title: currentSection.title,
      sub: `Section ${ordinal} for ${patientName}`,
    };
  }, [currentSection, patientName, sections.length, stepIndex]);

  if (!currentSection) {
    // Defensive: parent should not open the sheet with zero sections, but
    // if it does, render nothing rather than crash.
    return null;
  }

  const submit = async () => {
    if (!patientId || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const svg = svgFromPath(path, PAD_WIDTH, PAD_HEIGHT);
      await signWaiver({
        patient_id: patientId,
        visit_id: visitId,
        section: currentSection,
        signature_svg: svg,
        witness_name: witness.trim(),
      });
      const nextSigned = new Set(signedKeys);
      nextSigned.add(currentSection.key);
      setSignedKeys(nextSigned);
      if (isLast) {
        onAllSigned();
        onClose();
      } else {
        setStepIndex(stepIndex + 1);
        setPath('');
        setPadKey((k) => k + 1);
        // Witness + confirmation persist into the next section — the
        // receptionist already attested they're witnessing this
        // sitting, no reason to make them re-tick for every section.
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save signature');
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={headerCopy.title}
      description={headerCopy.sub}
      footer={
        <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
          <Button variant="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!ready} showArrow={!isLast}>
            {busy ? 'Saving…' : isLast ? 'Sign and finish' : 'Sign and continue'}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <ProgressStrip
          sections={sections}
          stepIndex={stepIndex}
          signedKeys={signedKeys}
        />

        <Terms section={currentSection} />

        <div>
          <p
            style={{
              margin: `0 0 ${theme.space[2]}px`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
            }}
          >
            By signing below, the patient agrees to the terms above. Version
            {' '}
            <span style={{ fontVariantNumeric: 'tabular-nums', color: theme.color.ink }}>
              {currentSection.version}
            </span>
            .
          </p>
          <SignaturePad
            key={padKey}
            width={PAD_WIDTH}
            height={PAD_HEIGHT}
            ariaLabel={`Signature for ${currentSection.title}`}
            onChange={(d) => setPath(d)}
          />
        </div>

        <Input
          label="Witnessed by"
          value={witness}
          onChange={(e) => setWitness(e.currentTarget.value)}
          disabled={busy}
        />

        <div
          style={{
            padding: theme.space[3],
            borderRadius: theme.radius.input,
            border: `1px solid ${confirmed ? theme.color.ink : theme.color.border}`,
            background: theme.color.surface,
          }}
        >
          <Checkbox
            checked={confirmed}
            onChange={setConfirmed}
            label="I confirm the customer has read and signed the waiver"
            disabled={busy}
          />
        </div>

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
      </div>
    </BottomSheet>
  );
}

function Terms({ section }: { section: WaiverSection }) {
  return (
    <div
      style={{
        padding: theme.space[4],
        borderRadius: theme.radius.card,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.bg,
      }}
    >
      <ul
        style={{
          margin: 0,
          paddingLeft: theme.space[5],
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[3],
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
          lineHeight: 1.55,
        }}
      >
        {section.terms.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

function ProgressStrip({
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
        return (
          <StatusPill
            key={s.key}
            tone={isSigned ? 'arrived' : isCurrent ? 'in_progress' : 'neutral'}
            size="sm"
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {isSigned ? <CheckCircle2 size={12} /> : null}
              {s.title}
            </span>
          </StatusPill>
        );
      })}
    </div>
  );
}
