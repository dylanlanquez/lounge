import { useEffect, useRef } from 'react';
import { Camera, MapPin, Megaphone, ShieldCheck, Sparkles } from 'lucide-react';
import {
  type WalkthroughTour,
  useWalkthrough,
} from '../../components/Walkthrough/Walkthrough.tsx';
import { useCurrentAccount } from '../queries/currentAccount.tsx';

// Bump the version to re-show the tour to everyone after a big change.
const MARKETING_WALKTHROUGH_KEY = 'marketing_intro_v1';

export const MARKETING_WALKTHROUGH: WalkthroughTour = {
  key: MARKETING_WALKTHROUGH_KEY,
  finishRoute: '/schedule',
  steps: [
    {
      eyebrow: 'Marketing drive',
      icon: <Megaphone size={18} />,
      title: 'We need marketing content',
      body: "Right now we have none. Nothing for Instagram, nothing for Facebook, nothing for the website. Every great before and after, and every happy patient with their new smile, is something we can post. This quick guide shows you how to capture it.",
    },
    {
      eyebrow: 'Where it lives',
      icon: <MapPin size={18} />,
      title: 'The megaphone, top right',
      body: "This button sits at the top of every screen. It opens Marketing content, where every photo the team captures gathers together, grouped by appointment, ready to post.",
      target: '[data-tour="nav-marketing"]',
    },
    {
      eyebrow: 'How to capture it',
      icon: <Camera size={18} />,
      title: 'Add it on the visit',
      body: "Once a patient is marked as arrived, open their visit and scroll to Marketing content. Tap Add photo to add the finished result, the branded bag, and the patient's new smile.",
      route: '/marketing/demo',
      target: '[data-tour="visit-add-marketing"]',
    },
    {
      eyebrow: 'Always ask first',
      icon: <ShieldCheck size={18} />,
      title: 'Get the patient’s permission',
      body: "Before anything goes up, ask the patient if they are happy for us to share their photos on social media, Instagram, Facebook and the rest. Only add it to Marketing content once they have said yes.",
      route: '/marketing/demo',
    },
    {
      eyebrow: 'You’re done',
      icon: <Sparkles size={18} />,
      title: 'Then it’s ready to use',
      body: "Once added, the photo shows up in Marketing content up top and on the patient’s profile, so the team can grab it any time. That is everything, thank you for helping us build our content.",
      route: '/marketing/demo',
    },
  ],
};

// ── Per-account "seen" flag (localStorage) ──────────────────────────

function seenKey(accountId: string): string {
  return `lng.walkthrough.${MARKETING_WALKTHROUGH_KEY}.seen.${accountId}`;
}

export function hasSeenMarketingWalkthrough(accountId: string): boolean {
  try {
    return localStorage.getItem(seenKey(accountId)) === 'true';
  } catch {
    return false;
  }
}

export function markMarketingWalkthroughSeen(accountId: string): void {
  try {
    localStorage.setItem(seenKey(accountId), 'true');
  } catch {
    // Private mode / quota — the tour simply auto-shows again next time.
  }
}

// Auto-launches the tour once per staff member on their first load after
// it ships. Mounted at the app root so it can run from wherever the user
// lands. The Schedule reminder is the ongoing way to replay it.
export function MarketingWalkthroughAutoStart() {
  const { start } = useWalkthrough();
  const { account } = useCurrentAccount();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    if (!account) return;
    const accountId = account.account_id;
    if (hasSeenMarketingWalkthrough(accountId)) return;
    fired.current = true;
    start(MARKETING_WALKTHROUGH, {
      onClose: () => markMarketingWalkthroughSeen(accountId),
    });
  }, [account, start]);

  return null;
}
