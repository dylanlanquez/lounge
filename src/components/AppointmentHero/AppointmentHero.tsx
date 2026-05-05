import { type ReactNode } from 'react';
import { CalendarClock } from 'lucide-react';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Card } from '../Card/Card.tsx';
import { StatusPill, type StatusTone } from '../StatusPill/StatusPill.tsx';
import { theme } from '../../theme/index.ts';

// AppointmentHero — the unified card that opens both AppointmentDetail
// and VisitDetail. Two zones inside one card:
//
//   • Identity row at the top (avatar · name · pills · trailing slot)
//     plus an optional compact subtitle for source / refs / arrival
//     type / staff. Subtitle is a ReactNode so callers can compose
//     mixed content if they want.
//
//   • Tinted "When" ribbon at the bottom carrying the date / time /
//     relative state / service. Tone drives the tint:
//        accent  — upcoming, arrived, in-chair (live)
//        neutral — complete (done)
//        warn    — terminated soft (no-show, unsuitable, ended early)
//        alert   — terminated hard (cancelled)
//
// Both pages render the exact same shape so receptionists scanning
// either surface get the same affordances in the same places. Adding
// a new appointment-like surface = wire it through this component;
// the visual language doesn't drift.

export type AppointmentHeroTone = 'accent' | 'neutral' | 'warn' | 'alert';

export interface AppointmentHeroPill {
  tone: StatusTone;
  label: string;
}

export interface AppointmentHeroWhen {
  /** "Monday 8th June 2026" — already humanised by the caller. */
  dateLong: string;
  /** "09:00 — 09:45" or "Walked in 09:43" — the time anchor. */
  timeLine: string;
  /** Optional relative phrase next to the time anchor: "In 5 days" /
   * "Arrived 23 minutes ago" / "Ready to finish". */
  relative?: string | null;
  /** Optional service / event-type label below the date row. */
  service?: string | null;
  /** Drives the ribbon tint. */
  tone: AppointmentHeroTone;
  /** Override the leading ribbon icon. Default is CalendarClock — used
   * by callers whose ribbon is communicating a non-time fact (e.g. a
   * paid visit ribbon should lead with a settled-receipt mark, not a
   * calendar). The icon should be sized to render at 16px. */
  icon?: ReactNode;
}

export interface AppointmentHeroProps {
  patient: {
    name: string;
    avatarSrc?: string | null;
  };
  /** Status pills shown next to the name. Visit pages render two
   * (visit status + cart status); appointment pages render one. */
  pills: AppointmentHeroPill[];
  /** Compact line under the name. Refs, source, arrival type, staff. */
  subtitle?: ReactNode;
  /** Date / time / service / relative-state ribbon. */
  when: AppointmentHeroWhen;
  /** Optional trailing slot in the identity row — used by visit pages
   * to surface a "View profile" affordance. */
  trailing?: ReactNode;
}

export function AppointmentHero({
  patient,
  pills,
  subtitle,
  when,
  trailing,
}: AppointmentHeroProps) {
  const ribbonBg = ribbonBackground(when.tone);
  const ribbonAccent = ribbonAccentColor(when.tone);

  return (
    // overflow:hidden so the tinted "When" ribbon's background is
    // clipped to the card's rounded corners. Without it, the ribbon's
    // bottom corners render square and bleed past the card's curve.
    <Card padding="none" elevation="raised" style={{ overflow: 'hidden' }}>
      {/* Identity row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[4],
          padding: `${theme.space[5]}px ${theme.space[5]}px`,
          minWidth: 0,
        }}
      >
        <Avatar name={patient.name} src={patient.avatarSrc} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: theme.space[3],
              flexWrap: 'wrap',
            }}
          >
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.xl,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                letterSpacing: theme.type.tracking.tight,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                lineHeight: 1.15,
              }}
            >
              {patient.name}
            </p>
            {pills.map((p, i) => (
              <StatusPill key={`${p.tone}|${p.label}|${i}`} tone={p.tone} size="sm">
                {p.label}
              </StatusPill>
            ))}
          </div>
          {subtitle ? (
            <div
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                fontVariantNumeric: 'tabular-nums',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {subtitle}
            </div>
          ) : null}
        </div>
        {trailing ? <div style={{ flexShrink: 0 }}>{trailing}</div> : null}
      </div>

      {/* "When" ribbon */}
      <div
        style={{
          padding: `${theme.space[4]}px ${theme.space[5]}px ${theme.space[5]}px`,
          background: ribbonBg,
          borderTop: `1px solid ${theme.color.border}`,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[2],
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[2],
            flexWrap: 'wrap',
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
              background: theme.color.surface,
              border: `1px solid ${theme.color.border}`,
              color: ribbonAccent,
              flexShrink: 0,
            }}
          >
            {when.icon ?? <CalendarClock size={16} aria-hidden />}
          </span>
          <div style={{ minWidth: 0 }}>
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.lg,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                letterSpacing: theme.type.tracking.tight,
                lineHeight: 1.2,
              }}
            >
              {when.dateLong}
            </p>
            <p
              style={{
                margin: '2px 0 0',
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {when.timeLine}
              {when.relative ? (
                <>
                  <span style={{ color: theme.color.inkSubtle }}>{' · '}</span>
                  <span style={{ color: ribbonAccent, fontWeight: theme.type.weight.semibold }}>
                    {when.relative}
                  </span>
                </>
              ) : null}
            </p>
          </div>
        </div>
        {when.service ? (
          <p
            style={{
              margin: 0,
              paddingLeft: 44,
              fontSize: theme.type.size.sm,
              color: theme.color.ink,
              fontWeight: theme.type.weight.medium,
            }}
          >
            {when.service}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function ribbonBackground(tone: AppointmentHeroTone): string {
  switch (tone) {
    case 'accent':
      return theme.color.accentBg;
    case 'warn':
      return 'rgba(179, 104, 21, 0.10)';
    case 'alert':
      return 'rgba(184, 58, 42, 0.08)';
    case 'neutral':
      return theme.color.bg;
  }
}

function ribbonAccentColor(tone: AppointmentHeroTone): string {
  switch (tone) {
    case 'accent':
      return theme.color.accent;
    case 'warn':
      return theme.color.warn;
    case 'alert':
      return theme.color.alert;
    case 'neutral':
      return theme.color.inkMuted;
  }
}
