import { type CSSProperties, useDeferredValue, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  Clock,
  CreditCard,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Avatar, Card, EmptyState, Skeleton, StatusPill, StickyPageHeader } from '../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { ToothIcon } from '../components/Icons/ToothIcon.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { useNow } from '../lib/useNow.ts';
import { properCase } from '../lib/queries/appointments.ts';
import { formatPence } from '../lib/queries/carts.ts';
import {
  CLINIC_SECTION_LABELS,
  CLINIC_SECTION_ORDER,
  formatWaitingTime,
  slaStateForVisit,
  sortByWaitingDesc,
  useActiveVisitsBoard,
  type ClinicSectionKey,
  type EnrichedActiveVisit,
  type SlaState,
} from '../lib/queries/clinicBoard.ts';

// ─────────────────────────────────────────────────────────────────────────────
// In Clinic — live board of every active visit at this location.
//
// Reads from useActiveVisitsBoard which gives one fully enriched row per
// visit: patient identity, booking metadata, computed paid status,
// computed waiver status, plus a pre-built searchable index. The page
// orchestrates the visual: search at top, sections in fixed order
// (longest-waiting first within each), responsive card grid below.
//
// Sections render only when non-empty. Walk-ins and bookings are
// classified by the same enum (ClinicSectionKey) so a denture-repair
// walk-in and a denture-repair booking share a section.
// ─────────────────────────────────────────────────────────────────────────────

