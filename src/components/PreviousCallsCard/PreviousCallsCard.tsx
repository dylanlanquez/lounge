import { useNavigate } from 'react-router-dom';
import { ChevronRight, History } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { usePatientVoiceCallHistory } from '../../lib/queries/voiceCallLog.ts';
import { OutcomeBadge } from '../CallOutcomeSheet/OutcomeBadge.tsx';

// A compact pointer to the rest of this patient's calls — count up
// front, the most recent one previewed, tap through for the whole
// history. Renders nothing when there is no history: a "Previous
// calls (0)" row would just be noise on a patient's first call.
export function PreviousCallsCard({
  patientId,
  patientName,
  excludeAppointmentId,
}: {
  patientId: string;
  patientName: string;
  excludeAppointmentId: string;
}) {
  const navigate = useNavigate();
  const { data, loading } = usePatientVoiceCallHistory(patientId, excludeAppointmentId);

  if (loading || data.length === 0) return null;

  const [mostRecent] = data;

  return (
    <button
      type="button"
      onClick={() =>
        navigate(`/patient/${patientId}/voice-calls`, {
          state: { patientId, patientName },
        })
      }
      style={{
        appearance: 'none',
        width: '100%',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[4],
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        boxShadow: theme.shadow.card,
        fontFamily: 'inherit',
        cursor: 'pointer',
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = theme.category.voiceCall;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = theme.color.border;
      }}
    >
      <span
        aria-hidden
        style={{
          width: 36,
          height: 36,
          borderRadius: theme.radius.pill,
          background: `${theme.category.voiceCall}1F`,
          color: theme.category.voiceCall,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <History size={17} aria-hidden />
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
          <span style={{ fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
            Previous calls
          </span>
          <span
            aria-hidden
            style={{
              minWidth: 20,
              height: 20,
              padding: `0 ${theme.space[1]}px`,
              borderRadius: theme.radius.pill,
              background: theme.color.bg,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.semibold,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {data.length}
          </span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
          {formatShortDate(mostRecent!.startAt)}
          {mostRecent!.latestOutcome ? <OutcomeBadge outcome={mostRecent!.latestOutcome} /> : <span>Booked</span>}
        </span>
      </span>
      <ChevronRight size={18} color={theme.color.inkSubtle} aria-hidden style={{ flexShrink: 0 }} />
    </button>
  );
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
