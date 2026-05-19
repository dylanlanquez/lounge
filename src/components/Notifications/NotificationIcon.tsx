import {
  CalendarPlus2,
  CalendarClock,
  CalendarX2,
  Ban,
  RotateCcw,
  UserX,
  UserCheck,
  Undo2,
} from 'lucide-react';
import { theme } from '../../theme/index.ts';
import type { NotificationEventType } from '../../lib/queries/notifications.ts';

// Type → icon + tone mapping. Tones use the existing palette tokens
// (accent / category / alert / warn) so a notification icon reads
// as part of the same design system as the rest of the app:
//
//   • appointment_booked       — green CalendarPlus2  (something joined)
//   • appointment_rescheduled  — muted graphite Clock (neutral move)
//   • appointment_cancelled    — alert-red CalendarX2 (something left)
//   • visit_ended_early        — amber/warn Ban       (clinical halt)
//
// The icon background is a 12% tint of the foreground for low-
// contrast separation against the row's near-white fill — same
// pattern as the avatar palette in theme.ts.

interface NotificationIconProps {
  type: NotificationEventType;
  size?: number;
}

interface IconSpec {
  Icon: typeof CalendarPlus2;
  fg: string;
  bg: string;
}

const SPEC_BY_TYPE: Record<NotificationEventType, IconSpec> = {
  appointment_booked: {
    Icon: CalendarPlus2,
    fg: theme.color.accent,
    bg: 'rgba(31, 77, 58, 0.10)',
  },
  appointment_rescheduled: {
    Icon: CalendarClock,
    fg: theme.category.consult,
    bg: 'rgba(74, 79, 85, 0.10)',
  },
  appointment_cancelled: {
    Icon: CalendarX2,
    fg: theme.color.alert,
    bg: 'rgba(184, 58, 42, 0.10)',
  },
  visit_ended_early: {
    Icon: Ban,
    fg: theme.color.warn,
    bg: 'rgba(179, 104, 21, 0.10)',
  },
  // Reversal events use the accent green and a Rotate icon — these
  // are positive corrections (something was un-done) so they sit
  // alongside "booked" tonally rather than alert / warn.
  patient_unsuitable_reversed: {
    Icon: RotateCcw,
    fg: theme.color.accent,
    bg: 'rgba(31, 77, 58, 0.10)',
  },
  no_show: {
    Icon: UserX,
    fg: theme.color.alert,
    bg: 'rgba(184, 58, 42, 0.10)',
  },
  no_show_reversed: {
    Icon: UserCheck,
    fg: theme.color.accent,
    bg: 'rgba(31, 77, 58, 0.10)',
  },
  // Refund-issued sits in the alert-red family — money has moved
  // back to the patient, which is a state staff must notice (it
  // affects cash reconciliation + receipts). Undo2 reads more as
  // "money returned" than the generic Rotate.
  refund_issued: {
    Icon: Undo2,
    fg: theme.color.alert,
    bg: 'rgba(184, 58, 42, 0.10)',
  },
};

export function NotificationIcon({ type, size = 18 }: NotificationIconProps) {
  const spec = SPEC_BY_TYPE[type];
  // Outer wrapper is a circle 1.6× the icon size — gives the icon
  // breathing room without the chip feeling oversized.
  const wrap = Math.round(size * 1.7);
  return (
    <span
      style={{
        width: wrap,
        height: wrap,
        borderRadius: theme.radius.pill,
        background: spec.bg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
      aria-hidden
    >
      <spec.Icon size={size} color={spec.fg} strokeWidth={2} />
    </span>
  );
}
