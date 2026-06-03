import { describe, expect, it } from 'vitest';
import { deriveVerdict, type GroupedParticipant } from './MeetAttendanceCard.tsx';

// deriveVerdict is the anti-fibbing core of the Meeting attendance card:
// given the grouped participants + who the patient is, it answers "did the
// people actually meet?". The subtle rule under test here is that a
// NON-HOST participant only counts as the patient when their Meet display
// name plausibly matches the patient on file. A spectating staff member
// (Heidi A. on Lee Wadsworth's call) must NOT flip the verdict to a false
// "Both attended" — see the 2026-06-03 report.

function participant(over: Partial<GroupedParticipant>): GroupedParticipant {
  return {
    key: over.key ?? over.displayName ?? 'p',
    displayName: over.displayName ?? 'Guest',
    isHost: over.isHost ?? false,
    sessionCount: over.sessionCount ?? 1,
    totalSeconds: over.totalSeconds ?? 600,
    firstJoinedAt: over.firstJoinedAt ?? '2026-06-03T07:49:00Z',
    lastLeftAt: over.lastLeftAt ?? '2026-06-03T08:04:00Z',
    stillIn: over.stillIn ?? false,
    sessions: over.sessions ?? [],
  };
}

const host = participant({ displayName: 'Karly Innes', isHost: true });
// Any non-empty evidence so we reach the final-verdict branches rather
// than the pending / never-opened gate.
const ENDED = { rows: [{}] as never[], conferenceStartedAt: '2026-06-03T07:38:00Z', meetingHasEnded: true };

describe('deriveVerdict patient identity', () => {
  it('does NOT call it "Both attended" when the only non-host name does not match the patient (Heidi A. case)', () => {
    const v = deriveVerdict({
      ...ENDED,
      grouped: [host, participant({ displayName: 'Heidi A.' })],
      patientFirstName: 'Lee',
      patientLastName: 'Wadsworth',
    });
    expect(v.kind).toBe('host_unconfirmed');
    expect(v.tone).toBe('warn');
    expect(v.detail).toContain('Lee Wadsworth');
  });

  it('says "Both attended" when a non-host name matches the patient', () => {
    const v = deriveVerdict({
      ...ENDED,
      grouped: [host, participant({ displayName: 'Lee Wadsworth' })],
      patientFirstName: 'Lee',
      patientLastName: 'Wadsworth',
    });
    expect(v.kind).toBe('both');
  });

  it('matches loosely on a shared name token (first name only)', () => {
    const v = deriveVerdict({
      ...ENDED,
      grouped: [host, participant({ displayName: 'Lee on iPhone' })],
      patientFirstName: 'Lee',
      patientLastName: 'Wadsworth',
    });
    expect(v.kind).toBe('both');
  });

  it('treats a missing patient name as un-doubtable (counts the non-host as patient)', () => {
    const v = deriveVerdict({
      ...ENDED,
      grouped: [host, participant({ displayName: 'Heidi A.' })],
      patientFirstName: null,
      patientLastName: null,
    });
    expect(v.kind).toBe('both');
  });

  it('reports only_host when the host is the sole participant', () => {
    const v = deriveVerdict({
      ...ENDED,
      grouped: [host],
      patientFirstName: 'Lee',
      patientLastName: 'Wadsworth',
    });
    expect(v.kind).toBe('only_host');
  });

  it('reports unconfirmed_only when a non-matching person joins with no host on record', () => {
    const v = deriveVerdict({
      ...ENDED,
      grouped: [participant({ displayName: 'Heidi A.' })],
      patientFirstName: 'Lee',
      patientLastName: 'Wadsworth',
    });
    expect(v.kind).toBe('unconfirmed_only');
  });

  it('mid-meeting: a non-matching non-host does not read as "both connected"', () => {
    const v = deriveVerdict({
      rows: [{}] as never[],
      conferenceStartedAt: '2026-06-03T07:49:00Z',
      meetingHasEnded: false,
      grouped: [host, participant({ displayName: 'Heidi A.', stillIn: true, lastLeftAt: null })],
      patientFirstName: 'Lee',
      patientLastName: 'Wadsworth',
    });
    expect(v.kind).toBe('in_progress_host');
  });
});
