import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, Loader2, RefreshCw, ShieldCheck, TriangleAlert, Users, Video } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { Card } from '../Card/Card.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { Toast } from '../Toast/Toast.tsx';
import {
  fetchMeetAttendance,
  type MeetAttendanceRow,
  useMeetAttendance,
} from '../../lib/queries/meetHosts.ts';

// Renders the Google Meet attendance summary for a virtual appointment.
// The card's job is to make staff-vs-patient attendance disputes
// falsifiable from Google's data: who joined, when, for how long, and
// what staff TAPS the app recorded against that. Anti-fibbing surface,
// not a generic activity feed.
//
// Sources of truth:
//   • lng_meet_attendance      — Google's per-session records (pulled
//                                from conferenceRecords + participants)
//   • lng_appointments         — conference_started_at /
//                                conference_ended_at, captured at the
//                                same time. Smoking-gun for "did the
//                                conference open at all".
//   • patient_events           — virtual_meeting_joined /
//                                virtual_meeting_rejoined, written when
//                                staff taps Join / Rejoin in the app.
//                                The audit overlay below lists these.
//
// Auto-fetch: AppointmentDetail invokes meet-fetch-attendance on load
// when the meeting has ended and we have no rows yet. The Refresh
// button still works for manual re-pulls (e.g. someone left late and
// the timing matters).

export interface MeetAttendanceCardProps {
  appointmentId: string;
  meetMeetingCode: string | null;
  meetingHasEnded: boolean;
  conferenceStartedAt: string | null;
  conferenceEndedAt: string | null;
  // Number of distinct conferences logged for this space — > 1 when
  // the same Meet link has been rejoined outside its original window.
  // The card renders "(N conferences)" alongside the window line.
  conferenceCount: number | null;
  // Corroborating evidence pulled by meet-fetch-attendance. Counts are
  // the count of Google-published artefacts (non-zero = unfakeable
  // proof the meeting happened). RSVP is the patient's responseStatus
  // on the underlying Calendar invite — shows whether they ever opened
  // the email at all.
  recordingCount: number | null;
  transcriptCount: number | null;
  patientRsvpStatus: 'accepted' | 'declined' | 'tentative' | 'needsAction' | null;
  patientRsvpUpdatedAt: string | null;
  // The patient's email on file. Surfaced inline on the invite row so
  // operators can tell at a glance which inbox we tracked — important
  // because Google's Meet API doesn't publish the email a participant
  // used to join (only their display name). If the patient joined from
  // a different Google account than the one we have, the only visible
  // signal is the display name in the participants list.
  patientEmail: string | null;
  // The patient's name on file. Used to flag non-host participants
  // whose Meet display name doesn't roughly match (different Google
  // account, anonymous join, or some other identity-confusion case).
  // Both fields may be null — the matcher tolerates either.
  patientFirstName: string | null;
  patientLastName: string | null;
}

