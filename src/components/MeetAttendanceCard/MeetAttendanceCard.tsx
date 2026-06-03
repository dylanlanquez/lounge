import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, RefreshCw, ShieldCheck, TriangleAlert, Users, Video } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { useIsMobile } from '../../lib/useIsMobile.ts';
import { fmtTzAbbr } from '../../lib/dateFormat.ts';
import { Card } from '../Card/Card.tsx';
import { EmptyState } from '../EmptyState/EmptyState.tsx';
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
  // Booking end time, ISO. Drives the post-meeting publication window
  // for the in-card auto-poll: Google publishes participantSessions
  // AFTER end_at, so the poll has to keep firing for ~30 minutes past
  // end_at to catch the publication, not bail the moment end_at passes.
  endAtIso: string;
  conferenceStartedAt: string | null;
  conferenceEndedAt: string | null;
  // Number of distinct conferences logged for this space — > 1 when
  // the same Meet link has been rejoined outside its original window.
  // The card renders "(N conferences)" alongside the window line.
  conferenceCount: number | null;
  // Corroborating evidence pulled by meet-fetch-attendance. Counts are
  // the count of Google-published artefacts (non-zero = unfakeable
  // proof the meeting happened).
  recordingCount: number | null;
  transcriptCount: number | null;
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
  endAtIso,
  conferenceStartedAt,
  conferenceEndedAt,
  conferenceCount,
  recordingCount,
  transcriptCount,
  patientFirstName,
  patientLastName,
}: MeetAttendanceCardProps) {
  const { rows, loading, error, refresh } = useMeetAttendance(appointmentId);
  const [pulling, setPulling] = useState(false);
  const [toast, setToast] = useState<
    | { tone: 'success' | 'error'; title: string; description?: string }
    | null
  >(null);

  const doFetch = async (silent: boolean) => {
    if (!silent) setPulling(true);
    try {
      const result = await fetchMeetAttendance(appointmentId);
      if (result.ok) {
        if (!silent) {
          setToast({
            tone: 'success',
            title: result.waitingForMeeting
              ? 'No attendance yet'
              : result.upserts === 1
                ? '1 participant updated'
                : `${result.upserts ?? 0} participants updated`,
            description: result.waitingForMeeting
              ? 'Google publishes attendance once the meeting ends. Try again after the appointment finishes.'
              : undefined,
          });
        }
        refresh();
      } else if (!silent) {
        setToast({
          tone: 'error',
          title: 'Could not refresh attendance',
          description: result.error ?? undefined,
        });
      }
    } catch (e) {
      if (!silent) {
        setToast({
          tone: 'error',
          title: 'Could not refresh attendance',
          description: e instanceof Error ? e.message : undefined,
        });
      }
    } finally {
      if (!silent) setPulling(false);
    }
  };

  const onRefresh = () => doFetch(false);

  // Auto-poll Google for attendance while the meeting is in progress
  // AND for 30 minutes after end_at. The post-end_at window matters
  // because Google publishes participantSessions AFTER a conference
  // closes, and that publication can lag several minutes to (per the
  // LAP-00518 incident on 2026-05-28) several HOURS. Stopping at
  // end_at means we silently miss the truth in exactly the window
  // we're meant to capture. 30 min covers the realistic publication
  // tail; the meet-attendance-sweep cron is the safety net beyond it.
  const publicationDeadlineMs = useMemo(
    () => new Date(endAtIso).getTime() + 30 * 60_000,
    [endAtIso],
  );
  useEffect(() => {
    if (Date.now() > publicationDeadlineMs) return;
    const id = setInterval(() => { void doFetch(true); }, 30_000);
    return () => clearInterval(id);
  }, [publicationDeadlineMs, appointmentId]);

  const grouped = useMemo(() => groupByPerson(rows), [rows]);
  const verdict = useMemo(
    () =>
      deriveVerdict({
        rows,
        grouped,
        conferenceStartedAt,
        meetingHasEnded,
        patientFirstName,
        patientLastName,
      }),
    [rows, grouped, conferenceStartedAt, meetingHasEnded, patientFirstName, patientLastName],
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
        {/* Pre-meeting state: skip the speculative "Awaiting Google
            publication" verdict + metadata clutter entirely. Show a
            single in-theme empty state so the card reads "we know
            why this is empty, come back later" without restating
            the obvious. The verdict + metadata only earn their pixels
            once Google actually has something to publish. */}
        {verdict.kind === 'pending' ? (
          <EmptyState
            icon={<Users size={20} aria-hidden />}
            title="No attendance tracked yet"
            description="Attendance lands here once the Meet room closes."
          />
        ) : (
          <>
            <VerdictBanner verdict={verdict} />
            <MetadataList
              startedAt={conferenceStartedAt}
              endedAt={conferenceEndedAt}
              conferenceCount={conferenceCount}
              recordingCount={recordingCount}
              transcriptCount={transcriptCount}
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
          </>
        )}
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
  // Genuinely empty — no rows AND no conferenceStartedAt, both
  // pre- and post-end_at. Triggers the empty-state render.
  | 'pending'
  // Final verdicts (meeting ended, evidence on file).
  | 'never_opened'
  | 'only_host'
  | 'only_patient'
  | 'both'
  // Someone other than a registered host joined, but their Meet display
  // name does not match the patient on file — so we cannot assert it was
  // the patient (could be spectating staff, a family member, or the
  // patient under a different account). We surface the doubt rather than
  // over-claiming "Both attended". `host_unconfirmed` = a host plus an
  // unconfirmed joiner; `unconfirmed_only` = an unconfirmed joiner and no
  // host on record.
  | 'host_unconfirmed'
  | 'unconfirmed_only'
  // Mid-meeting verdicts (end_at hasn't passed but evidence has
  // landed). Present-tense copy; participant cards render alongside
  // these the same way the final verdicts do.
  | 'in_progress_both'
  | 'in_progress_host'
  | 'in_progress_patient'
  | 'in_progress_idle';

interface Verdict {
  kind: VerdictKind;
  title: string;
  detail: string;
  tone: 'success' | 'warn' | 'alert' | 'muted';
}

export function deriveVerdict(args: {
  rows: MeetAttendanceRow[];
  grouped: GroupedParticipant[];
  conferenceStartedAt: string | null;
  meetingHasEnded: boolean;
  patientFirstName: string | null;
  patientLastName: string | null;
}): Verdict {
  const { rows, grouped, conferenceStartedAt, meetingHasEnded, patientFirstName, patientLastName } = args;

  // Three-way gate, in priority order:
  //   1. Genuinely nothing on file (no rows AND no conferenceStartedAt) →
  //      pending. Render the empty state. Honest "Google hasn't
  //      published anything yet" copy, whether mid-meeting or just
  //      before end_at.
  //   2. Mid-meeting with at least one row (or a started-at) → in_progress.
  //      Google often publishes early when a conference closes before
  //      end_at (host hangs up first, both leave at 10:15 on a
  //      10:00-10:30 booking). Showing the cards while end_at is still
  //      ticking down was the previous bug — the verdict came back
  //      'pending' for ~15 minutes after rows landed, leaving the
  //      operator pressing Refresh against a blank card. Now the
  //      moment we have anything to show, we show it.
  //   3. Meeting ended → final verdict (both / only_host / only_patient /
  //      never_opened) computed from the participant durations.

  const hostJoined = grouped.some((p) => p.isHost && p.totalSeconds > 0);
  // A non-host participant only counts as THE PATIENT when their Meet
  // display name plausibly matches the patient on file. matchesPatientName
  // returns 'match' when there is no name to compare, so rows without a
  // patient name still count as the patient (we can't doubt what we can't
  // check). Non-hosts whose names DON'T match are "unconfirmed": they
  // joined, but we can't assert they were the patient. This is what stops
  // a spectating staff member (e.g. Heidi A.) from being read as the
  // customer and flipping the card to a false "Both attended".
  const nonHostPresent = grouped.filter((p) => !p.isHost && p.totalSeconds > 0);
  const isLikelyPatient = (p: GroupedParticipant) =>
    matchesPatientName(p.displayName, patientFirstName, patientLastName) === 'match';
  const patientJoined = nonHostPresent.some(isLikelyPatient);
  const unconfirmedJoined = nonHostPresent.some((p) => !isLikelyPatient(p));
  const patientLabel =
    [patientFirstName, patientLastName]
      .map((s) => s?.trim())
      .filter(Boolean)
      .join(' ') || 'the patient';
  const haveAnyEvidence = rows.length > 0 || !!conferenceStartedAt;

  // 1. Nothing landed yet, in either state.
  if (!haveAnyEvidence) {
    if (!meetingHasEnded) {
      return {
        kind: 'pending',
        title: 'Awaiting Google publication',
        detail: 'Attendance lands here once the Meet room closes.',
        tone: 'muted',
      };
    }
    // Meeting ended but Google never recorded a conference — nobody opened
    // the room. Hardest possible negative evidence.
    return {
      kind: 'never_opened',
      title: 'Nobody joined',
      detail: 'Google has no record of the conference starting.',
      tone: 'alert',
    };
  }

  // 2. In progress (or scheduled window still open) with at least one
  //    session recorded. Present-tense copy so the operator can tell
  //    this is a live snapshot, not a final reading.
  if (!meetingHasEnded) {
    if (hostJoined && patientJoined) {
      return {
        kind: 'in_progress_both',
        title: 'Meeting in progress',
        detail: 'Host and patient have both connected.',
        tone: 'success',
      };
    }
    if (hostJoined) {
      return {
        kind: 'in_progress_host',
        title: 'Host has joined',
        detail: 'Waiting on the patient. The card refreshes as Google publishes more.',
        tone: 'muted',
      };
    }
    if (patientJoined) {
      return {
        kind: 'in_progress_patient',
        title: 'Patient has joined',
        detail: 'Waiting on the host. The card refreshes as Google publishes more.',
        tone: 'warn',
      };
    }
    // Evidence exists (a conferenceStartedAt or a row with 0 seconds)
    // but no one is logged as connected yet. Still clearer to read
    // than the old pending empty state — at least the operator knows
    // something happened.
    return {
      kind: 'in_progress_idle',
      title: 'Conference opened',
      detail: 'Google has registered the room but no participant sessions yet.',
      tone: 'muted',
    };
  }

  // 3. Meeting ended — final verdict.
  if (hostJoined && patientJoined) {
    return {
      kind: 'both',
      title: 'Both attended',
      detail: 'Host and patient both connected.',
      tone: 'success',
    };
  }
  // Host connected, but the only other participant's name does not match
  // the patient. Surface the doubt instead of claiming the patient
  // attended — they may be spectating staff or a different account.
  if (hostJoined && unconfirmedJoined) {
    return {
      kind: 'host_unconfirmed',
      title: 'Patient attendance unconfirmed',
      detail: `Host connected. Another participant joined, but their name does not match ${patientLabel}, so we cannot confirm the patient attended.`,
      tone: 'warn',
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
  // Someone joined, but no host is on record and the participant's name
  // does not match the patient — we can't say who attended.
  if (!hostJoined && unconfirmedJoined) {
    return {
      kind: 'unconfirmed_only',
      title: 'Attendance unconfirmed',
      detail: `A participant joined, but their name does not match ${patientLabel} and no host is on record.`,
      tone: 'warn',
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
  meetingHasEnded,
}: {
  startedAt: string | null;
  endedAt: string | null;
  conferenceCount: number | null;
  recordingCount: number | null;
  transcriptCount: number | null;
  meetingHasEnded: boolean;
}) {
  const rows: Array<{ label: string; value: ReactNode; tone?: 'success' | 'warn' | 'muted' }> = [];

  // Conference timing. Same-day window collapses to a single date
  // prefix on the left, "still open" reads cleanly for an active
  // conference, and the multi-conference count appends only when > 1
  // so the common single-conference case stays minimal.
  if (startedAt || endedAt) {
    // Clinic time always — meeting timestamps come from Google's
    // server and we want the lab team in Egypt to read them the
    // same way the receptionist in Glasgow does. Zone suffix is
    // added once at the end of the composed value.
    const fmt = (iso: string) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(iso));
    const fmtDay = (iso: string) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        day: 'numeric',
        month: 'short',
      }).format(new Date(iso));
    const startLabel = startedAt ? `${fmtDay(startedAt)} ${fmt(startedAt)}` : '—';
    const endLabel = endedAt
      ? startedAt && new Date(endedAt).toDateString() !== new Date(startedAt).toDateString()
        ? `${fmtDay(endedAt)} ${fmt(endedAt)}`
        : fmt(endedAt)
      : 'still open';
    const zoneSuffix = startedAt
      ? ` ${fmtTzAbbr(startedAt)}`
      : endedAt
        ? ` ${fmtTzAbbr(endedAt)}`
        : '';
    const count = conferenceCount ?? 0;
    rows.push({
      label: 'Conference',
      value: `${startLabel} → ${endLabel}${zoneSuffix}${count > 1 ? ` · ${count} conferences` : ''}`,
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


// ─────────────────────────────────────────────────────────────────────
// Participants — grouped by person, one row each
// ─────────────────────────────────────────────────────────────────────

interface SessionDetail {
  joinedAt: string | null;
  leftAt: string | null;
  durationSeconds: number;
}

export interface GroupedParticipant {
  key: string;
  displayName: string;
  isHost: boolean;
  sessionCount: number;
  totalSeconds: number;
  firstJoinedAt: string | null;
  lastLeftAt: string | null;
  stillIn: boolean;
  sessions: SessionDetail[];
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
    const session: SessionDetail = {
      joinedAt: row.joined_at,
      leftAt: row.left_at,
      durationSeconds: seconds,
    };
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
        sessions: [session],
      });
      continue;
    }
    existing.sessionCount += 1;
    existing.totalSeconds += seconds;
    existing.sessions.push(session);
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
  const result = Array.from(map.values());
  // Sort individual sessions chronologically within each person so
  // the expanded sub-rows read top-to-bottom in time order.
  for (const p of result) {
    p.sessions.sort((x, y) => {
      const xMs = x.joinedAt ? new Date(x.joinedAt).getTime() : 0;
      const yMs = y.joinedAt ? new Date(y.joinedAt).getTime() : 0;
      return xMs - yMs;
    });
  }
  return result.sort((a, b) => {
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
      {grouped.map((person) => (
        <ParticipantRow
          key={person.key}
          person={person}
          hasSameNameDuplicate={(sameNameTally.get(person.displayName) ?? 0) > 1}
          patientFirstName={patientFirstName}
          patientLastName={patientLastName}
        />
      ))}
    </ul>
  );
}

function ParticipantRow({
  person,
  hasSameNameDuplicate,
  patientFirstName,
  patientLastName,
}: {
  person: GroupedParticipant;
  hasSameNameDuplicate: boolean;
  patientFirstName: string | null;
  patientLastName: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMultipleSessions = person.sessionCount > 1;

  // Identity match is only meaningful for non-host participants.
  const identityMatch = person.isHost
    ? null
    : matchesPatientName(person.displayName, patientFirstName, patientLastName);

  return (
    <li
      style={{
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        overflow: 'hidden',
      }}
    >
      {/* Main row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[3],
          padding: `${theme.space[3]}px ${theme.space[4]}px`,
          cursor: hasMultipleSessions ? 'pointer' : undefined,
        }}
        role={hasMultipleSessions ? 'button' : undefined}
        tabIndex={hasMultipleSessions ? 0 : undefined}
        aria-expanded={hasMultipleSessions ? expanded : undefined}
        onClick={hasMultipleSessions ? () => setExpanded((v) => !v) : undefined}
        onKeyDown={hasMultipleSessions ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        } : undefined}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {hasMultipleSessions ? (
              expanded ? (
                <ChevronUp size={12} aria-hidden style={{ color: theme.color.inkMuted, flexShrink: 0 }} />
              ) : (
                <ChevronDown size={12} aria-hidden style={{ color: theme.color.inkMuted, flexShrink: 0 }} />
              )
            ) : null}
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
                : `${person.sessionCount} sessions`}
            </p>
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 2,
            flexShrink: 0,
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
            {hasMultipleSessions && !expanded
              ? `total ${formatDuration(person.totalSeconds)}`
              : formatDuration(person.totalSeconds)}
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
      </div>
      {/* Expanded session sub-rows */}
      {hasMultipleSessions && expanded ? (
        <div
          style={{
            borderTop: `1px solid ${theme.color.border}`,
            padding: `${theme.space[2]}px ${theme.space[4]}px ${theme.space[3]}px`,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[1],
            background: theme.color.bg,
          }}
        >
          {person.sessions.map((s, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: theme.space[3],
                paddingLeft: theme.space[4],
                paddingTop: theme.space[1],
                paddingBottom: theme.space[1],
              }}
            >
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatSessionWindow(s)}
              </p>
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: theme.type.weight.medium,
                  flexShrink: 0,
                }}
              >
                {formatDuration(s.durationSeconds)}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function formatSessionWindow(session: SessionDetail): string {
  if (!session.joinedAt) return '';
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  const zone = fmtTzAbbr(session.joinedAt);
  if (!session.leftAt) {
    return `from ${fmt(session.joinedAt)} ${zone}`;
  }
  return `${fmt(session.joinedAt)} → ${fmt(session.leftAt)} ${zone}`;
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
  // Clinic time + BST/GMT suffix at the end so a participant's
  // session window reads unambiguously on any reviewer's screen.
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  const zone = fmtTzAbbr(person.firstJoinedAt);
  if (person.stillIn || !person.lastLeftAt) {
    return `from ${fmt(person.firstJoinedAt)} ${zone}`;
  }
  return `${fmt(person.firstJoinedAt)} → ${fmt(person.lastLeftAt)} ${zone}`;
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
  const isMobile = useIsMobile(640);
  const meta = loading
    ? 'Loading'
    : peopleCount === 0
      ? 'No attendance yet'
      : `${peopleCount} ${peopleCount === 1 ? 'person' : 'people'} · ${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}`;
  const codePill = meetingCode ? (
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
        whiteSpace: 'nowrap',
      }}
    >
      <Video size={11} aria-hidden />
      {meetingCode}
    </span>
  ) : null;
  const metaText = (
    <span
      style={{
        color: theme.color.inkMuted,
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.medium,
        whiteSpace: 'nowrap',
      }}
    >
      {meta}
    </span>
  );
  const refreshButton = (
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
        flexShrink: 0,
      }}
    >
      {pulling ? (
        <Loader2 size={12} aria-hidden style={{ animation: 'lng-meet-spin 600ms linear infinite' }} />
      ) : (
        <RefreshCw size={12} aria-hidden />
      )}
      {pulling ? 'Pulling' : 'Refresh'}
    </button>
  );

  // Mobile: stack the header so the meeting code pill and the meta
  // counts don't fight the title + Refresh button for horizontal
  // room. Row 1 = icon + title + Refresh; row 2 = code pill + meta.
  // The previous single-row layout squeezed the chip into a narrow
  // column and Safari let its text wrap inside the rounded
  // pill, which looked like a circular blob with text mashed
  // through it.
  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
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
          </span>
          {refreshButton}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
          {codePill}
          {metaText}
        </div>
      </div>
    );
  }

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
        {meetingCode ? <span style={{ marginLeft: theme.space[2] }}>{codePill}</span> : null}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
        {metaText}
        {refreshButton}
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