export function InClinic() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile(640);
  const { visits, loading, error } = useActiveVisitsBoard();
  const now = useNow(60_000);

  const [searchInput, setSearchInput] = useState('');
  const deferredSearch = useDeferredValue(searchInput).trim().toLowerCase();

  // Filter then group then sort. Pre-deferring the search keeps typing
  // smooth on a slow tablet — the filter waits for an idle frame.
  const filtered = useMemo(() => {
    if (!deferredSearch) return visits;
    return visits.filter((v) => v.searchable.includes(deferredSearch));
  }, [visits, deferredSearch]);

  const sections = useMemo<{ key: ClinicSectionKey; visits: EnrichedActiveVisit[] }[]>(() => {
    const buckets = new Map<ClinicSectionKey, EnrichedActiveVisit[]>();
    for (const v of filtered) {
      const list = buckets.get(v.bucket) ?? [];
      list.push(v);
      buckets.set(v.bucket, list);
    }
    return CLINIC_SECTION_ORDER.map((key) => ({
      key,
      visits: sortByWaitingDesc(buckets.get(key) ?? []),
    })).filter((s) => s.visits.length > 0);
  }, [filtered]);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  const totalActive = visits.length;
  const matched = filtered.length;
  const noResults = !!deferredSearch && matched === 0;

  const outerPaddingX = isMobile ? theme.space[4] : theme.space[6];
  const innerMaxWidth = theme.layout.pageMaxWidth;
  const countLabel = loading
    ? 'Loading…'
    : totalActive === 0
      ? '0'
      : deferredSearch
        ? `${matched} of ${totalActive}`
        : String(totalActive);

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
          title="In clinic"
          meta={
            <span
              aria-live="polite"
              style={{
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                fontVariantNumeric: 'tabular-nums',
                fontWeight: theme.type.weight.medium,
              }}
            >
              {countLabel}
            </span>
          }
          body={
            <SearchBar
              value={searchInput}
              onChange={setSearchInput}
              disabled={!loading && totalActive === 0}
            />
          }
          outerPaddingX={outerPaddingX}
          innerMaxWidth={innerMaxWidth}
        />

        {error ? (
          <Card padding="lg">
            <p style={{ color: theme.color.alert, margin: 0 }}>Could not load appointments: {error}</p>
          </Card>
        ) : loading ? (
          <LoadingGrid isMobile={isMobile} />
        ) : totalActive === 0 ? (
          <Card padding="lg">
            <EmptyState
              icon={<ToothIcon size={24} />}
              title="No one in clinic right now"
              description="Visits show up here as soon as you mark someone as arrived or start a walk-in."
            />
          </Card>
        ) : noResults ? (
          <Card padding="lg">
            <EmptyState
              icon={<Search size={24} />}
              title="No matches"
              description={`Nothing matches “${deferredSearch}”. Try a different name, phone number, or reference.`}
            />
          </Card>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[8] }}>
            {sections.map((s) => (
              <Section
                key={s.key}
                title={CLINIC_SECTION_LABELS[s.key]}
                count={s.visits.length}
                isMobile={isMobile}
              >
                {s.visits.map((v) => (
                  <ActiveVisitCard
                    key={v.id}
                    visit={v}
                    now={now}
                    onClick={() =>
                      navigate(`/visit/${v.id}`, {
                        state: {
                          from: 'in_clinic',
                          // Forward the row's denormalised patient name + opened_at
                          // so the visit page's breadcrumb renders both crumbs on
                          // first paint without any shimmer transition.
                          patientName: `${properCase(v.patient_first_name ?? '')} ${properCase(v.patient_last_name ?? '')}`.trim(),
                          visitOpenedAt: v.opened_at,
                        },
                      })
                    }
                  />
                ))}
              </Section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Search bar — outlined input with a leading magnifier and a trailing
// clear button. Reuses the page's surface tone, no new chrome.
// ─────────────────────────────────────────────────────────────────────────────

function SearchBar({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        height: 44,
        padding: `0 ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'text',
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      <Search size={18} color={theme.color.inkSubtle} aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder="Search by name, phone, email, JB, ref or appliance"
        disabled={disabled}
        aria-label="Search active appointments"
        style={{
          flex: 1,
          border: 'none',
          background: 'transparent',
          outline: 'none',
          fontFamily: 'inherit',
          fontSize: theme.type.size.base,
          color: theme.color.ink,
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

// ─────────────────────────────────────────────────────────────────────────────
// Section — sentence-case heading + count + hairline + responsive card
// grid. Light borders, generous gap, no heavy bg.
// ─────────────────────────────────────────────────────────────────────────────

function Section({
  title,
  count,
  isMobile,
  children,
}: {
  title: string;
  count: number;
  isMobile: boolean;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: theme.space[3],
          marginBottom: theme.space[4],
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
          }}
        >
          {title}
        </h2>
        <span
          aria-hidden
          style={{
            fontSize: theme.type.size.sm,
            color: theme.color.inkSubtle,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {count}
        </span>
        <span aria-hidden style={{ flex: 1, height: 1, background: theme.color.border }} />
      </header>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile
            ? '1fr'
            : 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: theme.space[3],
        }}
      >
        {children}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Card — square-ish tile with avatar + name, descriptor, waiting time,
// cost, and the two state pills (waiver, payment). Light border,
// hover lifts to ink.
// ─────────────────────────────────────────────────────────────────────────────

function ActiveVisitCard({
  visit,
  now,
  onClick,
}: {
  visit: EnrichedActiveVisit;
  now: Date;
  onClick: () => void;
}) {
  const name = displayName(visit);
  const minutesHere = Math.max(
    0,
    Math.floor((now.getTime() - new Date(visit.opened_at).getTime()) / 60_000)
  );
  const slaState = slaStateForVisit(minutesHere, visit.sla_target_minutes);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open ${name}, ${visit.descriptor || 'visit'}, here ${formatWaitingTime(minutesHere)}`}
      style={cardStyle}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = theme.color.ink;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = theme.color.border;
      }}
      onFocus={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = theme.color.ink;
      }}
      onBlur={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = theme.color.border;
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: theme.space[3] }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], minWidth: 0 }}>
          <Avatar
            src={visit.patient_avatar_data}
            name={name}
            size="md"
            badge={visit.status === 'in_progress' ? 'online' : null}
          />
          <div style={{ minWidth: 0 }}>
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.base,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                letterSpacing: theme.type.tracking.tight,
              }}
            >
              {name}
            </p>
            <p
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={visit.descriptor}
            >
              {visit.descriptor}
            </p>
          </div>
        </div>
        <WaitChip
          minutes={minutesHere}
          slaTargetMinutes={visit.sla_target_minutes}
          slaState={slaState}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: theme.space[3], marginTop: theme.space[5] }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
          <WaiverPill status={visit.waiver_status} />
          <PaymentPill done={visit.payment_done} status={visit.paid_status} />
        </div>
        <span
          style={{
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatCost(visit.amount_due_pence)}
        </span>
      </div>
    </button>
  );
}

// Counter chip on each visit card. Colour is driven by the SLA state
// when one applies; visits without an SLA target render neutral.
//   green — within 80% of target
//   amber — between 80% and 100%
//   red   — over target (breach)
//   none  — no SLA on the visit (legacy long-wait threshold removed
//           per Dylan's call: SLA config is the single source of
//           truth for urgency on the board)
const SLA_CHIP_TONE: Record<SlaState, { bg: string; fg: string }> = {
  none: { bg: theme.color.bg, fg: theme.color.inkMuted },
  green: { bg: 'rgba(31, 77, 58, 0.10)', fg: theme.color.accent },
  amber: { bg: 'rgba(179, 104, 21, 0.10)', fg: theme.color.warn },
  red: { bg: 'rgba(184, 58, 42, 0.10)', fg: theme.color.alert },
};

