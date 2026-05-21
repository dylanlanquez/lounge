import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useRealtimeRefresh } from '../useRealtimeRefresh.ts';

// Per-appointment staff notes. Multi-note model with soft-delete and
// a full audit trail.
//
// Storage shape:
//   lng_appointment_staff_notes — the notes themselves. One row per
//                                 note, soft-delete via deleted_at +
//                                 deleted_by + delete_reason.
//   patient_events              — per-action audit (add / amend /
//                                 delete). Each row stamps actor
//                                 + payload.note_id so the card can
//                                 group history by note.
//
// Author bylines come from the joined accounts row at fetch time;
// nothing is stored in the body. Backfill rows whose original
// author can't be traced through patient_events carry null and the
// renderer falls back to "Unknown".

export interface StaffNoteRow {
  id: string;
  appointment_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  author_account_id: string | null;
  author_first_name: string | null;
  author_last_name: string | null;
  deleted_at: string | null;
  delete_reason: string | null;
  deleted_by_account_id: string | null;
  deleted_by_first_name: string | null;
  deleted_by_last_name: string | null;
}

export type StaffNoteEventType =
  | 'staff_note_added'
  | 'staff_note_amended'
  | 'staff_note_deleted';

export interface StaffNoteEvent {
  id: string;
  event_type: StaffNoteEventType;
  created_at: string;
  actor_account_id: string | null;
  actor_first_name: string | null;
  actor_last_name: string | null;
  note_id: string | null;
  body_preview: string | null;
  from_body: string | null;
  to_body: string | null;
  delete_reason: string | null;
}

interface StaffNotesResult {
  notes: StaffNoteRow[];
  events: StaffNoteEvent[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Joined-account shape Supabase returns. Always a single row in
// practice (notes have one author / one deleter), but the typing
// honours the "could be array" Supabase quirk.
type JoinedAccount =
  | { first_name: string | null; last_name: string | null }
  | { first_name: string | null; last_name: string | null }[]
  | null;

function pickAccount(a: JoinedAccount): { first_name: string | null; last_name: string | null } | null {
  if (!a) return null;
  return Array.isArray(a) ? a[0] ?? null : a;
}

export function useStaffNotes(appointmentId: string | null): StaffNotesResult {
  const [notes, setNotes] = useState<StaffNoteRow[]>([]);
  const [events, setEvents] = useState<StaffNoteEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!appointmentId) {
      setNotes([]);
      setEvents([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);

      const notesQuery = supabase
        .from('lng_appointment_staff_notes')
        .select(
          'id, appointment_id, body, created_at, updated_at, author_account_id, deleted_at, delete_reason, deleted_by_account_id, author:accounts!author_account_id ( first_name, last_name ), deleter:accounts!deleted_by_account_id ( first_name, last_name )',
        )
        .eq('appointment_id', appointmentId)
        .order('created_at', { ascending: false });

      const eventsQuery = supabase
        .from('patient_events')
        .select(
          'id, event_type, created_at, actor_account_id, payload, actor:accounts!actor_account_id ( first_name, last_name )',
        )
        .in('event_type', ['staff_note_added', 'staff_note_amended', 'staff_note_deleted'])
        .filter('payload->>appointment_id', 'eq', appointmentId)
        .order('created_at', { ascending: false });

      const [notesRes, eventsRes] = await Promise.all([notesQuery, eventsQuery]);
      if (cancelled) return;

      if (notesRes.error) {
        setError(notesRes.error.message);
        setLoading(false);
        return;
      }
      if (eventsRes.error) {
        setError(eventsRes.error.message);
        setLoading(false);
        return;
      }

      const mappedNotes: StaffNoteRow[] = (notesRes.data ?? []).map((r) => {
        const raw = r as {
          id: string;
          appointment_id: string;
          body: string;
          created_at: string;
          updated_at: string;
          author_account_id: string | null;
          deleted_at: string | null;
          delete_reason: string | null;
          deleted_by_account_id: string | null;
          author: JoinedAccount;
          deleter: JoinedAccount;
        };
        const author = pickAccount(raw.author);
        const deleter = pickAccount(raw.deleter);
        return {
          id: raw.id,
          appointment_id: raw.appointment_id,
          body: raw.body,
          created_at: raw.created_at,
          updated_at: raw.updated_at,
          author_account_id: raw.author_account_id,
          author_first_name: author?.first_name ?? null,
          author_last_name: author?.last_name ?? null,
          deleted_at: raw.deleted_at,
          delete_reason: raw.delete_reason,
          deleted_by_account_id: raw.deleted_by_account_id,
          deleted_by_first_name: deleter?.first_name ?? null,
          deleted_by_last_name: deleter?.last_name ?? null,
        };
      });

      const mappedEvents: StaffNoteEvent[] = (eventsRes.data ?? []).map((r) => {
        const raw = r as {
          id: string;
          event_type: StaffNoteEventType;
          created_at: string;
          actor_account_id: string | null;
          actor: JoinedAccount;
          payload: {
            note_id?: string;
            body_preview?: string;
            from?: string | null;
            to?: string | null;
            body?: string;
            reason?: string;
          } | null;
        };
        const actor = pickAccount(raw.actor);
        const payload = raw.payload ?? {};
        return {
          id: raw.id,
          event_type: raw.event_type,
          created_at: raw.created_at,
          actor_account_id: raw.actor_account_id,
          actor_first_name: actor?.first_name ?? null,
          actor_last_name: actor?.last_name ?? null,
          note_id: payload.note_id ?? null,
          body_preview: payload.body_preview ?? null,
          from_body: payload.from ?? null,
          to_body: payload.to ?? null,
          delete_reason: payload.reason ?? null,
        };
      });

      setNotes(mappedNotes);
      setEvents(mappedEvents);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [appointmentId, tick]);

  // Cross-tab + multi-device refresh — any insert/update on the
  // notes table or a new audit event in patient_events bumps the
  // tick so the card stays current without a hard reload.
  useRealtimeRefresh(
    appointmentId
      ? [
          { table: 'lng_appointment_staff_notes' },
          { table: 'patient_events' },
        ]
      : [],
    refresh,
  );

  return { notes, events, loading, error, refresh };
}

// First non-blank N chars of a body, single-line. Used as the
// payload.body_preview field so the audit timeline can show a hint
// of what the note said without having to dereference the notes
// table on every render.
function bodyPreview(body: string, max = 80): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export async function addStaffNote(input: {
  appointmentId: string;
  patientId: string;
  body: string;
}): Promise<{ id: string }> {
  const trimmed = input.body.trim();
  if (trimmed.length === 0) throw new Error('Note body is empty.');

  const { data: authorIdRaw } = await supabase.rpc('auth_account_id');
  const authorId = (authorIdRaw as string | null) ?? null;

  const { data: row, error } = await supabase
    .from('lng_appointment_staff_notes')
    .insert({
      appointment_id: input.appointmentId,
      author_account_id: authorId,
      body: trimmed,
    })
    .select('id')
    .single();
  if (error || !row) throw new Error(error?.message ?? 'Could not add note.');

  const noteId = (row as { id: string }).id;
  await supabase.from('patient_events').insert({
    patient_id: input.patientId,
    event_type: 'staff_note_added',
    actor_account_id: authorId,
    payload: {
      appointment_id: input.appointmentId,
      note_id: noteId,
      body_preview: bodyPreview(trimmed),
    },
  });

  return { id: noteId };
}

export async function amendStaffNote(input: {
  noteId: string;
  appointmentId: string;
  patientId: string;
  body: string;
}): Promise<void> {
  const trimmed = input.body.trim();
  if (trimmed.length === 0) throw new Error('Note body is empty.');

  // Read the current body so the audit row records what actually
  // changed. Skipping this would leave the timeline with a "from:
  // unknown" payload that no one can reconstruct after the row is
  // overwritten.
  const { data: existing, error: readErr } = await supabase
    .from('lng_appointment_staff_notes')
    .select('body, deleted_at')
    .eq('id', input.noteId)
    .maybeSingle();
  if (readErr) throw new Error(`Could not read note: ${readErr.message}`);
  if (!existing) throw new Error('Note not found.');
  const exRow = existing as { body: string; deleted_at: string | null };
  if (exRow.deleted_at) throw new Error('That note has already been deleted.');
  if (exRow.body === trimmed) return;

  const { error: updateErr } = await supabase
    .from('lng_appointment_staff_notes')
    .update({ body: trimmed })
    .eq('id', input.noteId);
  if (updateErr) throw new Error(`Could not save amend: ${updateErr.message}`);

  const { data: actorIdRaw } = await supabase.rpc('auth_account_id');
  const actorId = (actorIdRaw as string | null) ?? null;
  await supabase.from('patient_events').insert({
    patient_id: input.patientId,
    event_type: 'staff_note_amended',
    actor_account_id: actorId,
    payload: {
      appointment_id: input.appointmentId,
      note_id: input.noteId,
      from: exRow.body,
      to: trimmed,
    },
  });
}

export async function deleteStaffNote(input: {
  noteId: string;
  appointmentId: string;
  patientId: string;
  reason: string;
}): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length === 0) throw new Error('A reason is required to delete a note.');

