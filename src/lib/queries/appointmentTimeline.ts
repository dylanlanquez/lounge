import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { logFailure } from '../failureLog.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';
import { useRealtimeRefresh } from '../useRealtimeRefresh.ts';
import type { TimelineEvent, TimelineFact, TimelineTone } from './visitTimeline.ts';

// ─────────────────────────────────────────────────────────────────────────────
// useAppointmentTimeline — full audit trail for a single appointment.
// Powers the AppointmentDetail page; reads patient_events and merges
// with synthetic events derived from lng_appointments / lng_visits /
// lng_system_failures so the receptionist has a complete record of
// what happened, when, and who did it.
//
// IDENTITY RESOLUTION
//
// The patient_events table is per-patient; events that pertain to a
// specific appointment identify it via varying payload shapes
// depending on the writer:
//
//   appointment_id              — the canonical key, set by the
//                                 native flows (createAppointment,
//                                 editAppointment, cancel/reverse,
//                                 markNoShow / reverse, virtual
//                                 join, visit_arrived, reminder
//                                 sweep, confirmation send).
//   old_appointment_id /        — set by rescheduleAppointment on
//   new_appointment_id            the patient_events row, since one
//                                 row covers BOTH endpoints of the
//                                 reschedule.
//   old_appointment_id_cancelled — set on confirmation_sent rows
//                                 emitted at the end of a
//                                 reschedule, so the new booking's
//                                 confirmation email is logged
//                                 against itself AND points back
//                                 at the cancelled predecessor.
//   calendly_invitee_uri        — the Calendly webhook keys events
//                                 by invitee URI, since the
//                                 Lounge appointment id isn't yet
//                                 known at the moment of insertion.
//
// We fetch the appointment first to read its calendly_invitee_uri,
// then OR across every shape so a single query catches every event
// regardless of which writer logged it. Anything missed leaves the
// timeline incomplete and undermines the audit role of this page —
// so the OR list is the most important thing in this file.
//
// SYSTEM FAILURES
//
// lng_system_failures rows scoped to this appointment are merged
// in at the end. Failed reminder sends, failed confirmation
// dispatches, etc. show up as warn-toned rows so an admin
// triaging "why did the patient never get the reminder?" can see
// the failure inline rather than digging through the structured
// failures table.
// ─────────────────────────────────────────────────────────────────────────────

interface RawPatientEventRow {
  id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  notes: string | null;
  actor_account_id: string | null;
  created_at: string;
}

interface RawAppointmentRow {
  id: string;
  source: 'calendly' | 'native' | 'manual';
  start_at: string;
  end_at: string;
  created_at: string;
  reschedule_to_id: string | null;
  calendly_invitee_uri: string | null;
  patient_id: string;
  // Booking-time facts surfaced as TimelineFact rows under the
  // "Booking placed" event so the timeline doubles as the audit
  // record of what the patient told us at booking time.
  event_type_label: string | null;
  intake: ReadonlyArray<{ question: string; answer: string }> | null;
  notes: string | null;
  // Walk-in marker rows have walk_in_id set; the rich intake (repair
  // type / appliance / arch) lives on the walk-in row itself, fetched
  // separately when this is non-null.
  walk_in_id: string | null;
}

interface RawWalkInRow {
  service_type: string | null;
  appliance_type: string | null;
  arch: 'upper' | 'lower' | 'both' | null;
  repair_notes: string | null;
}

interface RawSystemFailureRow {
  id: string;
  source: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  context: Record<string, unknown> | null;
  created_at: string;
}

interface UseAppointmentTimelineResult {
  events: TimelineEvent[];
  loading: boolean;
  error: string | null;
}

