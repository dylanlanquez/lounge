import { useNavigate } from 'react-router-dom';
import { CalendarCheck, CheckCircle2, Wallet } from 'lucide-react';
import { Button } from '../Button/Button.tsx';
import { theme } from '../../theme/index.ts';
import { useCurrentAccount } from '../../lib/queries/currentAccount.tsx';
import { type CashCountDue, useCashCountDue } from '../../lib/queries/cashCounts.ts';
import { fmtTzAbbr } from '../../lib/dateFormat.ts';

// The cash-count reminder on the home screen (Schedule).
//
// Shown to the person responsible for the count (the rota's assignee,
// or whoever is covering) and to the super admin. Three states, so a
// rota day is never silent:
//   * due today   — from the start of the due day until a count is signed.
//   * overdue     — a due day was missed; stays up until a count is signed.
//   * done today  — a count was signed today; says who, when, and when
//                   the next one is.
// Derived from the rota and the signed counts on every render: there
// is no dismiss, the only way through is doing the count.

function formatDueDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function formatSignedTime(iso: string): string {
  const stamp = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  return `${stamp} ${fmtTzAbbr(iso)}`;
}

export function CashCountDueBanner() {
  const navigate = useNavigate();
  const { account } = useCurrentAccount();
  const { data } = useCashCountDue();
  if (!account || !data) return null;

  if (data.due_date) {
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

  if (data.today_is_rota_day && data.done_today) {
    // Today was a rota day and the count is signed. Tell the people who
    // would otherwise be wondering: the person on the rota (today's
    // and the next one) and the super admin.
    const involved =
      account.is_super_admin
      || data.next_responsible_account_id === account.account_id
      || !!account.can_count_cash;
    if (!involved) return null;
    return <CashCountDoneView data={data} onOpen={() => navigate('/cash-counts')} />;
  }
  return null;
}

// The visual part, kept free of hooks so it can be rendered with fixed
// data (previews, tests).
export function CashCountDueBannerView({
  data,
  mine,
  canCount,
  onCount,
}: {
  data: { due_date: string; today: string | null; overdue: boolean; responsible_name: string | null; is_cover: boolean };
  mine: boolean;
  canCount: boolean;
  onCount: () => void;
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
    <BannerFrame
      colour={colour}
      background={background}
      icon={data.overdue ? <Wallet size={18} aria-hidden /> : <CalendarCheck size={18} aria-hidden />}
      title={title}
      body={body}
      action={
        canCount ? (
          <Button variant="primary" onClick={onCount}>
            Count cash now
          </Button>
        ) : null
      }
    />
  );
}

export function CashCountDoneView({ data, onOpen }: { data: CashCountDue; onOpen: () => void }) {
  const done = data.done_today!;
  const by = done.counted_by_name ?? 'the safe holder';
  const witness = done.witness_name ? `, witnessed by ${done.witness_name}` : '';
  const next = data.next_due_date
    ? ` Next count ${formatDueDate(data.next_due_date)}${data.next_responsible_name ? `, ${data.next_responsible_name}${data.next_is_cover ? ' covering' : ''}` : ''}.`
    : '';
  return (
    <BannerFrame
      colour={theme.color.accent}
      background={theme.color.surface}
      icon={<CheckCircle2 size={18} aria-hidden />}
      title="Cash count done today"
      body={`Signed at ${formatSignedTime(done.signed_at)} by ${by}${witness}.${next}`}
      action={
        <Button variant="secondary" onClick={onOpen}>
          Open cash counts
        </Button>
      }
    />
  );
}

function BannerFrame({
  colour,
  background,
  icon,
  title,
  body,
  action,
}: {
  colour: string;
  background: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  action: React.ReactNode;
}) {
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
            background: background === theme.color.surface ? theme.color.accentBg : theme.color.surface,
            color: colour,
            flexShrink: 0,
          }}
        >
          {icon}
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
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>{action}</div>
    </div>
  );
}
