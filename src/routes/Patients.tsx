import { type CSSProperties, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { Avatar, EmptyState, Skeleton, StickyPageHeader } from '../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { properCase } from '../lib/queries/appointments.ts';
import {
  PATIENT_LIST_PAGE_SIZE,
  usePatientList,
  type PatientListRow,
} from '../lib/queries/patients.ts';

// Patients route — view-only directory.
//
// Compact pinned header (page title + search input) so both stay
// reachable as the list scrolls. Rows render the bare minimum: avatar,
// name, MP number — anything more competes with the list shape and
// makes scanning harder. Pagination at the bottom: 50 per page, next /
// previous, page indicator. Search resets to page 0.
export function Patients() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile(640);
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(0);
  const { data, loading, error, hasMore } = usePatientList(term, page);

  // Search resets paging — the user typing a name is starting from the
  // top of the result set, not picking up where they left off.
  useEffect(() => {
    setPage(0);
  }, [term]);

  // Scroll to the top of the list whenever the page changes (next /
  // prev). The route doesn't change so the App-level ScrollToTop
  // doesn't fire here — handle it ourselves.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  const trimmed = term.trim();
  const outerPaddingX = isMobile ? theme.space[4] : theme.space[6];
  const innerMaxWidth = theme.layout.pageMaxWidth;

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: `0 ${outerPaddingX}px`,
        // Breathing room above the title — clears the fixed kiosk
        // status bar plus a comfortable spacing token so the title
        // doesn't read as crammed against the device chrome.
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + env(safe-area-inset-top, 0px) + ${theme.space[5]}px)`,
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${isMobile ? theme.space[6] : theme.space[8]}px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div style={{ maxWidth: innerMaxWidth, margin: '0 auto' }}>
        <StickyPageHeader
          title="Patients"
          meta={
            <PatientCount loading={loading} count={data.length} hasMore={hasMore} term={trimmed} page={page} />
          }
          body={<SearchInput value={term} onChange={setTerm} />}
          outerPaddingX={outerPaddingX}
          innerMaxWidth={innerMaxWidth}
          bodyMarginBottom={theme.space[3]}
        />

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
          <>
            <PatientList
              data={data}
              onPick={(p) =>
                navigate(`/patient/${p.id}`, {
                  state: { patientName: displayName(p) },
                })
              }
            />
            <Pagination
              page={page}
              hasMore={hasMore}
              loading={loading}
              onPrev={() => setPage((p) => Math.max(0, p - 1))}
              onNext={() => setPage((p) => p + 1)}
            />
          </>
        )}
      </div>
    </main>
  );
}

function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
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
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          style={{
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            color: theme.color.inkSubtle,
            cursor: 'pointer',
            padding: theme.space[1],
            display: 'inline-flex',
          }}
        >
          <X size={16} />
        </button>
      ) : null}
    </label>
  );
}

function PatientCount({
  loading,
  count,
  hasMore,
  term,
  page,
}: {
  loading: boolean;
  count: number;
  hasMore: boolean;
  term: string;
  page: number;
}) {
  if (loading && count === 0) return <span aria-hidden style={{ minWidth: 56 }} />;
  // Show row range on the current page when not searching, e.g.
  // "1–50" / "51–100". Search results just count the matches.
  let label: string;
  if (term.length > 0) {
    label = `${count}${hasMore ? '+' : ''}`;
  } else {
    const start = page * PATIENT_LIST_PAGE_SIZE + 1;
    const end = page * PATIENT_LIST_PAGE_SIZE + count;
    label = count === 0 ? '0' : `${start}–${end}`;
  }
  return (
    <span
      aria-live="polite"
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

// Skeleton mirrors PatientRow exactly — same padding, gaps, avatar
// size (40, matching Avatar md), name + ref inline, trailing
// chevron — and renders PATIENT_LIST_PAGE_SIZE rows so the loading
// state's height matches the rendered page on data arrival. No
// layout jump.
function SkeletonList() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {Array.from({ length: PATIENT_LIST_PAGE_SIZE }).map((_, i) => (
        <div
          key={i}
          style={{
            padding: `${theme.space[3]}px ${theme.space[3]}px`,
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[4],
            borderBottom: `1px solid ${theme.color.border}`,
          }}
        >
          <Skeleton width={40} height={40} radius={999} />
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: theme.space[3],
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <Skeleton width="50%" height={16} radius={4} />
            </div>
            <Skeleton width={64} height={12} radius={4} />
          </div>
          <Skeleton width={18} height={18} radius={4} />
        </div>
      ))}
    </div>
  );
}

function PatientList({
  data,
  onPick,
}: {
  data: PatientListRow[];
  // Receives the full row so the caller can forward a preview name
  // through router state — keeps the profile breadcrumb from flashing
  // a placeholder while the patient query is in flight.
  onPick: (patient: PatientListRow) => void;
}) {
  return (
    <ul
      role="list"
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {data.map((p) => (
        <li key={p.id}>
          <PatientRow patient={p} onPick={() => onPick(p)} />
        </li>
      ))}
    </ul>
  );
}

function PatientRow({ patient, onPick }: { patient: PatientListRow; onPick: () => void }) {
  const [hover, setHover] = useState(false);
  const fullName = displayName(patient);

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
      <Avatar name={fullName} src={patient.avatar_data} size="md" />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          {fullName}
        </p>
        {patient.internal_ref ? (
          <span
            style={{
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              fontVariantNumeric: 'tabular-nums',
              flexShrink: 0,
            }}
          >
            {patient.internal_ref}
          </span>
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

function Pagination({
  page,
  hasMore,
  loading,
  onPrev,
  onNext,
}: {
  page: number;
  hasMore: boolean;
  loading: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const prevDisabled = page === 0 || loading;
  const nextDisabled = !hasMore || loading;
  return (
    <nav
      aria-label="Patient list pagination"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        padding: `${theme.space[5]}px 0 ${theme.space[3]}px`,
      }}
    >
      <button type="button" onClick={onPrev} disabled={prevDisabled} style={pageButton(prevDisabled)}>
        <ChevronLeft size={16} />
        <span>Previous</span>
      </button>
      <span
        style={{
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          fontVariantNumeric: 'tabular-nums',
          fontWeight: theme.type.weight.medium,
        }}
      >
        Page {page + 1}
      </span>
      <button type="button" onClick={onNext} disabled={nextDisabled} style={pageButton(nextDisabled)}>
        <span>Next</span>
        <ChevronRight size={16} />
      </button>
    </nav>
  );
}

function pageButton(disabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.space[1],
    padding: `${theme.space[2]}px ${theme.space[4]}px`,
    borderRadius: theme.radius.pill,
    border: `1px solid ${theme.color.border}`,
    background: theme.color.surface,
    color: disabled ? theme.color.inkSubtle : theme.color.ink,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    fontSize: theme.type.size.sm,
    fontWeight: theme.type.weight.medium,
    opacity: disabled ? 0.55 : 1,
  };
}

function displayName(p: PatientListRow): string {
  const first = properCase(p.first_name);
  const last = properCase(p.last_name);
  return `${first} ${last}`.trim() || 'Unnamed patient';
}