export function useAppointmentTimeline(
  appointmentId: string | null | undefined,
): UseAppointmentTimelineResult {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const { loading, settle } = useStaleQueryLoading(`appt-timeline|${appointmentId ?? ''}`);

  useEffect(() => {
    if (!appointmentId) {
      setEvents([]);
      setError(null);
      settle();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data: rawAppt, error: apptErr } = await supabase
          .from('lng_appointments')
          .select(
            'id, source, start_at, end_at, created_at, reschedule_to_id, calendly_invitee_uri, patient_id, event_type_label, intake, notes, walk_in_id',
          )
          .eq('id', appointmentId)
          .maybeSingle();
        if (cancelled) return;
        if (apptErr) {
          await logFailure({
            source: 'useAppointmentTimeline.appointment',
            severity: 'error',
            message: apptErr.message,
            context: { appointmentId },
          });
          setError(apptErr.message);
          settle();
          return;
        }
        const appt = rawAppt as RawAppointmentRow | null;
        if (!appt) {
          // Appointment doesn't exist (or RLS hides it). Empty
          // timeline — the page itself shows the not-found surface
          // already, this hook just stays quiet.
          setEvents([]);
          setError(null);
          settle();
          return;
        }

        // Walk-in marker rows carry their rich intake on the walk-in
        // table itself (service_type / appliance_type / arch /
        // repair_notes). Fetched here so the booking event surfaces
        // those facts inline. Failure is non-fatal — the timeline
        // still renders, we just lose the intake column.
        let walkIn: RawWalkInRow | null = null;
        if (appt.walk_in_id) {
          const { data: wkData, error: wkErr } = await supabase
            .from('lng_walk_ins')
            .select('service_type, appliance_type, arch, repair_notes')
            .eq('id', appt.walk_in_id)
            .maybeSingle();
          if (cancelled) return;
          if (wkErr) {
            await logFailure({
              source: 'useAppointmentTimeline.walkIn',
              severity: 'warning',
              message: wkErr.message,
              context: { appointmentId, walkInId: appt.walk_in_id },
            });
          } else {
            walkIn = (wkData as RawWalkInRow | null) ?? null;
          }
        }

        // Build the OR string. Every payload shape that could
        // identify this appointment, joined by commas. PostgREST
        // OR groups don't allow embedded commas in unquoted values,
        // so anything user-supplied (calendly_invitee_uri, which
        // is a URL containing slashes and no commas) is fine to
        // inline; we still escape parens defensively.
        const escId = appt.id;
        const orClauses = [
          `payload->>appointment_id.eq.${escId}`,
          `payload->>old_appointment_id.eq.${escId}`,
          `payload->>new_appointment_id.eq.${escId}`,
          `payload->>old_appointment_id_cancelled.eq.${escId}`,
        ];
        if (appt.calendly_invitee_uri) {
          orClauses.push(
            `payload->>calendly_invitee_uri.eq.${escapeOr(appt.calendly_invitee_uri)}`,
          );
        }

        // Fetch matching patient_events + system failures in parallel.
        // The system_failures lookup uses the same OR pattern so any
        // server-side failure that referenced this appointment in its
        // context surfaces here.
        const [eventsRes, failuresRes] = await Promise.all([
          supabase
            .from('patient_events')
            .select('id, event_type, payload, notes, actor_account_id, created_at')
            .eq('patient_id', appt.patient_id)
            .or(orClauses.join(','))
            .order('created_at', { ascending: true }),
          supabase
            .from('lng_system_failures')
            .select('id, source, severity, message, context, created_at')
            .or(orClauses.map((c) => c.replace('payload->>', 'context->>')).join(','))
            .order('created_at', { ascending: true }),
        ]);
        if (cancelled) return;

        if (eventsRes.error) {
          await logFailure({
            source: 'useAppointmentTimeline.events',
            severity: 'error',
            message: eventsRes.error.message,
            context: { appointmentId },
          });
          setError(eventsRes.error.message);
          settle();
          return;
        }
        if (failuresRes.error) {
          // Failures table read failure is non-fatal — the timeline
          // still renders without the system-failure rows. Log so
          // ops can see the read itself broke.
          await logFailure({
            source: 'useAppointmentTimeline.failures',
            severity: 'warning',
            message: failuresRes.error.message,
            context: { appointmentId },
          });
        }

        const rows = (eventsRes.data ?? []) as RawPatientEventRow[];
        const failures = ((failuresRes.data as RawSystemFailureRow[] | null) ?? []).filter((f) => {
          // Belt-and-braces filter: only rows whose context mentions
          // THIS appointment id. The OR query already narrows; this
          // catches any false positives from the JSON path operators.
          if (!f.context) return false;
          return matchesAppointment(f.context, appt);
        });

        // Resolve account names in one round-trip so each row can
        // show "by Sarah Henderson" instead of a UUID, AND the
        // appointment_edited diff lines can show "assigned staff:
        // John → Sarah" instead of leaking the underlying account
        // ids. Combine the actor ids and any account ids referenced
        // in the changes payload of edit events into a single fetch.
        const accountIdsToResolve = new Set<string>();
        for (const r of rows) {
          if (r.actor_account_id) accountIdsToResolve.add(r.actor_account_id);
          if (r.event_type === 'appointment_edited') {
            const changes = readObject(r.payload, 'changes');
            if (changes) {
              for (const value of Object.values(changes)) {
                if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
                const diff = value as { from?: unknown; to?: unknown };
                if (typeof diff.from === 'string' && isUuid(diff.from)) accountIdsToResolve.add(diff.from);
                if (typeof diff.to === 'string' && isUuid(diff.to)) accountIdsToResolve.add(diff.to);
              }
            }
          }
        }
        const accountById = new Map<string, string>();
        if (accountIdsToResolve.size > 0) {
          const { data: accounts, error: accErr } = await supabase
            .from('accounts')
            .select('id, first_name, last_name, name')
            .in('id', Array.from(accountIdsToResolve));
          if (cancelled) return;
          if (accErr) {
            await logFailure({
              source: 'useAppointmentTimeline.accounts',
              severity: 'warning',
              message: accErr.message,
              context: { idCount: accountIdsToResolve.size },
            });
          } else {
            for (const a of (accounts ?? []) as Array<{
              id: string;
              first_name: string | null;
              last_name: string | null;
              name: string | null;
            }>) {
              accountById.set(a.id, accountDisplayName(a));
            }
          }
        }
        // Backwards-compatible alias used below in mapEvent. The
        // single accountById map now serves both roles.
        const actorById = accountById;

        // Resolve referenced sibling appointments (the "from" or "to"
        // side of any reschedule that mentions us). We need their
        // start_at to render "Rescheduled to Sat 9 May at 11:00"
        // properly. Collect every id mentioned, dedupe, batch-fetch.
        const siblingIds = new Set<string>();
        if (appt.reschedule_to_id) siblingIds.add(appt.reschedule_to_id);
        for (const r of rows) {
          for (const key of [
            'old_appointment_id',
            'new_appointment_id',
            'old_appointment_id_cancelled',
          ]) {
            const v = readString(r.payload, key);
            if (v && v !== appt.id) siblingIds.add(v);
          }
        }
        const siblingById = new Map<string, { start_at: string }>();
        if (siblingIds.size > 0) {
          const { data: siblings, error: sibErr } = await supabase
            .from('lng_appointments')
            .select('id, start_at')
            .in('id', Array.from(siblingIds));
          if (cancelled) return;
          if (sibErr) {
            await logFailure({
              source: 'useAppointmentTimeline.siblings',
              severity: 'warning',
              message: sibErr.message,
              context: { siblingCount: siblingIds.size },
            });
          } else {
            for (const s of (siblings ?? []) as Array<{ id: string; start_at: string }>) {
              siblingById.set(s.id, { start_at: s.start_at });
            }
          }
        }

        const out: TimelineEvent[] = [];

        // Synthesised "Booking placed" — when no patient_events row
        // logs the creation (older Calendly imports pre-date the
        // logging). Always falls at the appointment's created_at so
        // the timeline opens cleanly.
        const hasBookedEvent = rows.some((r) => r.event_type === 'appointment_booked');
        if (!hasBookedEvent) {
          out.push({
            id: `synth:booked:${appt.id}`,
            type: 'appointment_created',
            timestamp: appt.created_at,
            title: 'Booking placed',
            detail: humaniseSource(appt.source),
            facts: bookingFacts(appt, walkIn),
            hint: 'calendar',
            tone: 'accent',
          });
        }

        for (const r of rows) {
          const mapped = mapEvent(r, appt, actorById, siblingById, accountById, walkIn);
          if (mapped) out.push(mapped);
        }

        for (const f of failures) {
          out.push(mapFailure(f));
        }

        // Newest first across every timeline in the app — the
        // receptionist scanning for "what's the latest on this
        // booking?" should see today's events at the top, not have
        // to scroll past the booking-placed row from a month ago.
        out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        setEvents(out);
        setError(null);
        settle();
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load timeline';
        await logFailure({
          source: 'useAppointmentTimeline.unhandled',
          severity: 'error',
          message,
          context: { appointmentId },
        });
        setError(message);
        settle();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appointmentId, tick, settle]);

  // Re-fetch whenever a patient_events row lands so a freshly-sent
  // confirmation / reminder / cancellation pops in immediately. The
  // realtime stream also covers system_failures so any failure that
  // arrives after page-open shows up without a manual refresh.
  useRealtimeRefresh([{ table: 'patient_events' }, { table: 'lng_system_failures' }], () =>
    setTick((t) => t + 1),
  );

  return { events, loading, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event mapping — turns a patient_events row into a TimelineEvent
// with a curated title, detail line and tone. Returns null for any
// event_type we don't surface on this view.
// ─────────────────────────────────────────────────────────────────────────────

function mapEvent(
  row: RawPatientEventRow,
  appt: RawAppointmentRow,
  actorById: Map<string, string>,
  siblingById: Map<string, { start_at: string }>,
  accountById: Map<string, string>,
  walkIn: RawWalkInRow | null,
): TimelineEvent | null {
  const actor = row.actor_account_id ? actorById.get(row.actor_account_id) : undefined;
  const base = { id: row.id, timestamp: row.created_at, actor };

  switch (row.event_type) {
    case 'appointment_booked': {
      const source = readString(row.payload, 'source') ?? appt.source;
      return {
        ...base,
        type: 'appointment_created',
        title: 'Booking placed',
        detail: humaniseSource(source),
        facts: bookingFacts(appt, walkIn),
        hint: 'calendar',
        tone: 'accent',
      };
    }

    case 'appointment_edited': {
      const changes = readObject(row.payload, 'changes');
      const detail = describeChanges(changes, accountById);
      // No real change worth surfacing — older audit rows wrote a
      // diff even when from === to. Drop the timeline row entirely
      // so the receptionist doesn't see a "Booking edited" event
      // they didn't make.
      if (!detail) return null;
      return {
        ...base,
        type: 'patient_event',
        title: 'Booking edited',
        detail,
        hint: 'calendar',
        tone: 'neutral',
      };
    }

    case 'appointment_rescheduled': {
      // Native flow puts old + new appointment ids in the payload.
      // We're either the OLD one ("rescheduled away to <new>"), the
      // NEW one ("rescheduled here from <old>"), or — for Calendly —
      // the same appointment row that got status flipped (no
      // sibling info available, just that it was rescheduled).
      const oldId = readString(row.payload, 'old_appointment_id');
      const newId = readString(row.payload, 'new_appointment_id');
      const reason = readString(row.payload, 'reason');
      const calendlyInvitee = readString(row.payload, 'calendly_invitee_uri');

      let title = 'Rescheduled';
      const bits: Array<string | null | undefined> = [];

      if (oldId && newId) {
        if (oldId === appt.id) {
          // We're the source; render the destination.
          const target = siblingById.get(newId);
          title = 'Rescheduled to a new slot';
          if (target) bits.push(`new slot: ${formatWhen(target.start_at)}`);
        } else if (newId === appt.id) {
          // We're the destination; render the source.
          const target = siblingById.get(oldId);
          title = 'Rescheduled here from an earlier slot';
          if (target) bits.push(`previous slot: ${formatWhen(target.start_at)}`);
        }
      } else if (calendlyInvitee) {
        // Calendly webhook variant — no sibling info in the payload,
        // just a flag that this booking was moved on Calendly.
        bits.push('via Calendly');
      }
      if (reason) bits.push(`reason: ${reason}`);

      return {
        ...base,
        type: 'patient_event',
        title,
        detail: joinDetail(...bits),
        hint: 'calendar',
        tone: 'warn',
      };
    }

    case 'appointment_cancelled': {
      const reason = readString(row.payload, 'reason');
      const previousStatus = readString(row.payload, 'previous_status');
      const calendlyInvitee = readString(row.payload, 'calendly_invitee_uri');
      const detail = joinDetail(
        reason ? `reason: ${reason}` : null,
        previousStatus && previousStatus !== 'booked'
          ? `was ${humaniseStatus(previousStatus)}`
          : null,
        calendlyInvitee ? 'cancelled on Calendly' : null,
      );
      return {
        ...base,
        type: 'patient_event',
        title: 'Cancelled',
        detail,
        hint: 'flag',
        tone: 'alert',
      };
    }

    case 'appointment_cancellation_reversed':
      return {
        ...base,
        type: 'patient_event',
        title: 'Cancellation reversed',
        detail: 'Booking restored to its scheduled time',
        hint: 'calendar',
        tone: 'accent',
      };

    case 'no_show': {
      const reason = readString(row.payload, 'reason');
      const wasVirtual = readBool(row.payload, 'was_virtual');
      const joinedBefore = readBool(row.payload, 'joined_before_no_show');
      const detail = joinDetail(
        reason ? humaniseNoShowReason(reason) : null,
        wasVirtual ? 'virtual appointment' : null,
        joinedBefore ? 'staff had joined the meeting' : null,
      );
      return {
        ...base,
        type: 'patient_event',
        title: 'Marked as no-show',
        detail,
        hint: 'flag',
        tone: 'warn',
      };
    }

    case 'no_show_reversed':
      return {
        ...base,
        type: 'patient_event',
        title: 'No-show reversed',
        detail: 'Booking restored to its prior state',
        hint: 'check',
        tone: 'accent',
      };

    case 'virtual_meeting_joined':
      return {
        ...base,
        type: 'patient_event',
        title: 'Joined virtual meeting',
        hint: 'check',
        tone: 'neutral',
      };

    case 'visit_arrived': {
      const visitId = readString(row.payload, 'visit_id');
      return {
        ...base,
        type: 'visit_opened',
        title: 'Patient arrived',
        detail: visitId ? 'Visit opened' : undefined,
        hint: 'check',
        tone: 'accent',
      };
    }

    case 'appointment_confirmation_sent':
    case 'appointment_cancellation_sent': {
      const recipient = readString(row.payload, 'recipient');
      const messageId = readString(row.payload, 'message_id');
      const provider = readString(row.payload, 'provider');
      const oldCancelled = readString(row.payload, 'old_appointment_id_cancelled');
      const isCancellation = row.event_type === 'appointment_cancellation_sent';
      const detail = joinDetail(
        recipient ? `to ${recipient}` : null,
        provider ? `via ${humaniseProvider(provider)}` : null,
        oldCancelled
          ? 'replaces a cancelled booking'
          : null,
        messageId ? `id ${shortMessageId(messageId)}` : null,
      );
      return {
        ...base,
        type: 'patient_event',
        title: isCancellation ? 'Cancellation email sent' : 'Confirmation email sent',
        detail,
        hint: 'mail',
        tone: 'neutral',
      };
    }

    case 'appointment_reminder_sent': {
      const recipient = readString(row.payload, 'recipient');
      const messageId = readString(row.payload, 'message_id');
      const provider = readString(row.payload, 'provider');
      const detail = joinDetail(
        recipient ? `to ${recipient}` : null,
        provider ? `via ${humaniseProvider(provider)}` : null,
        messageId ? `id ${shortMessageId(messageId)}` : null,
      );
      return {
        ...base,
        type: 'patient_event',
        title: 'Reminder email sent',
        detail,
        hint: 'mail',
        tone: 'neutral',
      };
    }

    case 'appointment_reminder_skipped': {
      const reason = readString(row.payload, 'reason');
      return {
        ...base,
        type: 'patient_event',
        title: 'Reminder skipped',
        detail: reason ? humaniseReminderSkipReason(reason) : undefined,
        hint: 'mail',
        tone: 'warn',
      };
    }

    case 'deposit_paid': {
      const pence = readNumber(row.payload, 'amount_pence') ?? readNumber(row.payload, 'pence');
      const provider = readString(row.payload, 'provider');
      const externalId = readString(row.payload, 'external_id');
      return {
        ...base,
        type: 'deposit_paid',
        title: 'Deposit captured',
        detail: joinDetail(
          pence != null ? formatGBP(pence) : null,
          provider ? `via ${humaniseProvider(provider)}` : null,
          externalId ? `ref ${externalId}` : null,
        ),
        hint: 'card',
        tone: 'accent',
      };
    }

    case 'deposit_failed': {
      const provider = readString(row.payload, 'provider');
      return {
        ...base,
        type: 'patient_event',
        title: 'Deposit attempt failed',
        detail: joinDetail(
          provider ? `via ${humaniseProvider(provider)}` : null,
          'do not credit at checkout',
        ),
        hint: 'card',
        tone: 'alert',
      };
    }

    default:
      // Drop anything we don't curate so the page stays focussed.
      // Adding a new event type to surface = add a case here.
      return null;
  }
}

function mapFailure(f: RawSystemFailureRow): TimelineEvent {
  const tone: TimelineTone =
    f.severity === 'critical' || f.severity === 'error' ? 'alert' : 'warn';
  return {
    id: `failure:${f.id}`,
    type: 'patient_event',
    timestamp: f.created_at,
    title: humaniseFailureSource(f.source),
    detail: f.message,
    hint: 'flag',
    tone,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function matchesAppointment(context: Record<string, unknown>, appt: RawAppointmentRow): boolean {
  const id = appt.id;
  const candidates = [
    readString(context, 'appointment_id'),
    readString(context, 'old_appointment_id'),
    readString(context, 'new_appointment_id'),
    readString(context, 'old_appointment_id_cancelled'),
  ];
  if (candidates.includes(id)) return true;
  if (
    appt.calendly_invitee_uri &&
    readString(context, 'calendly_invitee_uri') === appt.calendly_invitee_uri
  ) {
    return true;
  }
  return false;
}

function accountDisplayName(a: {
  first_name: string | null;
  last_name: string | null;
  name: string | null;
}): string {
  const fn = a.first_name?.trim();
  const ln = a.last_name?.trim();
  if (fn && ln) return `${fn} ${ln}`;
  if (fn) return fn;
  if (ln) return ln;
  return a.name?.trim() ?? '';
}

function readString(payload: Record<string, unknown> | null, key: string): string | null {
  if (!payload) return null;
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readNumber(payload: Record<string, unknown> | null, key: string): number | null {
  if (!payload) return null;
  const v = payload[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : null;
}

function readBool(payload: Record<string, unknown> | null, key: string): boolean | null {
  if (!payload) return null;
  const v = payload[key];
  return typeof v === 'boolean' ? v : null;
}

function readObject(
  payload: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  if (!payload) return null;
  const v = payload[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

function joinDetail(...bits: Array<string | null | undefined>): string | undefined {
  const filtered = bits.filter((b): b is string => !!b && b.trim().length > 0);
  return filtered.length > 0 ? filtered.join(' · ') : undefined;
}

// "12 May at 11:00" — used for sibling appointment timestamps inside
// the reschedule detail line.
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} at ${time}`;
}

function humaniseSource(source: string): string {
  if (source === 'calendly') return 'Imported from Calendly';
  if (source === 'manual') return 'Manually added';
  if (source === 'native') return 'Created in Lounge';
  return source;
}

// Builds the structured fact list rendered under the "Booking
// placed" event. Captures intake-style answers (repair type,
// appliance, arch, notes) so the timeline doubles as the audit
// record of what was on the booking form.
//
// Service is intentionally NOT in this list. The event's inline
// detail line already carries the booking summary ("Imported from
// Calendly · Denture Repair"); pushing it into facts on top
// produces a single-row card that reads as redundant. When the
// only fact would be Service, we'd rather render no card at all.
//
// Two sources merge here:
//
//   1. Calendly-style intake question/answer pairs from
//      lng_appointments.intake. Each row becomes its own fact with
//      a humanised question label and a normalised answer value
//      (e.g. "Top" → "Upper" for arch answers).
//   2. Walk-in extras from lng_walk_ins (appliance type, arch,
//      repair notes) when this booking is a walk-in marker.
//
// Booking notes — free-text the operator typed when creating the
// booking — are folded in last as a final fact.
function bookingFacts(
  appt: RawAppointmentRow,
  walkIn: RawWalkInRow | null,
): TimelineFact[] {
  const facts: TimelineFact[] = [];

  if (appt.intake) {
    for (const item of appt.intake) {
      const rawValue = item.answer?.trim();
      if (!rawValue) continue;
      const label = humaniseIntakeQuestion(item.question);
      facts.push({ label, value: humaniseIntakeAnswer(label, rawValue) });
    }
  }

  if (walkIn) {
    if (walkIn.appliance_type?.trim()) {
      facts.push({ label: 'Appliance type', value: walkIn.appliance_type.trim() });
    }
    if (walkIn.arch) {
      facts.push({ label: 'Arch', value: humaniseArch(walkIn.arch) });
    }
    if (walkIn.repair_notes?.trim()) {
      facts.push({ label: 'Repair notes', value: walkIn.repair_notes.trim() });
    }
  }

  if (appt.notes?.trim()) {
    facts.push({ label: 'Booking notes', value: appt.notes.trim() });
  }

  return facts;
}

// Mirror the visitTimeline intake-question humaniser so the
// appointment timeline labels read identically to the visit
// timeline + AppointmentDetail's IntakeCard. Kept in sync by hand;
// low drift risk because the rewrite list is tied to Calendly's
// form-builder phrasing, which staff control directly.
function humaniseIntakeQuestion(question: string): string {
  const trimmed = question.trim().replace(/[?:]+$/, '');
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  switch (lower) {
    case 'what is the type of repair you would like done':
    case 'what type of repair would you like done':
    case 'type of repair':
      return 'Repair type';
    case 'contact number':
    case 'phone number':
    case "what's your contact number":
      return 'Contact number';
    case 'what is the name of the dentures':
    case 'what is the brand of the dentures':
      return 'Denture brand';
    case 'where did you buy the dentures':
      return 'Where the dentures were bought';
    case 'how old are the dentures':
      return 'Age of the dentures';
    case 'which arch':
    case 'what arch':
    case 'arch':
    case 'which arch is affected':
      return 'Arch';
    case 'shade':
    case 'tooth shade':
    case 'desired shade':
      return 'Shade';
    case 'what product is the impression for':
    case 'what product is this impression for':
    case 'product the impression is for':
      return 'Product';
    default:
      return trimmed;
  }
}

// Normalise free-text answer values where the form-builder offers
// colloquial choices ("Top" / "Bottom" for arches, etc.). Defaults
// to pass-through so non-rewriteable answers print as the patient
// typed them.
function humaniseIntakeAnswer(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  if (label === 'Arch') {
    switch (lower) {
      case 'top':
      case 'upper':
        return 'Upper';
      case 'bottom':
      case 'lower':
        return 'Lower';
      case 'both':
      case 'both arches':
      case 'top and bottom':
      case 'upper and lower':
        return 'Upper and lower';
      default:
        return trimmed;
    }
  }
  if (lower === 'yes' || lower === 'y' || lower === 'true') return 'Yes';
  if (lower === 'no' || lower === 'n' || lower === 'false') return 'No';
  return trimmed;
}

function humaniseArch(arch: 'upper' | 'lower' | 'both'): string {
  switch (arch) {
    case 'upper':
      return 'Upper';
    case 'lower':
      return 'Lower';
    case 'both':
      return 'Upper and lower';
  }
}

function describeChanges(
  changes: Record<string, unknown> | null,
  accountById: Map<string, string>,
): string | undefined {
  if (!changes) return undefined;
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(changes)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const diff = raw as { from?: unknown; to?: unknown };
    const fromS = formatChangeValue(key, diff.from, accountById);
    const toS = formatChangeValue(key, diff.to, accountById);
    // Skip non-changes — older audit rows wrote a diff even when
    // from and to were the same value. Would render as "notes:
    // hey bby → hey bby" which is jargon-feeling and useless.
    if (fromS === toS) continue;
    if (fromS == null && toS == null) continue;
    const label = humaniseField(key);
    lines.push(`${label}: ${fromS ?? 'none'} → ${toS ?? 'none'}`);
  }
  return lines.length > 0 ? lines.join(' · ') : undefined;
}

// Render a single change-value into receptionist-friendly text.
// Never returns backend jargon — UUIDs resolve to display names where
// possible, unknown ids fall through to "another staff member" rather
// than leaking the raw id, JSON values get a generic "(updated)"
// label so a stranger field type doesn't print a JSON.stringify blob.
function formatChangeValue(
  field: string,
  value: unknown,
  accountById: Map<string, string>,
): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    if (field === 'staff_account_id') {
      // Resolve the account id to a display name. Falls back to
      // "another staff member" rather than "(staff member)" or the
      // raw uuid — the former reads as a generic noun, the latter
      // two are jargon.
      return accountById.get(value) ?? 'another staff member';
    }
    return truncate(value, 60);
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  // Last-resort fallback for any unexpected JSON value. Receptionist
  // sees "(updated)" rather than a stringified blob.
  return '(updated)';
}

// Quick UUID shape check used to decide whether a string change-value
// should go through the account resolver. Doesn't validate strictness
// (we only need to filter out free-text strings).
function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function humaniseField(field: string): string {
  switch (field) {
    case 'notes':
      return 'notes';
    case 'staff_account_id':
      return 'assigned staff';
    default:
      return field.replace(/_/g, ' ');
  }
}

function humaniseStatus(status: string): string {
  switch (status) {
    case 'booked':
      return 'Booked';
    case 'arrived':
      return 'Arrived';
    case 'in_progress':
      return 'In progress';
    case 'no_show':
      return 'No-show';
    case 'cancelled':
      return 'Cancelled';
    case 'rescheduled':
      return 'Rescheduled';
    case 'complete':
      return 'Complete';
    default:
      return status;
  }
}

function humaniseNoShowReason(reason: string): string {
  switch (reason) {
    case 'did_not_turn_up':
      return 'Did not turn up';
    case 'patient_cancelled_late':
      return 'Patient cancelled late';
    case 'clinic_cancelled':
      return 'Clinic cancelled';
    case 'other':
      return 'Other reason';
    default:
      return reason;
  }
}

function humaniseReminderSkipReason(reason: string): string {
  switch (reason) {
    case 'no_email_on_patient':
    case 'no_email_on_file':
      return 'No email on file for the patient';
    case 'too_late':
      return 'Sweep ran too late for this slot';
    case 'opted_out':
      return 'Patient opted out of reminders';
    default:
      return reason.replace(/_/g, ' ');
  }
}

function humaniseProvider(provider: string): string {
  if (provider === 'paypal') return 'PayPal';
  if (provider === 'stripe') return 'Stripe';
  if (provider === 'resend') return 'Resend';
  return provider;
}

function humaniseFailureSource(source: string): string {
  switch (source) {
    case 'send-appointment-confirmation':
      return 'Confirmation email failed to send';
    case 'send-appointment-reminders':
      return 'Reminder email failed to send';
    case 'send-template-test':
      return 'Test email failed to send';
    case 'calendly-webhook':
      return 'Calendly sync failure';
    default:
      // Never leak the raw edge-function slug into the receptionist's
      // timeline. A generic line + the structured failure message
      // below is enough; ops can read the raw source from
      // lng_system_failures directly.
      return 'System failure';
  }
}

function shortMessageId(id: string): string {
  // Resend ids look like "re_AbCd1234..." — keep the prefix and a
  // small tail so a triage-er can grep the dashboard without seeing
  // the full hash on screen.
  if (id.length <= 14) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function escapeOr(s: string): string {
  // PostgREST OR-string escapes — commas and parens are syntactic
  // separators, so any value containing them needs escaping. URLs
  // can contain commas in the query string, so escape both.
  return s.replace(/,/g, '\\,').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

const GBP = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 2,
});
function formatGBP(pence: number): string {
  return GBP.format(pence / 100);
}

export type { TimelineTone };
