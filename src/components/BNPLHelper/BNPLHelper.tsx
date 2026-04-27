import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, HelpCircle } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { TerminalPaymentModal } from '../TerminalPaymentModal/TerminalPaymentModal.tsx';
import { theme } from '../../theme/index.ts';
import { useBnplScripts } from '../../lib/queries/bnplSettings.ts';
import { formatPence } from '../../lib/queries/carts.ts';

export type BnplProvider = 'klarna' | 'clearpay';

export interface BNPLHelperProps {
  open: boolean;
  onClose: () => void;
  provider: BnplProvider;
  visitId: string;
  cartId: string;
  amountPence: number;
  readerId: string;
  readerName: string;
  onSucceeded: (paymentId: string) => void;
}

type Stage = 'preflight' | 'no-app' | 'steps' | 'terminal' | 'success' | 'failed';

export function BNPLHelper({
  open,
  onClose,
  provider,
  visitId,
  cartId,
  amountPence,
  readerId,
  readerName,
  onSucceeded,
}: BNPLHelperProps) {
  const [stage, setStage] = useState<Stage>('preflight');
  const [stepIndex, setStepIndex] = useState(0);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const { data: scripts, loading } = useBnplScripts();

  const config = provider === 'klarna' ? scripts.klarna : scripts.clearpay;
  const providerLabel = provider === 'klarna' ? 'Klarna' : 'Clearpay';

  const onTerminalSucceeded = (pid: string) => {
    setTerminalOpen(false);
    setStage('success');
    onSucceeded(pid);
  };

  // Reset on open
  const reset = () => {
    setStage('preflight');
    setStepIndex(0);
    setTerminalOpen(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  return (
    <>
      <BottomSheet
        open={open && !terminalOpen}
        onClose={close}
        title={`${providerLabel} · ${formatPence(amountPence)}`}
        description={
          stage === 'preflight'
            ? 'Walk the customer through.'
            : stage === 'no-app'
              ? 'They need a couple of minutes.'
              : stage === 'steps'
                ? `Step ${stepIndex + 1} of ${config.steps.length}`
                : stage === 'success'
                  ? 'Done.'
                  : ''
        }
        dismissable={stage === 'preflight' || stage === 'no-app' || stage === 'success' || stage === 'failed'}
      >
        {loading ? (
          <Skeleton height={120} />
        ) : stage === 'preflight' ? (
          <PreflightStage
            text={config.preflight?.text ?? `Does the customer already have the ${providerLabel} app and Apple Pay or Google Pay set up?`}
            yesLabel={config.preflight?.yes_label ?? 'Yes'}
            noLabel={config.preflight?.no_label ?? 'No'}
            onYes={() => {
              setStage('steps');
              setStepIndex(0);
            }}
            onNo={() => setStage('no-app')}
            onSwitchToCard={close}
          />
        ) : stage === 'no-app' ? (
          <NoAppStage
            followup={
              config.preflight?.no_followup ??
              'They need to download the app and register first. Takes 2 to 3 minutes including a quick eligibility check the app does itself. If they cannot or will not wait, offer card or cash instead.'
            }
            onWait={() => {
              setStage('steps');
              setStepIndex(0);
            }}
            onSwitchToCard={close}
          />
        ) : stage === 'steps' ? (
          <StepsStage
            steps={config.steps}
            index={stepIndex}
            onPrev={() => setStepIndex(Math.max(0, stepIndex - 1))}
            onNext={() => {
              if (stepIndex >= config.steps.length - 1) {
                setTerminalOpen(true);
              } else {
                setStepIndex(stepIndex + 1);
              }
            }}
            onSwitchToCard={close}
          />
        ) : stage === 'success' ? (
          <SuccessStage providerLabel={providerLabel} amountPence={amountPence} onClose={close} />
        ) : (
          <FailedStage
            providerLabel={providerLabel}
            troubleshoot={config.troubleshoot}
            onRetry={() => {
              setStage('steps');
              setStepIndex(0);
            }}
            onSwitchToCard={close}
          />
        )}

        <div style={{ marginTop: theme.space[6] }}>
          <CollapsiblePanel icon={<AlertTriangle size={16} />} title="If something goes wrong">
            {config.troubleshoot.length === 0 ? (
              <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
                No troubleshooting entries seeded. Edit `lng_settings.bnpl.{provider}.troubleshoot` in Supabase Studio.
              </p>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
                {config.troubleshoot.map((row, i) => (
                  <li key={i}>
                    <p style={{ margin: 0, fontWeight: theme.type.weight.semibold, fontSize: theme.type.size.sm }}>
                      {row.row}
                    </p>
                    <p style={{ margin: `${theme.space[1]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
                      {row.says}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CollapsiblePanel>

          <CollapsiblePanel icon={<HelpCircle size={16} />} title="If the customer asks">
            {config.faq.length === 0 ? (
              <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
                No FAQ seeded.
              </p>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
                {config.faq.map((row, i) => (
                  <li key={i}>
                    <p style={{ margin: 0, fontWeight: theme.type.weight.semibold, fontSize: theme.type.size.sm }}>
                      {row.q}
                    </p>
                    <p style={{ margin: `${theme.space[1]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
                      {row.a}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CollapsiblePanel>
        </div>

        {scripts.neverSay.length > 0 ? (
          <div
            style={{
              marginTop: theme.space[5],
              padding: theme.space[4],
              background: theme.color.bg,
              borderRadius: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[2],
            }}
          >
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.xs,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.alert,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
              }}
            >
              What I cannot say
            </p>
            <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
              {scripts.neverSay.map((s, i) => (
                <span
                  key={i}
                  style={{
                    fontSize: theme.type.size.xs,
                    padding: `${theme.space[1]}px ${theme.space[2]}px`,
                    background: theme.color.surface,
                    border: `1px solid ${theme.color.border}`,
                    borderRadius: theme.radius.pill,
                    color: theme.color.ink,
                  }}
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </BottomSheet>

      <TerminalPaymentModal
        open={terminalOpen}
        onClose={() => {
          setTerminalOpen(false);
          if (stage !== 'success') setStage('failed');
        }}
        visitId={visitId}
        cartId={cartId}
        amountPence={amountPence}
        readerId={readerId}
        readerName={readerName}
        paymentJourney={provider}
        onSucceeded={onTerminalSucceeded}
      />
    </>
  );
}

// ---------- stages ----------

function PreflightStage({
  text,
  yesLabel,
  noLabel,
  onYes,
  onNo,
  onSwitchToCard,
}: {
  text: string;
  yesLabel: string;
  noLabel: string;
  onYes: () => void;
  onNo: () => void;
  onSwitchToCard: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Card padding="lg" elevation="flat" style={{ background: theme.color.accentBg }}>
        <p style={{ margin: 0, fontSize: theme.type.size.md, color: theme.color.ink, fontWeight: theme.type.weight.medium }}>
          {text}
        </p>
      </Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        <Button variant="primary" size="lg" fullWidth onClick={onYes}>
          {yesLabel}
        </Button>
        <Button variant="secondary" size="lg" fullWidth onClick={onNo}>
          {noLabel}
        </Button>
        <Button variant="tertiary" onClick={onSwitchToCard}>
          Switch to card or cash
        </Button>
      </div>
    </div>
  );
}

function NoAppStage({
  followup,
  onWait,
  onSwitchToCard,
}: {
  followup: string;
  onWait: () => void;
  onSwitchToCard: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <p style={{ margin: 0, color: theme.color.ink, fontSize: theme.type.size.md }}>{followup}</p>
      <div style={{ display: 'flex', gap: theme.space[3] }}>
        <Button variant="secondary" onClick={onSwitchToCard}>
          Switch to card
        </Button>
        <Button variant="primary" showArrow onClick={onWait} fullWidth>
          They will wait
        </Button>
      </div>
    </div>
  );
}

function StepsStage({
  steps,
  index,
  onPrev,
  onNext,
  onSwitchToCard,
}: {
  steps: { id: number; text: string }[];
  index: number;
  onPrev: () => void;
  onNext: () => void;
  onSwitchToCard: () => void;
}) {
  if (steps.length === 0) {
    return (
      <p style={{ margin: 0, color: theme.color.alert }}>
        {'No steps configured. Edit `lng_settings.bnpl.<provider>.steps` in Supabase Studio.'}
      </p>
    );
  }
  const step = steps[index]!;
  const isLast = index === steps.length - 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <div style={{ display: 'flex', gap: theme.space[1] }}>
        {steps.map((_, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: i <= index ? theme.color.accent : theme.color.border,
            }}
          />
        ))}
      </div>
      <Card padding="lg">
        <p style={{ margin: 0, fontSize: theme.type.size.md, color: theme.color.ink, lineHeight: theme.type.leading.relaxed }}>
          {step.text}
        </p>
      </Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: theme.space[3] }}>
        <Button variant="tertiary" onClick={index === 0 ? onSwitchToCard : onPrev}>
          {index === 0 ? 'Switch to card' : 'Back'}
        </Button>
        <Button variant="primary" showArrow={!isLast} onClick={onNext}>
          {isLast ? `Send ${formatPence(0)} to reader`.replace('£0.00', 'to reader') : 'Done'}
        </Button>
      </div>
    </div>
  );
}

function SuccessStage({
  providerLabel,
  amountPence,
  onClose,
}: {
  providerLabel: string;
  amountPence: number;
  onClose: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Card padding="lg" elevation="flat" style={{ background: theme.color.accentBg }}>
        <p style={{ margin: 0, fontSize: theme.type.size.md, color: theme.color.ink, fontWeight: theme.type.weight.semibold }}>
          {formatPence(amountPence)} paid via {providerLabel}.
        </p>
        <p style={{ margin: `${theme.space[2]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          Receipt printed will say <strong>Visa contactless</strong>. That is correct.
        </p>
      </Card>
      <Button variant="primary" size="lg" fullWidth onClick={onClose} showArrow>
        Done
      </Button>
    </div>
  );
}

function FailedStage({
  providerLabel,
  troubleshoot,
  onRetry,
  onSwitchToCard,
}: {
  providerLabel: string;
  troubleshoot: { row: string; says: string }[];
  onRetry: () => void;
  onSwitchToCard: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Card padding="lg" elevation="flat" style={{ background: theme.color.bg }}>
        <p style={{ margin: 0, color: theme.color.ink, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
          {providerLabel} payment did not go through.
        </p>
        <p style={{ margin: `${theme.space[2]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          Use the troubleshooting panel below. Common: ask them to reopen the app and check the pre-auth amount or card limit matches the total.
        </p>
      </Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: theme.space[3] }}>
        <Button variant="secondary" onClick={onSwitchToCard}>
          Switch to card or cash
        </Button>
        <Button variant="primary" onClick={onRetry}>
          Try again
        </Button>
      </div>
      {troubleshoot.length > 0 ? (
        <p style={{ margin: 0, color: theme.color.inkSubtle, fontSize: theme.type.size.xs }}>
          {troubleshoot.length} troubleshooting tip{troubleshoot.length === 1 ? '' : 's'} below.
        </p>
      ) : null}
    </div>
  );
}

function CollapsiblePanel({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        borderTop: `1px solid ${theme.color.border}`,
        paddingTop: theme.space[3],
        marginTop: theme.space[3],
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          padding: `${theme.space[2]}px 0`,
          cursor: 'pointer',
          color: theme.color.ink,
          fontFamily: 'inherit',
          fontWeight: theme.type.weight.semibold,
          fontSize: theme.type.size.sm,
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[2],
          width: '100%',
          textAlign: 'left',
        }}
      >
        <span style={{ display: 'inline-flex', color: theme.color.inkMuted }}>{icon}</span>
        <span style={{ flex: 1 }}>{title}</span>
        {open ? <ChevronUp size={16} style={{ color: theme.color.inkMuted }} /> : <ChevronDown size={16} style={{ color: theme.color.inkMuted }} />}
      </button>
      {open ? <div style={{ paddingTop: theme.space[2], paddingBottom: theme.space[3] }}>{children}</div> : null}
    </div>
  );
}
