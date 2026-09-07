import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarCheck, Wallet } from 'lucide-react';
import { Button } from '../Button/Button.tsx';
import { theme } from '../../theme/index.ts';
import { useCurrentAccount } from '../../lib/queries/currentAccount.tsx';
import { useCashCountDue } from '../../lib/queries/cashCounts.ts';

// The cash-count reminder on the home screen (Schedule).
//
// Shown to the person responsible for today's count (the rota's
// assignee, or whoever is covering), and to the super admin, from the
// start of the due day until a count is signed. It is derived from the
// rota and the signed counts every time it renders, so there is no
// dismiss: the only way it goes away is doing the count. A missed day
// stays on screen marked overdue.

function formatDueDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

// Super admin only: "show me how it looks" from the rota card. Session
// storage, so it clears when the tab is closed and never reaches
// anyone else's screen.
export const CASH_COUNT_DUE_PREVIEW_KEY = 'lng.cashCountDuePreview';

export function readDuePreview(): 'due' | 'overdue' | null {
  try {
    const v = sessionStorage.getItem(CASH_COUNT_DUE_PREVIEW_KEY);
    return v === 'due' || v === 'overdue' ? v : null;
  } catch {
    return null;
  }
}

export function CashCountDueBanner() {
  const navigate = useNavigate();
  const { account } = useCurrentAccount();
  const { data } = useCashCountDue();
  const [preview, setPreview] = useState<'due' | 'overdue' | null>(() => readDuePreview());
  if (!account) return null;

  if (preview && account.is_super_admin) {
    const today = localDateIso(new Date());
    const dueDate = preview === 'overdue' ? shiftDays(today, -3) : today;
    return (
      <CashCountDueBannerView
        data={{ due_date: dueDate, today, overdue: preview === 'overdue', responsible_name: account.display_name, is_cover: false }}
        mine
        canCount
        onCount={() => navigate('/cash-counts')}
        preview={{
          onToggle: () => {
            const next = preview === 'due' ? 'overdue' : 'due';
            try {
              sessionStorage.setItem(CASH_COUNT_DUE_PREVIEW_KEY, next);
            } catch {
              // Session storage unavailable: the toggle simply does not persist.
            }
            setPreview(next);
          },
          onStop: () => {
            try {
              sessionStorage.removeItem(CASH_COUNT_DUE_PREVIEW_KEY);
            } catch {
              // Nothing stored to remove.
            }
            setPreview(null);
          },
        }}
      />
    );
  }

  if (!data || !data.due_date) return null;
  const mine = data.responsible_account_id === account.account_id;
  if (!mine && !account.is_super_admin) return null;
  return (
    <CashCountDueBannerView
      data={{ ...data, due_date: data.due_date }}
      mine={mine}
      canCount={!!account.can_count_cash}
      onCount={() => navigate('/cash-counts')}
    />
  );
}

function localDateIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localDateIso(d);
}

// The visual part, kept free of hooks so it can be rendered with fixed
// data (previews, tests).
export function CashCountDueBannerView({
  data,
  mine,
  canCount,
  onCount,
  preview,
}: {
  data: { due_date: string; today: string | null; overdue: boolean; responsible_name: string | null; is_cover: boolean };
  mine: boolean;
  canCount: boolean;
  onCount: () => void;
  /** Present when the super admin is previewing: adds the Preview tag
   *  and the controls to switch state or stop. */
  preview?: { onToggle: () => void; onStop: () => void };
}) {
  const isToday = data.due_date === data.today;
  const who = data.responsible_name ?? 'the safe holder';
  const title = data.overdue
    ? `Cash count overdue since ${formatDueDate(data.due_date)}`
    : 'Cash count due today';
  const body = mine
    ? `${isToday ? "It's your day to count the safe" : 'Your count was not done'}${data.is_cover ? ' (you are covering)' : ''}. Two people, on camera. This stays here until the count is signed.`
    : `${who} is down to count the safe${data.is_cover ? ' (covering)' : ''}${data.overdue ? ' and has not yet' : ''}. This stays on their home screen until a count is signed.`;
  const colour = data.overdue ? theme.color.alert : theme.color.accent;
  const background = data.overdue ? '#FFEEEC' : theme.color.accentBg;

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[4],
        flexWrap: 'wrap',
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        background,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        marginBottom: theme.space[5],
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4], flex: '1 1 320px', minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 40,
            height: 40,
            borderRadius: theme.radius.pill,
            background: theme.color.surface,
            color: colour,
            flexShrink: 0,
          }}
        >
          {data.overdue ? <Wallet size={18} aria-hidden /> : <CalendarCheck size={18} aria-hidden />}
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span
            style={{
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: colour,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            {title}
          </span>
          <span style={{ fontSize: theme.type.size.sm, color: theme.color.ink, lineHeight: theme.type.leading.snug }}>{body}</span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
        {preview ? (
          <>
            <span
              style={{
                fontSize: theme.type.size.xs,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.inkMuted,
                background: theme.color.surface,
                border: `1px solid ${theme.color.border}`,
                padding: `2px ${theme.space[2]}px`,
                borderRadius: theme.radius.pill,
              }}
            >
              Preview
            </span>
            <Button variant="tertiary" size="sm" onClick={preview.onToggle}>
              {data.overdue ? 'Show as due today' : 'Show as missed'}
            </Button>
            <Button variant="tertiary" size="sm" onClick={preview.onStop}>
              Stop preview
            </Button>
          </>
        ) : null}
        {canCount ? (
          <Button variant="primary" onClick={onCount}>
            Count cash now
          </Button>
        ) : null}
      </div>
    </div>
  );
}
