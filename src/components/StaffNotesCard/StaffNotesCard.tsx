import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Plus, StickyNote, Trash2 } from 'lucide-react';
import { BottomSheet, Button, Card, Skeleton, Toast } from '../index.ts';
import { theme } from '../../theme/index.ts';
import {
  addStaffNote,
  amendStaffNote,
  deleteStaffNote,
  formatAuthor,
  useStaffNotes,
  type StaffNoteEvent,
  type StaffNoteRow,
} from '../../lib/queries/appointmentStaffNotes.ts';
import { formatRelativeShort } from '../../lib/queries/notifications.ts';
import { logFailure } from '../../lib/failureLog.ts';

// Per-appointment staff notes card. Multi-note, audited, soft-delete.
// Drops in wherever AppointmentNotesHero used to live (Appointment
// detail + Visit detail) and reads from lng_appointment_staff_notes
// via useStaffNotes.
//
// Layout pattern matches the surrounding cards (Booking details,
// Intake answers) — Card padding="lg", small circled icon, title,
// sm body. Disclosure pattern keeps the surface compact:
//
//   * latest note always visible
//   * older notes collapsed under "View N older notes"
//   * full audit log collapsed under "History (N entries)"
//
// Author bylines render from the joined accounts row at fetch time
// (see queries/appointmentStaffNotes.ts); the card never parses
// "From X:" out of the body.

export interface StaffNotesCardProps {
  appointmentId: string;
  patientId: string | null;
}

type ComposerMode =
  | { kind: 'idle' }
  | { kind: 'adding' }
  | { kind: 'amending'; noteId: string };

export function StaffNotesCard({ appointmentId, patientId }: StaffNotesCardProps) {
  const { notes, events, loading, error, refresh } = useStaffNotes(appointmentId);

  const [composer, setComposer] = useState<ComposerMode>({ kind: 'idle' });
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StaffNoteRow | null>(null);
  const [toast, setToast] = useState<
    | { tone: 'success' | 'error'; title: string; description?: string }
    | null
  >(null);

  const activeNotes = useMemo(() => notes.filter((n) => !n.deleted_at), [notes]);
  const latest = activeNotes[0] ?? null;
  const older = activeNotes.slice(1);

  const handleSaveComposer = async () => {
    if (saving || !patientId) return;
    const body = draft.trim();
    if (body.length === 0) return;
    setSaving(true);
    try {
      if (composer.kind === 'adding') {
        await addStaffNote({ appointmentId, patientId, body });
        setToast({ tone: 'success', title: 'Note added' });
      } else if (composer.kind === 'amending') {
        await amendStaffNote({ noteId: composer.noteId, appointmentId, patientId, body });
        setToast({ tone: 'success', title: 'Note updated' });
      }
      setComposer({ kind: 'idle' });
      setDraft('');
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save note.';
      await logFailure({
        source: 'StaffNotesCard.saveComposer',
        severity: 'error',
        message,
        context: { appointmentId, composerKind: composer.kind },
      });
      setToast({ tone: 'error', title: 'Could not save note', description: message });
    } finally {
      setSaving(false);
    }
  };

  const handleCancelComposer = () => {
    setComposer({ kind: 'idle' });
    setDraft('');
  };

  const startAdd = () => {
    setComposer({ kind: 'adding' });
    setDraft('');
  };

  const startAmend = (note: StaffNoteRow) => {
    setComposer({ kind: 'amending', noteId: note.id });
    setDraft(note.body);
  };

  const startDelete = (note: StaffNoteRow) => {
    setDeleteTarget(note);
  };

  const handleConfirmDelete = async (reason: string) => {
    if (!deleteTarget || !patientId) return;
    try {
      await deleteStaffNote({
        noteId: deleteTarget.id,
        appointmentId,
        patientId,
        reason,
      });
      setDeleteTarget(null);
      setToast({ tone: 'success', title: 'Note deleted' });
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not delete note.';
      await logFailure({
        source: 'StaffNotesCard.confirmDelete',
        severity: 'error',
        message,
        context: { appointmentId, noteId: deleteTarget.id },
      });
      setToast({ tone: 'error', title: 'Could not delete note', description: message });
    }
  };

  return (
    <Card padding="lg">
      <Header onAdd={startAdd} addDisabled={composer.kind !== 'idle' || saving || !patientId} />

      {loading ? (
        <Skeleton height={18} radius={theme.radius.input} />
      ) : error ? (
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert }}>
          Couldn't load notes: {error}
        </p>
      ) : activeNotes.length === 0 && composer.kind !== 'adding' ? (
        <EmptyState />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          {latest ? (
            <NoteRow
              note={latest}
              isLatest
              composer={composer}
              draft={draft}
              saving={saving}
              onDraftChange={setDraft}
              onSave={handleSaveComposer}
              onCancel={handleCancelComposer}
              onAmend={() => startAmend(latest)}
              onDelete={() => startDelete(latest)}
            />
          ) : null}

          {older.length > 0 ? (
            <DisclosureToggle
              open={showOlder}
              onToggle={() => setShowOlder((v) => !v)}
              label={`View ${older.length} older ${older.length === 1 ? 'note' : 'notes'}`}
            />
          ) : null}

          {showOlder
            ? older.map((n) => (
                <NoteRow
                  key={n.id}
                  note={n}
                  isLatest={false}
                  composer={composer}
                  draft={draft}
                  saving={saving}
                  onDraftChange={setDraft}
                  onSave={handleSaveComposer}
                  onCancel={handleCancelComposer}
                  onAmend={() => startAmend(n)}
                  onDelete={() => startDelete(n)}
                />
              ))
            : null}

          {composer.kind === 'adding' ? (
            <Composer
              placeholder="What should the clinic team know about this appointment?"
              value={draft}
              saving={saving}
              onChange={setDraft}
              onSave={handleSaveComposer}
              onCancel={handleCancelComposer}
            />
          ) : null}

          {events.length > 0 ? (
            <DisclosureToggle
              open={showHistory}
              onToggle={() => setShowHistory((v) => !v)}
              label={`History (${events.length} ${events.length === 1 ? 'entry' : 'entries'})`}
            />
          ) : null}

          {showHistory ? <HistoryList events={events} /> : null}
        </div>
      )}

      <DeleteNoteSheet
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
      />

      {toast ? (
        <Toast
          tone={toast.tone}
          title={toast.title}
          description={toast.description}
          onDismiss={() => setToast(null)}
        />
      ) : null}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────