function WaitChip({
  minutes,
  slaTargetMinutes,
  slaState,
}: {
  minutes: number;
  slaTargetMinutes: number | null;
  slaState: SlaState;
}) {
  const tone = SLA_CHIP_TONE[slaState];
  const titleParts: string[] = [`Here ${formatWaitingTime(minutes)}`];
  if (slaTargetMinutes != null) {
    titleParts.push(`SLA target ${formatWaitingTime(slaTargetMinutes)}`);
  }
  return (
    <span
      title={titleParts.join(' · ')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: `2px ${theme.space[2]}px`,
        borderRadius: theme.radius.pill,
        background: tone.bg,
        color: tone.fg,
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.semibold,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <Clock size={12} />
      {formatWaitingTime(minutes)}
      {slaTargetMinutes != null ? (
        <span style={{ opacity: 0.7 }}> / {formatWaitingTime(slaTargetMinutes)}</span>
      ) : null}
    </span>
  );
}

function WaiverPill({ status }: { status: EnrichedActiveVisit['waiver_status'] }) {
  if (status === 'not_required') {
    return (
      <StatusPill tone="pending" size="sm">
        <span style={pillInnerStyle}>
          <ShieldCheck size={12} aria-hidden />
          Waiver not needed
        </span>
      </StatusPill>
    );
  }
  if (status === 'done') {
    return (
      <StatusPill tone="arrived" size="sm">
        <span style={pillInnerStyle}>
          <ShieldCheck size={12} aria-hidden />
          Waiver signed
        </span>
      </StatusPill>
    );
  }
  return (
    <StatusPill tone="pending" size="sm">
      <span style={pillInnerStyle}>
        <ShieldCheck size={12} aria-hidden />
        Waiver pending
      </span>
    </StatusPill>
  );
}

function PaymentPill({
  done,
  status,
}: {
  done: boolean;
  status: EnrichedActiveVisit['paid_status'];
}) {
  if (status === 'no_charge') {
    return (
      <StatusPill tone="pending" size="sm">
        <span style={pillInnerStyle}>
          <CreditCard size={12} aria-hidden />
          No charge
        </span>
      </StatusPill>
    );
  }
  if (done) {
    return (
      <StatusPill tone="arrived" size="sm">
        <span style={pillInnerStyle}>
          <CreditCard size={12} aria-hidden />
          Paid
        </span>
      </StatusPill>
    );
  }
  if (status === 'partially_paid') {
    return (
      <StatusPill tone="pending" size="sm">
        <span style={pillInnerStyle}>
          <CreditCard size={12} aria-hidden />
          Part paid
        </span>
      </StatusPill>
    );
  }
  return (
    <StatusPill tone="pending" size="sm">
      <span style={pillInnerStyle}>
        <CreditCard size={12} aria-hidden />
        Payment pending
      </span>
    </StatusPill>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading skeleton — single card-shaped placeholder. We don't know
// how many visits will resolve, so rendering N tiles up front would
// lie about volume on quiet days. One card communicates "loading
// something card-shaped" without overstating. The grid mirrors the
// real Section layout (auto-fill, minmax 280) so the placeholder
// renders at card width on desktop, not as a full-row stripe; on
// mobile a single track expands to the row, matching the real
// single-column flow there too.
// ─────────────────────────────────────────────────────────────────────────────

function LoadingGrid({ isMobile }: { isMobile: boolean }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: theme.space[3],
      }}
    >
      <Skeleton height={148} radius={theme.radius.card} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function displayName(v: EnrichedActiveVisit): string {
  const first = properCase(v.patient_first_name);
  const last = properCase(v.patient_last_name);
  if (!first && !last) return 'Patient';
  return `${first} ${last}`.trim();
}

function formatCost(pence: number | null): string {
  if (pence == null || pence === 0) return '—';
  return formatPence(pence);
}

const cardStyle: CSSProperties = {
  appearance: 'none',
  width: '100%',
  textAlign: 'left',
  padding: theme.space[5],
  background: theme.color.surface,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.card,
  fontFamily: 'inherit',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 148,
  transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
};

const pillInnerStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};
