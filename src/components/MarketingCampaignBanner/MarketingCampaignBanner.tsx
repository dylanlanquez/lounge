import { Megaphone } from 'lucide-react';
import { Button } from '../Button/Button.tsx';
import { theme } from '../../theme/index.ts';
import { useIsMobile } from '../../lib/useIsMobile.ts';
import { useWalkthrough } from '../Walkthrough/Walkthrough.tsx';
import { useCurrentAccount } from '../../lib/queries/currentAccount.tsx';
import {
  MARKETING_WALKTHROUGH,
  markMarketingWalkthroughSeen,
} from '../../lib/walkthroughs/marketingWalkthrough.tsx';

// A slim, always-on reminder that sits on the Schedule for the duration
// of the marketing content drive. One row, quiet accent wash, with a
// button to replay the walkthrough. Deliberately small so it nudges
// without crowding the day's schedule.
export function MarketingCampaignBanner() {
  const isMobile = useIsMobile(640);
  const { start } = useWalkthrough();
  const { account } = useCurrentAccount();

  const launch = () => {
    start(MARKETING_WALKTHROUGH, {
      onClose: () => {
        if (account) markMarketingWalkthroughSeen(account.account_id);
      },
    });
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        flexWrap: 'wrap',
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        background: theme.color.accentBg,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        marginBottom: theme.space[5],
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], minWidth: 0 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: theme.radius.pill,
            background: theme.color.surface,
            color: theme.color.accent,
            flexShrink: 0,
          }}
        >
          <Megaphone size={18} />
        </span>
        <div style={{ minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
            }}
          >
            We’re collecting marketing content
          </p>
          {!isMobile && (
            <p style={{ margin: '2px 0 0', fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              We have none yet. Capture before, after, and finished-result photos at every visit.
            </p>
          )}
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={launch}>
        Show me how
      </Button>
    </div>
  );
}