// Pieces
// ─────────────────────────────────────────────────────────────────

function Header({ onAdd, addDisabled }: { onAdd: () => void; addDisabled: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        marginBottom: theme.space[4],
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: 30,
            height: 30,
            borderRadius: theme.radius.pill,
            background: theme.color.accentBg,
            color: theme.color.accent,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <StickyNote size={15} aria-hidden />
        </span>
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Staff notes
        </h3>
      </div>
      <Button variant="tertiary" size="sm" onClick={onAdd} disabled={addDisabled}>
        <Plus size={14} aria-hidden />
        Add note
      </Button>
    </div>
  );
}

function EmptyState() {
  return (
    <p
      style={{
        margin: 0,
        fontSize: theme.type.size.sm,
        color: theme.color.inkMuted,
        fontStyle: 'italic',
        lineHeight: theme.type.leading.snug,
      }}
    >
      No notes yet. Add one if there's something the clinic team must notice about this appointment.
    </p>
  );
}

interface NoteRowProps {
  note: StaffNoteRow;
  isLatest: boolean;
  composer: ComposerMode;
  draft: string;
  saving: boolean;
  onDraftChange: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onAmend: () => void;
  onDelete: () => void;
}

function NoteRow({
  note,
  isLatest,
  composer,
  draft,
  saving,
  onDraftChange,
  onSave,
  onCancel,
  onAmend,
  onDelete,
}: NoteRowProps) {
  const isAmending = composer.kind === 'amending' && composer.noteId === note.id;
  const author = formatAuthor(note.author_first_name, note.author_last_name, note.author_name);
  const when = formatRelativeShort(note.created_at);

  if (isAmending) {
    return (
      <Composer
        placeholder="Update this note."
        value={draft}
        saving={saving}
        onChange={onDraftChange}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  // Older notes get a subtle left border so they read as part of the
  // list without competing with the latest. Latest sits on the card
  // directly with no extra chrome.
  const wrapperStyle: React.CSSProperties = isLatest
    ? {}
    : {
        paddingLeft: theme.space[3],
        borderLeft: `2px solid ${theme.color.border}`,
      };

  return (
    <div style={wrapperStyle}>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
          lineHeight: theme.type.leading.snug,
          whiteSpace: 'pre-wrap',
        }}
      >
        {note.body}
      </p>
      <div
        style={{
          marginTop: theme.space[2],
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[3],
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
          }}
        >
          by {author} · {when}
        </span>
        <div style={{ display: 'inline-flex', gap: theme.space[1] }}>
          <IconPill
            label="Amend"
            icon={<Pencil size={12} aria-hidden />}
            onClick={onAmend}
            disabled={composer.kind !== 'idle'}
          />
          <IconPill
            label="Delete"
            icon={<Trash2 size={12} aria-hidden />}
            onClick={onDelete}
            disabled={composer.kind !== 'idle'}
            tone="alert"
          />
        </div>
      </div>
    </div>
  );
}

function IconPill({
  label,
  icon,
  onClick,
  disabled,
  tone,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'alert';
}) {
  const color = tone === 'alert' ? theme.color.alert : theme.color.inkMuted;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        appearance: 'none',
        cursor: disabled ? 'default' : 'pointer',
        background: 'transparent',
        border: `1px solid ${theme.color.border}`,
        color,
        padding: `${theme.space[1]}px ${theme.space[2]}px`,
        borderRadius: theme.radius.pill,
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[1],
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.medium,
        opacity: disabled ? 0.5 : 1,
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.borderColor = color;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = theme.color.border;
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

interface ComposerProps {
  placeholder: string;
  value: string;
  saving: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function Composer({ placeholder, value, saving, onChange, onSave, onCancel }: ComposerProps) {
  const canSave = value.trim().length > 0 && !saving;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={saving}
        autoFocus
        rows={3}
        placeholder={placeholder}
        style={{
          fontFamily: 'inherit',
          fontSize: theme.type.size.sm,
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.input,
          padding: theme.space[3],
          color: theme.color.ink,
          background: theme.color.surface,
          outline: 'none',
          resize: 'vertical',
          lineHeight: theme.type.leading.relaxed,
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[2] }}>
        <Button variant="tertiary" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onSave}
          loading={saving}
          disabled={!canSave}
        >
          {saving ? 'Saving…' : 'Save note'}
        </Button>
      </div>
    </div>
  );
}

