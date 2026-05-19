import { useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, CheckCircle2, Loader2, UsersRound } from 'lucide-react';
import { Card, Checkbox } from '../index.ts';
import { theme } from '../../theme/index.ts';
import {
  setManagerRecipients,
  useManagerRecipients,
  type ManagerRecipientOption,
} from '../../lib/queries/managerNotifications.ts';

// Recipients card for the Manager notifications group.
//
// Renders a checklist of every active manager (lng_staff_members where
// is_manager = true). Ticking or un-ticking a row writes the new
// selection to lng_settings under
// `manager_notifications.recipient_account_ids`, debounced so a quick
// sequence of clicks fires one network call.
//
// Visual treatment matches the rest of the Admin → Emails surface:
// a Card containing a heading + sub-line, then a divided list of
// manager rows. A small status indicator on the top-right shows
// "Saving…" or "Saved" feedback so an admin sees the write succeed
// without a full toast — the surface is editable inline.

export function ManagerNotificationRecipientsCard({
  onToast,
}: {
  onToast: (t: { tone: 'success' | 'error' | 'info'; title: string; description?: string }) => void;
}) {
  const { options, loading, error, refresh } = useManagerRecipients();
  const [pending, setPending] = useState<Set<string> | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const debounceRef = useRef<number | null>(null);
  const lastSavedRef = useRef<number>(0);

  // Local mirror of the source selection so the row reflects the
  // pending state immediately (the network round-trip lands a moment
  // later). `pending` is null until the admin's first tick, then
  // tracks the in-flight selection.
  const effectiveSelected = useMemo<Set<string>>(() => {
    if (pending) return pending;
    return new Set(options.filter((o) => o.selected).map((o) => o.accountId));
  }, [pending, options]);

  // Reset pending when the source list refreshes (e.g. after a save).
  useEffect(() => {
    if (saveState === 'saving') return;
    setPending(null);
  }, [options, saveState]);

  // Reset the "Saved" pill back to idle after a moment so it
  // disappears once the admin's eye has caught it.
  useEffect(() => {
    if (saveState !== 'saved') return;
    const t = window.setTimeout(() => setSaveState('idle'), 1800);
    return () => window.clearTimeout(t);
  }, [saveState]);

  const persist = (next: Set<string>) => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    setSaveState('saving');
    debounceRef.current = window.setTimeout(async () => {
      try {
        const stamp = Date.now();
        lastSavedRef.current = stamp;
        await setManagerRecipients(Array.from(next));
        // Guard against an older save resolving after a newer one.
        if (lastSavedRef.current !== stamp) return;
        setSaveState('saved');
        // Refresh the source so the next render reads the persisted
        // truth, not just the local mirror.
        refresh();
      } catch (e) {
        setSaveState('idle');
        onToast({
          tone: 'error',
          title: 'Could not save recipients',
          description: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }, 350);
  };

  const toggle = (accountId: string) => {
    const next = new Set(effectiveSelected);
    if (next.has(accountId)) next.delete(accountId);
    else next.add(accountId);
    setPending(next);
    persist(next);
  };

  return (
    <Card padding="none">
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: theme.space[3],
          padding: `${theme.space[4]}px ${theme.space[5]}px`,
          borderBottom: `1px solid ${theme.color.border}`,
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: theme.radius.pill,
            background: theme.color.accentBg,
            color: theme.color.accent,
            flexShrink: 0,
          }}
        >
          <BellRing size={16} aria-hidden />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            Recipients
          </p>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: theme.type.leading.snug,
            }}
          >
            Tick every manager who should receive a notification email when a cashier applies a
            discount, issues a refund, or voids a payment. Only active managers appear here.
          </p>
        </div>
        <SaveStatus state={saveState} />
      </header>

      {loading ? (
        <RowSkeleton />
      ) : error ? (
        <p
          style={{
            margin: 0,
            padding: `${theme.space[4]}px ${theme.space[5]}px`,
            color: theme.color.alert,
            fontSize: theme.type.size.sm,
          }}
        >
          Couldn't load managers: {error}
        </p>
      ) : options.length === 0 ? (
        <EmptyState />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {options.map((opt, idx) => (
            <RecipientRow
              key={opt.accountId}
              option={opt}
              isFirst={idx === 0}
              checked={effectiveSelected.has(opt.accountId)}
              onToggle={() => toggle(opt.accountId)}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecipientRow({
  option,
  isFirst,
  checked,
  onToggle,
}: {
  option: ManagerRecipientOption;
  isFirst: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li
      style={{
        borderTop: isFirst ? 'none' : `1px solid ${theme.color.border}`,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          appearance: 'none',
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: `${theme.space[4]}px ${theme.space[5]}px`,
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          fontFamily: 'inherit',
          cursor: 'pointer',
          textAlign: 'left',
          transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = theme.color.bg;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <Checkbox checked={checked} onChange={onToggle} ariaLabel={`Notify ${option.name}`} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            {option.name}
          </p>
          <p
            style={{
              margin: '2px 0 0',
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {option.email}
          </p>
        </div>
      </button>
    </li>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
        padding: `${theme.space[5]}px ${theme.space[5]}px`,
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          borderRadius: theme.radius.pill,
          background: theme.color.bg,
          color: theme.color.inkMuted,
          border: `1px solid ${theme.color.border}`,
          flexShrink: 0,
        }}
      >
        <UsersRound size={16} aria-hidden />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          No active managers yet
        </p>
        <p
          style={{
            margin: '2px 0 0',
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          Flag a staff member as a manager in Admin, Staff to start sending notifications.
        </p>
      </div>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        gap: theme.space[3],
      }}
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            height: 22,
            borderRadius: 6,
            background: theme.color.bg,
            opacity: 1 - i * 0.2,
          }}
        />
      ))}
    </div>
  );
}

function SaveStatus({ state }: { state: 'idle' | 'saving' | 'saved' }) {
  if (state === 'idle') return null;
  const isSaving = state === 'saving';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[1],
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.medium,
        color: isSaving ? theme.color.inkMuted : theme.color.accent,
        flexShrink: 0,
        marginTop: 2,
      }}
    >
      {isSaving ? (
        <Loader2
          size={12}
          aria-hidden
          style={{
            animation: 'lng-spin 800ms linear infinite',
          }}
        />
      ) : (
        <CheckCircle2 size={12} aria-hidden />
      )}
      {isSaving ? 'Saving' : 'Saved'}
      <style>{`@keyframes lng-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}
