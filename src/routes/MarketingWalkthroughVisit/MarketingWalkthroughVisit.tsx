import { type ReactNode } from 'react';
import { Camera, Megaphone, Sparkles, User } from 'lucide-react';
import { Card } from '../../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../../theme/index.ts';
import { useIsMobile } from '../../lib/useIsMobile.ts';

// A static, example visit used only by the marketing walkthrough so staff
// can be shown the "Add photo" step on a real-looking page without
// touching a real patient. Not linked anywhere in the app; reachable only
// via the tour at /marketing/demo.

function SectionHeader({
  icon,
  title,
  count,
}: {
  icon: ReactNode;
  title: string;
  count: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        paddingBottom: theme.space[3],
        borderBottom: `1px solid ${theme.color.border}`,
        marginBottom: theme.space[4],
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
        <span
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
          {icon}
        </span>
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
          }}
        >
          {title}
        </h2>
      </div>
      <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>{count}</span>
    </div>
  );
}

function AddPhotoTile({ tourId }: { tourId?: string }) {
  return (
    <div
      data-tour={tourId}
      style={{
        width: 184,
        aspectRatio: '1 / 1',
        borderRadius: theme.radius.card,
        border: `1.5px dashed ${theme.color.border}`,
        background: theme.color.surface,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space[2],
        color: theme.color.inkMuted,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 44,
          height: 44,
          borderRadius: theme.radius.pill,
          background: theme.color.bg,
        }}
      >
        <Camera size={20} />
      </span>
      <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold }}>
        Add photo
      </span>
    </div>
  );
}

export function MarketingWalkthroughVisit() {
  const isMobile = useIsMobile(640);

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: isMobile ? theme.space[4] : theme.space[6],
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + ${
          isMobile ? theme.space[4] : theme.space[6]
        }px + env(safe-area-inset-top, 0px))`,
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${
          isMobile ? theme.space[6] : theme.space[8]
        }px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div
        style={{
          maxWidth: theme.layout.pageMaxWidth,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[5],
        }}
      >
        {/* Quiet banner so it's clear this is an example, not a real patient. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[2],
            padding: `${theme.space[2]}px ${theme.space[3]}px`,
            background: theme.color.accentBg,
            color: theme.color.accent,
            borderRadius: theme.radius.pill,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.medium,
            alignSelf: 'flex-start',
          }}
        >
          <Megaphone size={15} /> Example visit, for the walkthrough only
        </div>

        {/* Patient header, like a real visit. */}
        <Card padding="lg">
          <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 48,
                height: 48,
                borderRadius: theme.radius.pill,
                background: theme.color.bg,
                color: theme.color.inkMuted,
                flexShrink: 0,
              }}
            >
              <User size={22} />
            </span>
            <div>
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.lg,
                  fontWeight: theme.type.weight.semibold,
                  letterSpacing: theme.type.tracking.tight,
                  color: theme.color.ink,
                }}
              >
                Example Patient
              </p>
              <p style={{ margin: '2px 0 0', fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
                Same-day Click-in Veneers · Arrived
              </p>
            </div>
          </div>
        </Card>

        {/* Before & after card. */}
        <Card padding="lg">
          <SectionHeader icon={<Sparkles size={18} />} title="Before & after" count="0 photos" />
          <p style={{ margin: `0 0 ${theme.space[4]}px`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
            Snap a before photo at arrival and an after photo at collection.
          </p>
          <AddPhotoTile />
        </Card>

        {/* Marketing content card — the whole section is the spotlight target. */}
        <Card padding="lg" data-tour="visit-add-marketing">
          <SectionHeader icon={<Megaphone size={18} />} title="Marketing content" count="0 photos" />
          <p style={{ margin: `0 0 ${theme.space[4]}px`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
            Photos with the finished appliance, branded bag, and patient (when consented). Used by
            the marketing team.
          </p>
          <AddPhotoTile />
        </Card>
      </div>
    </main>
  );
}
