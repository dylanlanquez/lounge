import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Checkbox } from '../Checkbox/Checkbox.tsx';
import { Input } from '../Input/Input.tsx';
import { SignaturePad, svgFromPath } from '../SignaturePad/SignaturePad.tsx';
import { theme } from '../../theme/index.ts';
import { signWaiver, type WaiverSection } from '../../lib/queries/waiver.ts';

// Inline variant of the waiver flow used by the arrival wizard's step 3.
//
// Combined-sign model: every section that applies to the visit is shown
// on one page as a numbered list of terms. The patient signs once; the
// component writes a row per section to lng_waiver_signatures so the
// audit log still records each agreement individually with its own
// version snapshot.
//
// The CTA does NOT live inline. Arrival owns the persistent footer
// (ActionBar) and drives the submit through this component's
// imperative handle, so the screen has a single primary action
// instead of one button inside the page and another in the footer.
//
// WaiverSheet (the modal version on the visit page) is left untouched.

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
  // Reactive readiness flag — Arrival mirrors this into ActionBar's
  // disabled state so the footer "Sign and continue" button enables
  // the moment the patient has drawn a signature, ticked the
  // confirmation, and a witness name is present.
  onReadyChange?: (ready: boolean) => void;
  // Surfaces busy state for the footer's loading indicator.
  onBusyChange?: (busy: boolean) => void;
}

export interface WaiverInlineHandle {
  submit: () => Promise<void>;
}

export const WaiverInline = forwardRef<WaiverInlineHandle, WaiverInlineProps>(
  function WaiverInline(
    {
      patientId,
      visitId,
      sections,
      patientName,
      defaultWitnessName,
      onAllSigned,
      onReadyChange,
      onBusyChange,
    },
    ref
  ) {
    const [path, setPath] = useState('');
    const [witness, setWitness] = useState(defaultWitnessName);
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [padKey, setPadKey] = useState(0);

    const empty = path.trim().length === 0;

    // Reset transient state whenever the parent feeds in a new sections
    // list (e.g. the patient just changed their mind on which line items
    // they're agreeing to and re-rendered the consent step).
    useEffect(() => {
      setPath('');
      setConfirmed(false);
      setPadKey((k) => k + 1);
    }, [sections]);

    const ready = !empty && confirmed && !busy && witness.trim().length > 0;

    useEffect(() => {
      onReadyChange?.(ready);
    }, [ready, onReadyChange]);

    useEffect(() => {
      onBusyChange?.(busy);
    }, [busy, onBusyChange]);

    const submit = async () => {
      if (!patientId || !ready || sections.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        const svg = svgFromPath(path, PAD_WIDTH, PAD_HEIGHT);
        // Write one signature row per section so each agreement keeps
        // its own version snapshot in the audit log. Sequential rather
        // than parallel: simpler error semantics, and the count of
        // sections is small (1–3 in practice).
        for (const section of sections) {
          await signWaiver({
            patient_id: patientId,
            visit_id: visitId,
            section,
            signature_svg: svg,
          });
        }
        onAllSigned();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Could not save signature');
      } finally {
        setBusy(false);
      }
    };

    useImperativeHandle(ref, () => ({ submit }), [submit]);

    if (sections.length === 0) {
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

    const headerTitle =
      sections.length === 1 ? sections[0]!.title : 'Consent and waivers';

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
            {headerTitle}
          </h2>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.base,
            }}
          >
            Customer reads and signs once for everything below.
          </p>
        </header>

        <div
          style={{
            padding: `${theme.space[5]}px ${theme.space[6]}px`,
            borderRadius: theme.radius.card,
            border: `1px solid ${theme.color.border}`,
            background: theme.color.surface,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[5],
          }}
        >
          <p
            style={{
              margin: 0,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
            }}
          >
            By signing below, {patientName} acknowledges and agrees to the
            following:
          </p>
          {sections.map((section, index) => (
            <SectionBlock
              key={section.key}
              section={section}
              showHeading={sections.length > 1}
              index={index}
            />
          ))}
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
            ariaLabel="Customer signature"
            onChange={(d) => setPath(d)}
          />
          <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
            One signature covers every section above.
          </p>
        </div>

        <Input
          label="Witnessed by"
          value={witness}
          onChange={(e) => setWitness(e.currentTarget.value)}
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
    );
  }
);

function SectionBlock({
  section,
  showHeading,
  index,
}: {
  section: WaiverSection;
  showHeading: boolean;
  index: number;
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      {showHeading ? (
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          {index + 1}. {section.title}
        </h3>
      ) : null}
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
        {section.terms.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ol>
      <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
        Version {section.version}.
      </p>
    </section>
  );
}

