import { BellRing } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { useResolvedManagerRecipients } from '../../lib/queries/managerNotifications.ts';

// ManagerNotificationNotice
//
// Sits inside the Apply Discount / Refund / Void sheets in place of
// the old "Approving manager" dropdown. Tells the cashier exactly
// who'll get an email about the action they're about to take, with
// a deep link into Admin → Emails so the configured list can be
// changed if needed.
//
// Three render states, all visually consistent (same card chrome,
// same icon, same height heuristics) so the sheet doesn't reflow as
// the recipient list loads.
//
//   loading           — skeleton headline, no body
//   no recipients     — soft amber callout telling staff to configure
//                       a recipient in Admin before this action
//                       quietly stops emitting notifications
//   has recipients    — headline + comma-separated names + email
//                       count, plus the Admin link

export function ManagerNotificationNotice() {
  const { recipients, loading } = useResolvedManagerRecipients();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
        padding: theme.space[4],
        borderRadius: theme.radius.input,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.bg,
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          borderRadius: theme.radius.pill,
          background: recipients.length > 0 ? theme.color.accentBg : theme.color.surface,
          color: recipients.length > 0 ? theme.color.accent : theme.color.inkMuted,
          border: recipients.length > 0 ? 'none' : `1px solid ${theme.color.border}`,
          flexShrink: 0,
        }}
      >
        <BellRing size={16} aria-hidden />
      </span>

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
          {loading
            ? 'Checking who will be notified'
            : recipients.length === 0
              ? 'No managers will be notified yet'
              : recipients.length === 1 && recipients[0]
                ? `${recipients[0].name} will be notified`
                : `${recipients.length} managers will be notified`}
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          {loading
            ? 'Loading the configured recipient list.'
            : recipients.length === 0
              ? 'Add a recipient in Admin, Emails, Manager notifications. Until then this action goes through without sending an email.'
              : 'They will get an email from manager@notifications.venneir.com with a summary of what was processed.'}
        </p>
        {!loading && recipients.length > 0 ? (
          <ul
            style={{
              listStyle: 'none',
              margin: `${theme.space[2]}px 0 0`,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {recipients.map((r) => (
              <li
                key={r.accountId}
                style={{
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                  fontVariantNumeric: 'tabular-nums',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ color: theme.color.ink, fontWeight: theme.type.weight.medium }}>
                  {r.name}
                </span>{' '}
                {r.email}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
