import { type ReactNode } from 'react';
import { Camera, ChevronRight, Megaphone, Sparkles } from 'lucide-react';
import { Card } from '../../components/index.ts';
import { Breadcrumb } from '../../components/Breadcrumb/Breadcrumb.tsx';
import {
  AppointmentHero,
  type AppointmentHeroPill,
} from '../../components/AppointmentHero/AppointmentHero.tsx';
import { BOTTOM_NAV_HEIGHT } from '../../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../../theme/index.ts';
import { useIsMobile } from '../../lib/useIsMobile.ts';

// A static, example visit used only by the marketing walkthrough so staff
// can be shown the "Add photo" step on a page that looks exactly like the
// real in-clinic visit they land on after a patient is booked in. It
// reuses the real Breadcrumb + AppointmentHero so the context (who, when,
// what was booked) is unmistakable, then carries the Before & after and
// Marketing content sections the tour points at. Not linked anywhere in
// the app; reachable only via the tour at /marketing/demo. No real patient
// is touched — every value here is illustrative.

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

// A trimmed, static cart card — just enough to make the page read as a
// real booked-in visit ("Same-day Click-in Veneers in the basket").
function ExampleCart() {
  return (
    <Card padding="lg">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: theme.space[4],
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
          }}
        >
          Cart
        </h2>
        <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium, color: theme.color.inkMuted }}>
          Add item
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
        <span
          style={{
            width: 48,
            height: 48,
            borderRadius: theme.radius.card,
            background: theme.color.bg,
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
            Click-in Veneers
          </p>
          <p style={{ margin: '2px 0 0', fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
            Upper and lower · £599.00 each
          </p>
        </div>
        <span style={{ fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
          £599.00
        </span>
      </div>
    </Card>
  );
}

export function MarketingWalkthroughVisit() {
  const isMobile = useIsMobile(640);
  // Today's date, so the example always reads as current.
  const dateLong = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/London',
  }).format(new Date());

  const pills: AppointmentHeroPill[] = [
    { tone: 'arrived', label: 'Arrived' },
    { tone: 'neutral', label: 'Cart open' },
  ];

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

        {/* Breadcrumb + hero + cart mirror the real in-clinic visit page so
            staff recognise exactly where they are once a patient is booked
            in: this is the page you open from In clinic. */}
        <Breadcrumb
          items={[{ label: 'In clinic' }, { label: 'Example Patient’s appointment' }]}
        />

        <AppointmentHero
          patient={{ name: 'Example Patient' }}
          pills={pills}
          subtitle={
            <span style={{ color: theme.color.inkMuted }}>
              MP-100482 · LAP-00231 · EP128 · Scheduled
            </span>
          }
          trailing={
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
                color: theme.color.ink,
                whiteSpace: 'nowrap',
              }}
            >
              View profile <ChevronRight size={16} />
            </span>
          }
          when={{
            dateLong,
            timeLine: <span>Booked for 09:45 BST · Arrived 09:50 BST</span>,
            secondary: (
              <span style={{ color: theme.color.accent, fontWeight: theme.type.weight.medium }}>
                Estimated appointment length →
              </span>
            ),
            service: 'Same-day Click-in Veneers',
            tone: 'accent',
          }}
        />

        <ExampleCart />

        {/* Both photo sections sit inside one spotlight target — before
            and after shots are marketing content too, so the tour lights
            up both at once. */}
        <div
          data-tour="visit-add-marketing"
          style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}
        >
          <Card padding="lg">
            <SectionHeader icon={<Sparkles size={18} />} title="Before & after" count="0 photos" />
            <p style={{ margin: `0 0 ${theme.space[4]}px`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              Snap a before photo at arrival and an after photo at collection.
            </p>
            <AddPhotoTile />
          </Card>

          {/* Marketing content card. */}
          <Card padding="lg">
            <SectionHeader icon={<Megaphone size={18} />} title="Marketing content" count="0 photos" />
            <p style={{ margin: `0 0 ${theme.space[4]}px`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              Photos with the finished appliance, branded bag, and patient (when consented). Used by
              the marketing team.
            </p>
            <AddPhotoTile />
          </Card>
        </div>
      </div>
    </main>
  );
}
