import { useEffect, useState } from 'react';
import { CalendarClock, Pencil } from 'lucide-react';
import {
  BottomSheet,
  Button,
  DropdownSelect,
  InlineHint,
  Input,
  Section,
  StatusBanner,
  Toast,
} from '../index.ts';
import { theme } from '../../theme/index.ts';
import { editAppointment } from '../../lib/queries/editAppointment.ts';
import { useStaff } from '../../lib/queries/staff.ts';

// EditBookingSheet — in-place edit for a native (manual / native-
// source) Lounge appointment. The two non-time fields the staff
// most commonly want to change after a booking is in:
//
//   Notes                  internal context — wheelchair access,
//                          allergies the team should know about,
//                          paperwork the patient is bringing.
//   Staff                  who's taking the appointment. Optional
//                          on every booking; this is where staff
//                          assign or reassign a clinician after
//                          the fact.
//
// Time / date / service-type changes go through the reschedule
// flow because they re-trigger the conflict checker. Cancellation
// and no-show have their own dedicated paths. This sheet only
// touches fields that don't move the slot.
//
// Visual language matches NewBookingSheet / RescheduleSheet: title
// icon pill (Pencil), CurrentSlotSummary read-only card, Section
// headers with (i) tooltips, shared form primitives so the three
// sheets can't drift.

export interface EditBookingSheetProps {
  open: boolean;
  onClose: () => void;
  appointment: {
    id: string;
    patient_id: string;
    location_id: string;
    source: 'calendly' | 'manual' | 'native';
    start_at: string;
    end_at: string;
    notes: string | null;
    staff_account_id: string | null;
    patient_first_name: string | null;
    patient_last_name: string | null;
  };
  onSaved: () => void;
}

export function EditBookingSheet({
  open,
  onClose,
  appointment,
  onSaved,
}: EditBookingSheetProps) {
  // Treat the legacy "None" string the same as null/empty when
  // seeding — older rows have the literal word stored where null
  // would now live, and pre-filling that into the edit form would
  // make staff manually clear it before they could type real notes.
  const [notes, setNotes] = useState<string>(
    isMeaningfulNotes(appointment.notes) ? (appointment.notes as string) : '',
  );
  const [staffAccountId, setStaffAccountId] = useState<string>(
    appointment.staff_account_id ?? '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string } | null>(null);

  const staff = useStaff();

  // Re-seed the form whenever the sheet (re)opens with a different
  // appointment, otherwise stale values from a previous edit
  // session bleed in.
  useEffect(() => {
    if (!open) return;
    setNotes(isMeaningfulNotes(appointment.notes) ? (appointment.notes as string) : '');
    setStaffAccountId(appointment.staff_account_id ?? '');
    setError(null);
  }, [open, appointment.id, appointment.notes, appointment.staff_account_id]);

  // Compare against the meaningful-notes view of the seed value so
  // the legacy "None" doesn't count as a "no changes" no-op when
  // the user clears it.
  const seededNotes = isMeaningfulNotes(appointment.notes)
    ? (appointment.notes as string)
    : null;
  const noChanges =
    (notes.trim() || null) === seededNotes &&
    (staffAccountId || null) === (appointment.staff_account_id ?? null);

  const onSave = async () => {
    if (saving || noChanges) return;
    setError(null);
    setSaving(true);
    try {
      await editAppointment({
        appointmentId: appointment.id,
        notes: notes.trim() === '' ? null : notes,
        staffAccountId: staffAccountId || null,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save changes');
    } finally {
      setSaving(false);
    }
  };

  const patientName = composePatientName(
    appointment.patient_first_name,
    appointment.patient_last_name,
  );

  return (
    <>
      <BottomSheet
        open={open}
        onClose={onClose}
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
                background: theme.color.accentBg,
                color: theme.color.accent,
                flexShrink: 0,
              }}
            >
              <Pencil size={16} aria-hidden />
            </span>
            Edit appointment
          </span>
        }
        description={
          patientName ? (
            <span>
              Update notes and staff assignment for <strong>{patientName}</strong>'s
              appointment. To move the time, use Reschedule instead.
            </span>
          ) : (
            <span>
              Update notes and staff assignment. To move the time, use Reschedule instead.
            </span>
          )
        }
        footer={
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              alignItems: 'center',
              gap: theme.space[2],
            }}
          >
            <Button variant="tertiary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={onSave}
              disabled={saving || noChanges}
              loading={saving}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          <CurrentSlotSummary appointment={appointment} />

          {error ? (
            <StatusBanner tone="error" title="Couldn't save">
              {error}
            </StatusBanner>
          ) : null}

          <Section
            title="Notes"
            info="Free text shown on the schedule card and the patient profile. Use this for context the team should see at a glance, like wheelchair access, language needs, or allergies."
          >
            <Input
              aria-label="Notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. wheelchair access; bringing a translator; allergic to latex."
              disabled={saving}
            />
          </Section>

          <Section
            title="Staff"
            info="Optional. Assign or reassign the clinician taking this appointment. Leaving it open keeps the slot unassigned."
          >
            <DropdownSelect<string>
              ariaLabel="Staff member"
              value={staffAccountId}
              onChange={(v) => setStaffAccountId(v)}
              options={[
                { value: '', label: 'No specific staff' },
                ...staff.data
                  .filter((s) => s.status === 'active')
                  .map((s) => ({ value: s.account_id, label: s.display_name })),
              ]}
              placeholder={staff.loading ? 'Loading…' : 'No specific staff'}
            />
            {!staff.loading && staff.data.length === 0 ? (
              <InlineHint>
                No active staff members yet. Add them in Admin, Staff before assigning.
              </InlineHint>
            ) : null}
          </Section>
        </div>
      </BottomSheet>
      {toast ? (
        <Toast tone={toast.tone} title={toast.title} onDismiss={() => setToast(null)} />
      ) : null}
    </>
  );
}

// Read-only summary of the current slot — same visual language
// as RescheduleSheet so an operator hopping between flows sees a
// consistent "this is the booking you're editing" anchor.
function CurrentSlotSummary({
  appointment,
}: {
  appointment: EditBookingSheetProps['appointment'];
}) {
  const start = new Date(appointment.start_at);
  const end = new Date(appointment.end_at);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: theme.color.bg,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 32,
          height: 32,
          borderRadius: theme.radius.pill,
          background: theme.color.surface,
          color: theme.color.inkMuted,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          border: `1px solid ${theme.color.border}`,
        }}
      >
        <CalendarClock size={14} aria-hidden />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: theme.type.tracking.wide,
            color: theme.color.inkMuted,
            fontWeight: theme.type.weight.semibold,
          }}
        >
          Booked slot
        </p>
        <p
          style={{
            margin: '2px 0 0',
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatLongDate(start)} · {formatTime(start)} to {formatTime(end)}
        </p>
      </div>
    </div>
  );
}

// Helpers — duplicated from sibling sheets rather than extracted
// because they're 5-line pure formatters and centralising them
// would tie the sheets to evolve in lockstep on date display.

function formatLongDate(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function composePatientName(first: string | null, last: string | null): string | null {
  const f = first?.trim();
  const l = last?.trim();
  if (!f && !l) return null;
  return [f, l].filter(Boolean).join(' ');
}

// Notes column historically allowed the literal string "None" where
// null would now live. Treat that as no notes when seeding the form
// so the operator doesn't have to manually clear the placeholder
// before typing real notes.
function isMeaningfulNotes(notes: string | null): boolean {
  if (!notes) return false;
  const trimmed = notes.trim();
  if (!trimmed) return false;
  if (/^none$/i.test(trimmed)) return false;
  return true;
}
