import { Headset, Monitor } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { theme } from '../../theme/index.ts';

// MeetingJoinBlockSheet
//
// Single bottom-sheet surface used by both the Join meeting and
// Rejoin meeting buttons on AppointmentDetail when the staff
// member can't actually run the call from their current context.
//
// Two reasons cover every block today:
//
//   * 'device' — the viewport / pointer doesn't read as a laptop or
//     desktop (useIsDesktop returns false). Tablet and mobile
//     browsers can't reliably handle the in-clinic Google Meet
//     session (camera framing, sharing the screen, switching audio
//     to the booth mics), so the action is blocked with a clear
//     "open on a laptop / desktop" prompt rather than letting the
//     tap silently produce a degraded call.
//
//   * 'role' — the signed-in account is a Customer-Service-only
//     staff member. CS handles patient comms (reschedule, cancel,
//     resend); the clinical floor team runs the video session.
//     The block reads as a role-permission message rather than a
//     device prompt so the staff member knows it's not about WHAT
//     they're using but WHAT they're allowed to do.
//
// Both variants share the same chrome (icon hero + headline + sub
// copy + single "Got it" footer action). Copy is the only thing
// that changes — the visual rhythm is the same so staff sees the
// surface twice and recognises it on the second encounter.

export type MeetingJoinBlockReason = 'device' | 'role';

export interface MeetingJoinBlockSheetProps {
  open: boolean;
  reason: MeetingJoinBlockReason;
  /** Action the staff member tried to take. Used to swap "Join"
   *  for "Rejoin" in the copy so the message matches the button
   *  they tapped. */
  action: 'join' | 'rejoin';
  onClose: () => void;
}

export function MeetingJoinBlockSheet({
  open,
  reason,
  action,
  onClose,
}: MeetingJoinBlockSheetProps) {
  const verb = action === 'rejoin' ? 'rejoin' : 'join';
  const verbCapitalised = action === 'rejoin' ? 'Rejoin' : 'Join';
  const isDevice = reason === 'device';
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={
        isDevice
          ? `${verbCapitalised} from a laptop or desktop`
          : 'Customer Service cannot run meetings'
      }
      description={
        isDevice
          ? `Virtual impression appointments need a full keyboard, camera, and screen-sharing. ${verbCapitalised} the meeting from a laptop or desktop, not from this tablet.`
          : `Customer Service is not set up to ${verb} virtual meetings. A clinician or manager handles the call; you can still help with reschedules, cancellations, and resending the confirmation.`
      }
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="primary" onClick={onClose}>
            Got it
          </Button>
        </div>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: theme.space[4],
          padding: `${theme.space[5]}px ${theme.space[4]}px ${theme.space[2]}px`,
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 72,
            height: 72,
            borderRadius: theme.radius.pill,
            background: theme.color.accentBg,
            color: theme.color.accent,
            flexShrink: 0,
          }}
        >
          {isDevice ? <Monitor size={32} aria-hidden /> : <Headset size={32} aria-hidden />}
        </span>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[2],
            textAlign: 'center',
            maxWidth: 420,
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            {isDevice
              ? 'This screen is too small for the call'
              : `Your role does not include ${verb}ing meetings`}
          </p>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: theme.type.leading.normal,
            }}
          >
            {isDevice
              ? `Open the appointment in Lounge on a laptop or desktop with a mouse or trackpad. The ${verbCapitalised} meeting button there opens Google Meet directly so the patient sees you full-screen.`
              : `Ask a clinician or manager on the floor to ${verb} the call from their station. If you think this should be part of your role, talk to an admin and they will adjust your permissions.`}
          </p>
        </div>
      </div>
    </BottomSheet>
  );
}
