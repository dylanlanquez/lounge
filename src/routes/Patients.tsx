import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ChevronRight, Search } from 'lucide-react';
import { Avatar, EmptyState, Skeleton } from '../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { properCase } from '../lib/queries/appointments.ts';
import { usePatientList, type PatientListRow } from '../lib/queries/patients.ts';

// Patients route — view-only directory. Calm and uncluttered: title +
// search at the top, hairline-separated rows beneath. No outer card
// (the page background already gives the surface depth via the rest
// of the chrome). No column headers — every row is the same shape,
// so a header strip would just add chrome. Empty fields are dropped
// from the metadata line rather than rendered as `—`, keeping the
// list visually quiet on patients with thin records.
export function Patients() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile(640);
  const [term, setTerm] = useState('');
  const { data, loading, error, hasMore } = usePatientList(term);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  const trimmed = term.trim();

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: isMobile ? theme.space[4] : theme.space[6],
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + ${isMobile ? theme.space[4] : theme.space[6]}px + env(safe-area-inset-top, 0px))`,
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${isMobile ? theme.space[6] : theme.space[8]}px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: theme.space[3],
            marginBottom: theme.space[4],
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: isMobile ? theme.type.size.xl : theme.type.size.xxl,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            Patients
          </h1>
          <PatientCount loading={loading} count={data.length} hasMore={hasMore} term={trimmed} />
        </div>

        <SearchInput value={term} onChange={setTerm} />

        <div style={{ marginTop: theme.space[4] }}>
          {error ? (
            <p style={{ color: theme.color.alert, margin: 0 }}>Could not load patients: {error}</p>
          ) : loading && data.length === 0 ? (
            <SkeletonList />
          ) : data.length === 0 ? (
            <div style={{ paddingTop: theme.space[6] }}>
              <EmptyState
                title={trimmed.length > 0 ? 'No patients match' : 'No patients yet'}
                description={
                  trimmed.length > 0
                    ? 'Try a different name, phone, or reference.'
                    : 'Patients are created via walk-in or arrival flows.'
                }
              />
            </div>
          ) : (
            <PatientList data={data} onPick={(id) => navigate(`/patient/${id}`)} />
          )}
        </div>
      </div>
    </main>
  );
}

function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // Custom inline search input — borderless, sat directly on the
  // page background. Reusing the global Input would force the
  // bordered "field" treatment, which competes with the patient rows
  // below for visual weight. The search is *part* of the page chrome
  // here, not a form field.
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        height: 44,
        paddingLeft: theme.space[4],
        paddingRight: theme.space[4],
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        cursor: 'text',
      }}
    >
      <Search size={16} color={theme.color.inkSubtle} aria-hidden style={{ flexShrink: 0 }} />
      <input
        type="search"
        placeholder="Search by name, phone, email or ref"
        aria-label="Search patients"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        style={{
          flex: 1,
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          outline: 'none',
          fontSize: theme.type.size.base,
          color: theme.color.ink,
          fontFamily: 'inherit',
          padding: 0,
          minWidth: 0,
        }}
      />
    </label>
  );
}

function PatientCount({
  loading,
  count,
  hasMore,
  term,
}: {
  loading: boolean;
  count: number;
  hasMore: boolean;
  term: string;
}) {
  if (loading && count === 0) return <span aria-hidden style={{ minWidth: 56 }} />;
  // Quiet right-aligned count. The full instructional copy has gone;
  // staff understand the bar from the input alone, the count is
  // status not narration.
  const label = term.length > 0 ? `${count}` : `${count}${hasMore ? '+' : ''}`;
  return (
    <span
      aria-live="polite"
      title={
        hasMore
          ? 'Refine the search to narrow the list. Showing the first 50.'
          : `${count} patient${count === 1 ? '' : 's'}.`
      }
      style={{
        fontSize: theme.type.size.sm,
        color: theme.color.inkMuted,
        fontVariantNumeric: 'tabular-nums',
        fontWeight: theme.type.weight.medium,
      }}
    >
      {label}
    </span>
  );
}

function SkeletonList() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[3],
            padding: `${theme.space[3]}px 0`,
            borderBottom: `1px solid ${theme.color.border}`,
          }}
        >
          <Skeleton height={36} width={36} radius={999} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Skeleton height={14} width="40%" radius={4} />
            <Skeleton height={12} width="60%" radius={4} />
          </div>
        </div>
      ))}
    </div>
  );
}

function PatientList({ data, onPick }: { data: PatientListRow[]; onPick: (id: string) => void }) {
  return (
    <ul
      role="list"
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        // Top hairline so the first row reads as part of the list,
        // not floating above an open void.
        borderTop: `1px solid ${theme.color.border}`,
      }}
    >
      {data.map((p) => (
        <li key={p.id}>
          <PatientRow patient={p} onPick={() => onPick(p.id)} />
        </li>
      ))}
    </ul>
  );
}

function PatientRow({ patient, onPick }: { patient: PatientListRow; onPick: () => void }) {
  const [hover, setHover] = useState(false);
  const fullName = displayName(patient);
  // Build a single muted metadata line. Empty values are dropped
  // entirely so a thin record reads as one short line, not a forest
  // of em-dashes. Order: internal ref → LWO ref → phone → registered
  // (most-stable identifier first, longest-changing last).
  const meta: string[] = [];
  if (patient.internal_ref) meta.push(patient.internal_ref);
  if (patient.lwo_ref) meta.push(patient.lwo_ref);
  if (patient.phone) meta.push(patient.phone);
  if (patient.registered_at) {
    const d = new Date(patient.registered_at);
    if (!Number.isNaN(d.getTime())) {
      meta.push(`Registered ${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`);
    }
  }

  return (
    <button
      type="button"
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: 'none',
        width: '100%',
        textAlign: 'left',
        background: hover ? theme.color.surface : 'transparent',
        border: 'none',
        borderBottom: `1px solid ${theme.color.border}`,
        padding: `${theme.space[3]}px ${theme.space[3]}px`,
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[4],
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <Avatar name={fullName} size="md" />
      <div style={{ flex: 1, minWidth: 0 }}>
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
          {fullName}
        </p>
        {meta.length > 0 ? (
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              fontVariantNumeric: 'tabular-nums',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {meta.join(' · ')}
          </p>
        ) : null}
      </div>
      <ChevronRight
        size={18}
        color={hover ? theme.color.ink : theme.color.inkSubtle}
        aria-hidden
        style={{ flexShrink: 0, transition: `color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}` }}
      />
    </button>
  );
}

function displayName(p: PatientListRow): string {
  const first = properCase(p.first_name);
  const last = properCase(p.last_name);
  return `${first} ${last}`.trim() || 'Unnamed patient';
}