export function MeetAttendanceCard({
  appointmentId,
  meetMeetingCode,
  meetingHasEnded,
  conferenceStartedAt,
  conferenceEndedAt,
  conferenceCount,
  recordingCount,
  transcriptCount,
  patientRsvpStatus,
  patientRsvpUpdatedAt: _patientRsvpUpdatedAt,
  patientEmail,
  patientFirstName,
  patientLastName,
}: MeetAttendanceCardProps) {
  const { rows, loading, error, refresh } = useMeetAttendance(appointmentId);
  const [pulling, setPulling] = useState(false);
  const [toast, setToast] = useState<
    | { tone: 'success' | 'error'; title: string; description?: string }
    | null
  >(null);

  const onRefresh = async () => {
    setPulling(true);
    try {
      const result = await fetchMeetAttendance(appointmentId);
      if (result.ok) {
        if (result.waitingForMeeting) {
          setToast({
            tone: 'success',
            title: 'No attendance yet',
            description:
              'Google publishes attendance once the meeting ends. Try again after the appointment finishes.',
          });
        } else {
          setToast({
            tone: 'success',
            title: result.upserts === 1 ? '1 participant updated' : `${result.upserts ?? 0} participants updated`,
          });
        }
        refresh();
      } else {
        setToast({
          tone: 'error',
          title: 'Could not refresh attendance',
          description: result.error ?? undefined,
        });
      }
    } catch (e) {
      setToast({
        tone: 'error',
        title: 'Could not refresh attendance',
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setPulling(false);
    }
  };

  const grouped = useMemo(() => groupByPerson(rows), [rows]);
  const verdict = useMemo(
    () => deriveVerdict({ rows, grouped, conferenceStartedAt, meetingHasEnded }),
    [rows, grouped, conferenceStartedAt, meetingHasEnded],
  );

  return (
    <>
      <style>{`@keyframes lng-meet-spin { to { transform: rotate(360deg); } }`}</style>
      <Card padding="lg">
        <Header
          meetingCode={meetMeetingCode}
          peopleCount={grouped.length}
          sessionCount={rows.length}
          loading={loading}
          pulling={pulling}
          onRefresh={onRefresh}
        />
        <div
          style={{
            height: 1,
            background: theme.color.border,
            margin: `${theme.space[4]}px 0 ${theme.space[5]}px`,
          }}
        />
        <VerdictBanner verdict={verdict} />
        <MetadataList
          startedAt={conferenceStartedAt}
          endedAt={conferenceEndedAt}
          conferenceCount={conferenceCount}
          recordingCount={recordingCount}
          transcriptCount={transcriptCount}
          patientRsvpStatus={patientRsvpStatus}
          patientEmail={patientEmail}
          meetingHasEnded={meetingHasEnded}
        />
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            <Skeleton height={48} radius={12} />
            <Skeleton height={48} radius={12} />
          </div>
        ) : error ? (
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert }}>
            Could not load attendance: {error}
          </p>
        ) : grouped.length === 0 ? null : (
          <>
            <SectionLabel>Participants</SectionLabel>
            <ParticipantList
              grouped={grouped}
              patientFirstName={patientFirstName}
              patientLastName={patientLastName}
            />
          </>
        )}
        <FooterHint />
      </Card>
      {toast ? (
        <Toast
          tone={toast.tone}
          title={toast.title}
          description={toast.description}
          duration={4000}
          onDismiss={() => setToast(null)}
        />
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Verdict — single-sentence answer to "did the people meet?"
// ─────────────────────────────────────────────────────────────────────

type VerdictKind =
  | 'pending'
  | 'never_opened'
  | 'only_host'
  | 'only_patient'
  | 'both';

interface Verdict {
  kind: VerdictKind;
  title: string;
  detail: string;
  tone: 'success' | 'warn' | 'alert' | 'muted';
}

function deriveVerdict(args: {
  rows: MeetAttendanceRow[];
  grouped: GroupedParticipant[];
  conferenceStartedAt: string | null;
  meetingHasEnded: boolean;
}): Verdict {
  const { rows, grouped, conferenceStartedAt, meetingHasEnded } = args;

  // Before the meeting ends Google publishes nothing, so anything we'd
  // say would be speculative. Be honest: we're waiting on Google. The
  // longer "how Google publishes attendance" explanation lives in the
  // card's footer hint — keep the verdict detail to one short line so
  // the card is scannable.
  if (!meetingHasEnded) {
    return {
      kind: 'pending',
      title: 'Awaiting Google publication',
      detail: 'Verdict populates once the Meet room closes.',
      tone: 'muted',
    };
  }

  // Meeting is over but Google has no conference record AND we have no
  // session rows — the conference never opened. Hardest possible
  // evidence that no one connected.
  if (!conferenceStartedAt && rows.length === 0) {
    return {
      kind: 'never_opened',
      title: 'Nobody joined',
      detail: 'Google has no record of the conference starting.',
      tone: 'alert',
    };
  }

  const hostJoined = grouped.some((p) => p.isHost && p.totalSeconds > 0);
  const patientJoined = grouped.some((p) => !p.isHost && p.totalSeconds > 0);

  if (hostJoined && patientJoined) {
    return {
      kind: 'both',
      title: 'Both attended',
      detail: 'Host and patient both connected.',
      tone: 'success',
    };
  }
  if (hostJoined && !patientJoined) {
    return {
      kind: 'only_host',
      title: 'Patient did not join',
      detail: 'Host has a recorded session; patient has none.',
      tone: 'warn',
    };
  }
  if (!hostJoined && patientJoined) {
    return {
      kind: 'only_patient',
      title: 'Host did not join',
      detail: 'Patient has a recorded session; host has none.',
      tone: 'alert',
    };
  }
  // Fallback: rows exist but nobody had > 0 seconds. Treat as never-opened.
  return {
    kind: 'never_opened',
    title: 'Nobody stayed connected',
    detail: 'Conference opened but no session logged any duration.',
    tone: 'alert',
  };
}

function VerdictBanner({ verdict }: { verdict: Verdict }) {
  const palette = verdictPalette(verdict.tone);
  const Icon = verdict.tone === 'success'
    ? CheckCircle2
    : verdict.tone === 'muted'
      ? ShieldCheck
      : TriangleAlert;
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        gap: theme.space[3],
        alignItems: 'flex-start',
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        marginBottom: theme.space[4],
      }}
    >
      <Icon size={16} aria-hidden style={{ color: palette.fg, marginTop: 2, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: palette.fg,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {verdict.title}
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.xs,
            color: palette.fgMuted,
            lineHeight: 1.5,
          }}
        >
          {verdict.detail}
        </p>
      </div>
    </div>
  );
}