function DisclosureToggle({
  open,
  onToggle,
  label,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        appearance: 'none',
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        color: theme.color.inkMuted,
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.medium,
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[1],
        alignSelf: 'flex-start',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = theme.color.ink;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = theme.color.inkMuted;
      }}
    >
      {open ? (
        <ChevronDown size={14} aria-hidden />
      ) : (
        <ChevronRight size={14} aria-hidden />
      )}
      <span>{label}</span>
    </button>
  );
}

function HistoryList({ events }: { events: StaffNoteEvent[] }) {
  return (
    <ol
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[3],
        borderTop: `1px dashed ${theme.color.border}`,
        paddingTop: theme.space[3],
      }}
    >
      {events.map((ev) => (
        <li key={ev.id}>
          <HistoryRow event={ev} />
        </li>
      ))}
    </ol>
  );
}

function HistoryRow({ event }: { event: StaffNoteEvent }) {
  const actor = formatAuthor(event.actor_first_name, event.actor_last_name);
  const when = formatRelativeShort(event.created_at);
  const headline = describeEvent(event, actor);
  return (
    <div>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.xs,
          color: theme.color.ink,
          lineHeight: theme.type.leading.snug,
        }}
      >
        {headline}
      </p>
      <p
        style={{
          margin: `${theme.space[1]}px 0 0`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        {when}
        {event.event_type === 'staff_note_deleted' && event.delete_reason
          ? ` · reason: ${event.delete_reason}`
          : null}
      </p>
    </div>
  );
}

function describeEvent(event: StaffNoteEvent, actor: string): string {
  switch (event.event_type) {
    case 'staff_note_added':
      return `${actor} added a note`;
    case 'staff_note_amended':
      return `${actor} amended a note`;
    case 'staff_note_deleted':
      return `${actor} deleted a note`;
    default:
      return `${actor} updated a note`;
  }
}

// ── Delete confirmation sheet ─────────────────────────────────────

function DeleteNoteSheet({
  target,
  onClose,
  onConfirm,
}: {
  target: StaffNoteRow | null;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = !!target;
  const trimmed = reason.trim();
  const canDelete = trimmed.length > 0 && !saving;

  const handleConfirm = async () => {
    if (!canDelete) return;
    setSaving(true);
    setError(null);
    try {
      await onConfirm(trimmed);
      setReason('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete.');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (saving) return;
    setReason('');
    setError(null);
    onClose();
  };

  const author = target ? formatAuthor(target.author_first_name, target.author_last_name, target.author_name) : '';
  const bodyPreview = target?.body ?? '';

  return (
    <BottomSheet
      open={open}
      onClose={handleClose}
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[3] }}>
          <span
            aria-hidden
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: theme.radius.pill,
              background: 'transparent',
              border: `1px solid ${theme.color.alert}`,
              color: theme.color.alert,
              flexShrink: 0,
            }}
          >
            <Trash2 size={16} aria-hidden />
          </span>
          Delete note
        </span>
      }
      description={target ? `Originally added by ${author}. This can't be undone.` : null}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[2] }}>
          <Button variant="tertiary" size="md" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleConfirm}
            loading={saving}
            disabled={!canDelete}
            style={{
              background: theme.color.alert,
              color: theme.color.surface,
            }}
          >
            {saving ? 'Deleting…' : 'Delete note'}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        <div
          style={{
            background: theme.color.bg,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.input,
            padding: theme.space[3],
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            whiteSpace: 'pre-wrap',
            lineHeight: theme.type.leading.snug,
            maxHeight: 200,
            overflowY: 'auto',
          }}
        >
          {bodyPreview}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          <label
            htmlFor="staff-note-delete-reason"
            style={{
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.medium,
              color: theme.color.ink,
            }}
          >
            Reason for deletion
          </label>
          <textarea
            id="staff-note-delete-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={saving}
            rows={3}
            placeholder="Required. Helps the audit trail show why this note was removed."
            style={{
              fontFamily: 'inherit',
              fontSize: theme.type.size.sm,
              border: `1px solid ${theme.color.border}`,
              borderRadius: theme.radius.input,
              padding: theme.space[3],
              color: theme.color.ink,
              background: theme.color.surface,
              outline: 'none',
              resize: 'vertical',
              lineHeight: theme.type.leading.relaxed,
            }}
          />
          {error ? (
            <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.alert }}>
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </BottomSheet>
  );
}