  const { data: actorIdRaw } = await supabase.rpc('auth_account_id');
  const actorId = (actorIdRaw as string | null) ?? null;
  if (!actorId) throw new Error("Couldn't resolve the signed-in account.");

  // Capture the body before overwrite so the audit row stays useful
  // after a soft delete. Same reasoning as the amend path.
  const { data: existing, error: readErr } = await supabase
    .from('lng_appointment_staff_notes')
    .select('body, deleted_at')
    .eq('id', input.noteId)
    .maybeSingle();
  if (readErr) throw new Error(`Could not read note: ${readErr.message}`);
  if (!existing) throw new Error('Note not found.');
  const exRow = existing as { body: string; deleted_at: string | null };
  if (exRow.deleted_at) throw new Error('That note has already been deleted.');

  const { error: updateErr } = await supabase
    .from('lng_appointment_staff_notes')
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by_account_id: actorId,
      delete_reason: reason,
    })
    .eq('id', input.noteId);
  if (updateErr) throw new Error(`Could not delete: ${updateErr.message}`);

  await supabase.from('patient_events').insert({
    patient_id: input.patientId,
    event_type: 'staff_note_deleted',
    actor_account_id: actorId,
    payload: {
      appointment_id: input.appointmentId,
      note_id: input.noteId,
      body: exRow.body,
      reason,
    },
  });
}

// Used by the card's byline + the audit timeline. Returns first
// name where possible, full name where both halves are present,
// "Unknown" when nothing's available (backfill rows, deleted
// accounts).
export function formatAuthor(first: string | null, last: string | null): string {
  const f = first?.trim() ?? '';
  const l = last?.trim() ?? '';
  if (f && l) return `${f} ${l}`;
  if (f) return f;
  if (l) return l;
  return 'Unknown';
}