function verdictPalette(tone: Verdict['tone']): { bg: string; border: string; fg: string; fgMuted: string } {
  switch (tone) {
    case 'success':
      return { bg: '#EAF7EE', border: '#C6E3CF', fg: '#1F5A33', fgMuted: '#3D7050' };
    case 'warn':
      return { bg: '#FFF6E5', border: '#F0D7A6', fg: '#7A5410', fgMuted: '#8E6826' };
    case 'alert':
      return { bg: '#FFEFEF', border: '#F2C2C2', fg: '#8E1F1F', fgMuted: '#9F3939' };
    case 'muted':
    default:
      return { bg: theme.color.bg, border: theme.color.border, fg: theme.color.ink, fgMuted: theme.color.inkMuted };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Conference window — start and end Google itself recorded
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// MetadataList — the single scannable facts block that replaces the
// old "Conference window" pill + "Evidence chips" row. Definition-list
// style: label on the left, value on the right, tabular nums for
// times. Each row is a discrete fact about the meeting:
//
//   • Conference: when Google saw the room open / close (and how many
//     distinct conferences happened in this space).
//   • Recording / Transcript: corroborating artefact counts, shown
//     once the meeting has ended (post-meeting only — zeros pre-
//     meeting are just noise).
//   • Invite sent to: the patient email we wired to the Calendar invite.
//     CRITICAL for identity-mismatch cases: if the patient joins from
//     a different Google account than this email, the RSVP row says
//     "no response" but the participants list below shows the actual
//     identity they used. Surfacing the tracked email makes the
//     mismatch visible at a glance instead of the operator wondering
//     which mailbox we're talking about.
// ─────────────────────────────────────────────────────────────────────

function MetadataList({
  startedAt,
  endedAt,
  conferenceCount,
  recordingCount,
  transcriptCount,
  patientRsvpStatus,
  patientEmail,
  meetingHasEnded,
}: {
  startedAt: string | null;
  endedAt: string | null;
  conferenceCount: number | null;
  recordingCount: number | null;
  transcriptCount: number | null;
  patientRsvpStatus: 'accepted' | 'declined' | 'tentative' | 'needsAction' | null;
  patientEmail: string | null;
  meetingHasEnded: boolean;
}) {
  const rows: Array<{ label: string; value: ReactNode; tone?: 'success' | 'warn' | 'muted' }> = [];

  // Conference timing. Same-day window collapses to a single date
  // prefix on the left, "still open" reads cleanly for an active
  // conference, and the multi-conference count appends only when > 1
  // so the common single-conference case stays minimal.
  if (startedAt || endedAt) {
    const fmt = (iso: string) =>
      new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const fmtDay = (iso: string) =>
      new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const startLabel = startedAt ? `${fmtDay(startedAt)} ${fmt(startedAt)}` : '—';
    const endLabel = endedAt
      ? startedAt && new Date(endedAt).toDateString() !== new Date(startedAt).toDateString()
        ? `${fmtDay(endedAt)} ${fmt(endedAt)}`
        : fmt(endedAt)
      : 'still open';
    const count = conferenceCount ?? 0;
    rows.push({
      label: 'Conference',
      value: `${startLabel} → ${endLabel}${count > 1 ? ` · ${count} conferences` : ''}`,
    });
  }

  // Post-meeting: recording + transcript counts. A non-zero recording
  // count is the strongest corroborating evidence we have ("the call
  // produced bytes"). Zero is also useful — confirms no recording was
  // taken. Transcript is only meaningful when present.
  if (meetingHasEnded) {
    const r = recordingCount ?? 0;
    rows.push({
      label: 'Recording',
      value: r > 0 ? `${r} recording${r === 1 ? '' : 's'}` : 'Not recorded',
      tone: r > 0 ? 'success' : 'muted',
    });
    const t = transcriptCount ?? 0;
    if (t > 0) {
      rows.push({
        label: 'Transcript',
        value: `${t} transcript${t === 1 ? '' : 's'}`,
        tone: 'success',
      });
    }
  }

  // Calendar invite RSVP row. Two things to communicate clearly:
  //
  //   • Where we sent the Google Calendar invite (the patient email on
  //     file). The patient may join from a different Google account
  //     than this — common in practice — so showing the tracked
  //     mailbox prevents the operator from misreading "no response"
  //     as "patient unreachable".
  //   • What their RSVP state means in plain English. "No response
  //     yet" used to read as "we have no data on this patient", but
  //     it actually means "they haven't clicked Yes / No / Maybe on
  //     the Google Calendar invite". Many iCloud users never do —
  //     Apple Mail handles Calendar invites differently from Gmail —
  //     so this is not a "they won't attend" signal. The participants
  //     list below is the source of truth for who actually joined.
  if (patientEmail) {
    const status = patientRsvpStatus
      ? ({
          accepted: { label: 'Patient accepted in Google Calendar', tone: 'success' as const },
          declined: { label: 'Patient declined in Google Calendar', tone: 'warn' as const },
          tentative: { label: 'Patient marked as maybe in Google Calendar', tone: 'muted' as const },
          needsAction: { label: "Patient has not responded in Google Calendar (often left untouched by Apple Mail or Outlook recipients)", tone: 'muted' as const },
        } satisfies Record<'accepted' | 'declined' | 'tentative' | 'needsAction', { label: string; tone: 'success' | 'warn' | 'muted' }>)[patientRsvpStatus]
      : { label: "Patient has not responded in Google Calendar (often left untouched by Apple Mail or Outlook recipients)", tone: 'muted' as const };
    rows.push({
      label: 'Google Calendar invite',
      value: (
        <span>
          <span style={{ color: theme.color.ink }}>Sent to {patientEmail}.</span>{' '}
          <span style={{ color: toneColor(status.tone) }}>{status.label}.</span>
        </span>
      ),
      tone: status.tone,
    });
  }

  if (rows.length === 0) return null;

  return (
    <dl
      style={{
        margin: `0 0 ${theme.space[4]}px`,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        rowGap: theme.space[2],
        columnGap: theme.space[4],
        fontSize: theme.type.size.sm,
        lineHeight: 1.4,
      }}
    >
      {rows.map((r, i) => (
        <Fragment key={i}>
          <dt
            style={{
              margin: 0,
              color: theme.color.inkMuted,
              fontWeight: theme.type.weight.medium,
              whiteSpace: 'nowrap',
            }}
          >
            {r.label}
          </dt>
          <dd
            style={{
              margin: 0,
              color: theme.color.ink,
              fontVariantNumeric: 'tabular-nums',
              wordBreak: 'break-word',
            }}
          >
            {r.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function toneColor(tone: 'success' | 'warn' | 'muted'): string {
  switch (tone) {
    case 'success':
      return '#1F5A33';
    case 'warn':
      return '#8E6826';
    case 'muted':
    default:
      return theme.color.inkMuted;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Participants — grouped by person, one row each
// ─────────────────────────────────────────────────────────────────────

interface GroupedParticipant {
  key: string;
  displayName: string;
  isHost: boolean;
  sessionCount: number;
  totalSeconds: number;
  firstJoinedAt: string | null;
  lastLeftAt: string | null;
  stillIn: boolean;
}

function groupByPerson(rows: MeetAttendanceRow[]): GroupedParticipant[] {
  const map = new Map<string, GroupedParticipant>();
  for (const row of rows) {
    // Prefer Google's stable user id; fall back to display name. Guests
    // share a "Guest" bucket per appointment which is the same name
    // Google publishes for them — acceptable since we can't distinguish
    // anonymous joiners anyway.
    const key = row.meet_user_id ?? row.participant_name ?? 'unknown';
    const existing = map.get(key);
    const seconds = row.duration_seconds ?? 0;
    const joinedMs = row.joined_at ? new Date(row.joined_at).getTime() : null;
    const leftMs = row.left_at ? new Date(row.left_at).getTime() : null;
    if (!existing) {
      map.set(key, {
        key,
        displayName: row.participant_name ?? 'Guest',
        isHost: row.is_host,
        sessionCount: 1,
        totalSeconds: seconds,
        firstJoinedAt: row.joined_at,
        lastLeftAt: row.left_at,
        stillIn: row.left_at == null,
      });
      continue;
    }
    existing.sessionCount += 1;
    existing.totalSeconds += seconds;
    // is_host = true for any session sticks; staff covering for one
    // another counts as the staff side.
    if (row.is_host) existing.isHost = true;
    if (joinedMs != null) {
      const prevJoined = existing.firstJoinedAt ? new Date(existing.firstJoinedAt).getTime() : null;
      if (prevJoined == null || joinedMs < prevJoined) {
        existing.firstJoinedAt = row.joined_at;
      }
    }
    if (leftMs != null) {
      const prevLeft = existing.lastLeftAt ? new Date(existing.lastLeftAt).getTime() : null;
      if (prevLeft == null || leftMs > prevLeft) {
        existing.lastLeftAt = row.left_at;
      }
    }
    if (row.left_at == null) existing.stillIn = true;
  }
  return Array.from(map.values()).sort((a, b) => {
    // Host rows surface above non-host. Within each, longest stay first.
    if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
    return b.totalSeconds - a.totalSeconds;
  });
}

function ParticipantList({
  grouped,
  patientFirstName,
  patientLastName,
}: {
  grouped: GroupedParticipant[];
  patientFirstName: string | null;
  patientLastName: string | null;
}) {
  // Display-name duplicate detection. When two distinct Google accounts
  // share the same display name (genuine case: receptionist on work +
  // personal account during a test, or two staff with the same name),
  // the participant list would otherwise show identical-looking rows.
  // We tag every row of a duplicate-name group with "Separate Google
  // account" so the operator can tell that the rows really are
  // different identities, not double-counted sessions of the same
  // person.
  const sameNameTally = new Map<string, number>();
  for (const p of grouped) sameNameTally.set(p.displayName, (sameNameTally.get(p.displayName) ?? 0) + 1);

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      {grouped.map((person) => {
        const hasSameNameDuplicate = (sameNameTally.get(person.displayName) ?? 0) > 1;
        // Identity match is only meaningful for non-host participants —
        // it's specifically the "is this actually the patient on file?"
        // question. Skip hosts entirely; they have their own Host chip.
        const identityMatch = person.isHost
          ? null
          : matchesPatientName(person.displayName, patientFirstName, patientLastName);
        return (
          <li
            key={person.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.space[3],
              padding: `${theme.space[3]}px ${theme.space[4]}px`,
              borderRadius: theme.radius.input,
              background: theme.color.surface,
              border: `1px solid ${theme.color.border}`,
            }}
          >
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], minWidth: 0, flexWrap: 'wrap' }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: theme.type.size.base,
                    fontWeight: theme.type.weight.semibold,
                    color: theme.color.ink,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {person.displayName}
                </p>
                <HostChip isHost={person.isHost} />
                {hasSameNameDuplicate ? <SeparateAccountChip /> : null}
                {identityMatch === 'mismatch' ? <IdentityMismatchChip /> : null}
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {person.sessionCount === 1
                  ? formatSingleSessionWindow(person)
                  : `${person.sessionCount} sessions · ${formatSingleSessionWindow(person)}`}
              </p>
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                gap: 2,
              }}
            >
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.sm,
                  color: theme.color.ink,
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: theme.type.weight.medium,
                }}
              >
                {formatDuration(person.totalSeconds)}
              </p>
              {person.stillIn ? (
                <p
                  style={{
                    margin: 0,
                    fontSize: theme.type.size.xs,
                    color: theme.color.inkMuted,
                  }}
                >
                  still in meeting
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// Returns 'match' when the participant's display name shares at least
// one name token with the patient's first or last name, 'mismatch'
// otherwise. Loose by design: "John S." matches "John Smith" (first
// name shared), "Smith Family" matches "John Smith" (last name shared),
// but "Cooks family iPad" matches neither and gets flagged. We never
// flag when we have no name on file to compare against — uncertainty
// isn't a mismatch.
function matchesPatientName(
  displayName: string,
  firstName: string | null,
  lastName: string | null,
): 'match' | 'mismatch' {
  const tokens = displayName
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  const first = (firstName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const last = (lastName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!first && !last) return 'match'; // nothing to compare; don't flag
  const firstHit = first.length >= 2 && tokens.some((t) => t === first || t.startsWith(first) || first.startsWith(t));
  const lastHit = last.length >= 2 && tokens.some((t) => t === last);
  return firstHit || lastHit ? 'match' : 'mismatch';
}

function IdentityMismatchChip() {
  return (
    <span
      title="This participant's Meet display name doesn't match the patient's name on file. They may have joined from a different Google account, or this is someone else."
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 8px',
        borderRadius: theme.radius.pill,
        background: '#FFF6E5',
        border: '1px solid #F0D7A6',
        color: '#7A5410',
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.semibold,
        letterSpacing: '0.02em',
      }}
    >
      Different name on file
    </span>
  );
}

// Tagged on every row whose display name is shared with at least one
// other row in the participants list. The display names are identical
// but the underlying Google user IDs differ — distinct identities,
// not double-counted sessions. Without this chip operators reading
// "Dylan Lane, Dylan Lane, Dylan Lane" three times might assume one
// of them is a duplicate. The chip + tooltip together make the truth
// clear without needing to surface raw user IDs.
function SeparateAccountChip() {
  return (
    <span
      title="Another participant uses the same display name but a different Google account. Same name, different identities."
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 8px',
        borderRadius: theme.radius.pill,
        background: theme.color.bg,
        border: `1px solid ${theme.color.border}`,
        color: theme.color.inkMuted,
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.medium,
        letterSpacing: '0.02em',
      }}
    >
      Separate Google account
    </span>
  );
}

function HostChip({ isHost }: { isHost: boolean }) {
  if (!isHost) return null;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 8px',
        borderRadius: theme.radius.pill,
        background: '#EEF6FF',
        border: '1px solid #C9DEF5',
        color: '#1F4F86',
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.semibold,
        letterSpacing: '0.02em',
      }}
    >
      Host
    </span>
  );
}

function formatSingleSessionWindow(person: GroupedParticipant): string {
  if (!person.firstJoinedAt) return '';
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (person.stillIn || !person.lastLeftAt) {
    return `from ${fmt(person.firstJoinedAt)}`;
  }
  return `${fmt(person.firstJoinedAt)} → ${fmt(person.lastLeftAt)}`;
}

// ─────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────

function Header({
  meetingCode,
  peopleCount,
  sessionCount,
  loading,
  pulling,
  onRefresh,
}: {
  meetingCode: string | null;
  peopleCount: number;
  sessionCount: number;
  loading: boolean;
  pulling: boolean;
  onRefresh: () => void;
}) {
  const meta = loading
    ? 'Loading'
    : peopleCount === 0
      ? 'No attendance yet'
      : `${peopleCount} ${peopleCount === 1 ? 'person' : 'people'} · ${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: theme.space[3] }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2], minWidth: 0 }}>
        <Users size={18} aria-hidden />
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
          }}
        >
          Meeting attendance
        </h2>
        {meetingCode ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 8px',
              borderRadius: theme.radius.pill,
              background: theme.color.bg,
              border: `1px solid ${theme.color.border}`,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.medium,
              fontVariantNumeric: 'tabular-nums',
              marginLeft: theme.space[2],
            }}
          >
            <Video size={11} aria-hidden />
            {meetingCode}
          </span>
        ) : null}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
        <span
          style={{
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.medium,
          }}
        >
          {meta}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={pulling}
          aria-label="Refresh attendance"
          style={{
            appearance: 'none',
            border: `1px solid ${theme.color.border}`,
            background: theme.color.surface,
            color: pulling ? theme.color.inkMuted : theme.color.accent,
            cursor: pulling ? 'wait' : 'pointer',
            padding: '6px 12px',
            borderRadius: theme.radius.pill,
            fontSize: theme.type.size.xs,
            fontWeight: theme.type.weight.semibold,
            fontFamily: 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            opacity: pulling ? 0.7 : 1,
          }}
        >
          {pulling ? (
            <Loader2 size={12} aria-hidden style={{ animation: 'lng-meet-spin 600ms linear infinite' }} />
          ) : (
            <RefreshCw size={12} aria-hidden />
          )}
          {pulling ? 'Pulling' : 'Refresh'}
        </button>
      </div>
    </div>
  );
}

// Section heading for the participants list. Tiny uppercase eyebrow
// so the list reads as part of the same card without competing with
// the verdict for visual weight.
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        margin: `0 0 ${theme.space[2]}px`,
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.semibold,
        color: theme.color.inkMuted,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}
    >
      {children}
    </p>
  );
}

// The footer hint replaces a longer paragraph that used to sit in the
// empty-state. Two short sentences cover everything an operator needs
// to know about why the card might look empty:
//
//   1. Google publishes attendance only after the Meet room closes
//      (host ends call, or it sits empty for ~5 minutes). This is the
//      most common cause of "I attended but the card is empty".
//
//   2. The Meet REST API doesn't publish lobby knocks or the email
//      a participant used to join — only display names. So if the
//      patient joins from a different Google account than the one on
//      the invite, the only visible signal is the display name in the
//      Participants list above.
//
// Kept terse so it doesn't dominate the card. Operators who need the
// detail will find it; everyone else can ignore it.
function FooterHint() {
  return (
    <p
      style={{
        margin: `${theme.space[4]}px 0 0`,
        paddingTop: theme.space[3],
        borderTop: `1px solid ${theme.color.border}`,
        fontSize: theme.type.size.xs,
        color: theme.color.inkMuted,
        lineHeight: 1.55,
      }}
    >
      Sessions appear once the Meet room closes — host ends the call for everyone, or the room sits empty for ~5 minutes. Google does not publish the email a participant used to join (only their display name), and does not publish lobby knocks. The Google Calendar invite row above tracks the invite Google emails the patient at booking — separate from our Lounge confirmation email. Patients reading it in Apple Mail, Outlook, iCloud, or any non-Gmail client often never click Yes / No / Maybe even when they join the meeting fine, so &ldquo;no response&rdquo; is not a &ldquo;won&rsquo;t attend&rdquo; signal. The participants list above is the source of truth for who actually joined.
    </p>
  );
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || seconds === 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins.toString().padStart(2, '0')}m`;
}

