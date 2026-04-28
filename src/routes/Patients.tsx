import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ChevronRight, Search } from 'lucide-react';
import { Card, EmptyState, Input, Skeleton } from '../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { properCase } from '../lib/queries/appointments.ts';
import { usePatientList, type PatientListRow } from '../lib/queries/patients.ts';

// Patients route — view-only directory. Search input pinned to the top
// of the card; results render as a table on desktop, stacked rows on
// mobile. Tapping a row drops into the patient profile. We do not
// expose any "create patient" affordance from here; Lounge creates
// patients through walk-in / arrival flows, not standalone.
export function Patients() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile(640);
  const [term, setTerm] = useState('');
  const { data, loading, error, hasMore } = usePatientList(term);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

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
        <h1
          style={{
            margin: 0,
            fontSize: isMobile ? theme.type.size.xl : theme.type.size.xxl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            marginBottom: theme.space[2],
          }}
        >
          Patients
        </h1>
        <p
          style={{
            margin: 0,
            color: theme.color.inkMuted,
            fontSize: theme.type.size.base,
            marginBottom: theme.space[5],
          }}
        >
          Browse the directory or filter by name, phone, email, internal ref or LWO ref.
        </p>

        <Card padding={isMobile ? 'md' : 'lg'}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
            <div style={{ position: 'relative' }}>
              <Search
                size={16}
                color={theme.color.inkSubtle}
                aria-hidden
                style={{
                  position: 'absolute',
                  left: theme.space[3],
                  top: '50%',
                  transform: 'translateY(-50%)',
                  pointerEvents: 'none',
                }}
              />
              <Input
                aria-label="Search patients"
                placeholder="Search by name, phone, email or ref"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                style={{ paddingLeft: theme.space[8] }}
              />
            </div>

            <Summary count={data.length} loading={loading} hasMore={hasMore} term={term} />

            {error ? (
              <p style={{ color: theme.color.alert, margin: 0 }}>Could not load patients: {error}</p>
            ) : loading && data.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                <Skeleton height={48} radius={12} />
                <Skeleton height={48} radius={12} />
                <Skeleton height={48} radius={12} />
              </div>
            ) : data.length === 0 ? (
              <EmptyState
                title={term.trim().length > 0 ? 'No patients match' : 'No patients yet'}
                description={
                  term.trim().length > 0
                    ? 'Try a different name, phone, or reference.'
                    : 'Patients are created via walk-in or arrival flows.'
                }
              />
            ) : isMobile ? (
              <PatientsList data={data} onPick={(id) => navigate(`/patient/${id}`)} />
            ) : (
              <PatientsTable data={data} onPick={(id) => navigate(`/patient/${id}`)} />
            )}
          </div>
        </Card>
      </div>
    </main>
  );
}

function Summary({
  count,
  loading,
  hasMore,
  term,
}: {
  count: number;
  loading: boolean;
  hasMore: boolean;
  term: string;
}) {
  if (loading && count === 0) return null;
  return (
    <p
      aria-live="polite"
      style={{
        margin: 0,
        fontSize: theme.type.size.sm,
        color: theme.color.inkMuted,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {count === 0
        ? '0 patients'
        : term.trim().length > 0
          ? `${count} match${count === 1 ? '' : 'es'}${hasMore ? ' (refine to see more)' : ''}`
          : `${count} patient${count === 1 ? '' : 's'}${hasMore ? ' shown — refine to find more' : ''}`}
    </p>
  );
}

function PatientsTable({ data, onPick }: { data: PatientListRow[]; onPick: (id: string) => void }) {
  const headerStyle: React.CSSProperties = {
    fontSize: theme.type.size.xs,
    fontWeight: theme.type.weight.semibold,
    color: theme.color.inkMuted,
    textTransform: 'uppercase',
    letterSpacing: theme.type.tracking.tight,
    textAlign: 'left',
    padding: `${theme.space[3]}px ${theme.space[3]}px`,
    background: theme.color.bg,
    borderTop: `1px solid ${theme.color.border}`,
    borderBottom: `1px solid ${theme.color.border}`,
  };
  const cellStyle: React.CSSProperties = {
    padding: `${theme.space[3]}px ${theme.space[3]}px`,
    fontSize: theme.type.size.sm,
    color: theme.color.ink,
    borderBottom: `1px solid ${theme.color.border}`,
    verticalAlign: 'middle',
  };
  const monoStack = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  return (
    <div style={{ overflowX: 'auto', margin: `0 -${theme.space[3]}px` }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={headerStyle}>Name</th>
            <th style={headerStyle}>Internal ref</th>
            <th style={headerStyle}>LWO ref</th>
            <th style={headerStyle}>Phone</th>
            <th style={headerStyle}>Registered</th>
            <th style={{ ...headerStyle, width: 32 }} aria-hidden />
          </tr>
        </thead>
        <tbody>
          {data.map((p) => (
            <tr
              key={p.id}
              onClick={() => onPick(p.id)}
              style={{ cursor: 'pointer' }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLTableRowElement).style.background = theme.color.bg;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
              }}
            >
              <td style={{ ...cellStyle, fontWeight: theme.type.weight.semibold }}>{displayName(p)}</td>
              <td style={{ ...cellStyle, fontFamily: monoStack, color: theme.color.inkMuted }}>
                {p.internal_ref ?? '—'}
              </td>
              <td style={{ ...cellStyle, fontFamily: monoStack, color: theme.color.inkMuted }}>
                {p.lwo_ref ?? '—'}
              </td>
              <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums', color: theme.color.inkMuted }}>
                {p.phone ?? '—'}
              </td>
              <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums', color: theme.color.inkMuted }}>
                {formatDate(p.registered_at)}
              </td>
              <td style={{ ...cellStyle, textAlign: 'right' }}>
                <ChevronRight size={16} color={theme.color.inkSubtle} aria-hidden />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PatientsList({ data, onPick }: { data: PatientListRow[]; onPick: (id: string) => void }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      {data.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            onClick={() => onPick(p.id)}
            style={{
              appearance: 'none',
              width: '100%',
              textAlign: 'left',
              padding: theme.space[3],
              borderRadius: theme.radius.card,
              border: `1px solid ${theme.color.border}`,
              background: theme.color.surface,
              cursor: 'pointer',
              fontFamily: 'inherit',
              display: 'flex',
              alignItems: 'center',
              gap: theme.space[3],
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.sm,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.ink,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {displayName(p)}
              </p>
              <p
                style={{
                  margin: `${theme.space[1]}px 0 0`,
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {[p.phone, p.internal_ref, p.lwo_ref].filter((s): s is string => !!s).join(' · ') || '—'}
              </p>
            </div>
            <ChevronRight size={16} color={theme.color.inkSubtle} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

function displayName(p: PatientListRow): string {
  const first = properCase(p.first_name);
  const last = properCase(p.last_name);
  return `${first} ${last}`.trim() || 'Unnamed patient';
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
