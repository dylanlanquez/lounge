import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import {
  Avatar,
  DateRangePicker,
  EmptyState,
  MultiSelectDropdown,
  Skeleton,
  StatusPill,
  StickyPageHeader,
  type StatusTone,
} from '../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import type { AppointmentStatus } from '../components/AppointmentCard/AppointmentCard.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { humaniseStatus, properCase, type AppointmentSource } from '../lib/queries/appointments.ts';
import {
  APPOINTMENT_HISTORY_PAGE_SIZE,
  useAppointmentHistory,
  type AppointmentHistoryFilters,
  type AppointmentHistoryRow,
} from '../lib/queries/appointmentHistory.ts';
import type { DateRange } from '../lib/dateRange.ts';

// Appointment History route — every booking the clinic has ever
// taken, paged + filterable.
//
// Design ladder mirrors Patients: sticky header (title + meta + filter
// row), full-bleed list, pagination at the bottom. Click a row → opens
// the linked visit (`/visit/:id`) when the appointment was attended;
// for cancelled / no-show / not-yet-arrived rows, jumps to the
// patient profile so the receptionist sees the surrounding history.

const STATUS_OPTIONS: ReadonlyArray<{ value: AppointmentStatus; label: string }> = [
  { value: 'booked', label: 'Booked' },
  { value: 'arrived', label: 'Arrived' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'complete', label: 'Complete' },
  { value: 'no_show', label: 'No-show' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'rescheduled', label: 'Rescheduled' },
];

const SOURCE_OPTIONS: ReadonlyArray<{ value: AppointmentSource; label: string }> = [
  { value: 'native', label: 'Native (Lounge)' },
  { value: 'calendly', label: 'Calendly' },
  { value: 'manual', label: 'Manually added' },
];

const STATUS_TO_TONE: Record<AppointmentStatus, StatusTone> = {
  booked: 'pending',
  arrived: 'arrived',
  in_progress: 'in_progress',
  complete: 'complete',
  no_show: 'no_show',
  cancelled: 'cancelled',
  rescheduled: 'cancelled',
};

const ALL_TIME_RANGE: DateRange = {
  // The "all time" sentinel — when both dates land on the epoch the
  // query helper treats it as "no date filter" via the explicit null
  // check we apply below before passing to the hook.
  start: '2020-01-01',
  end: '2099-12-31',
  preset: 'custom',
};

export function AppointmentHistory() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile(640);
  const [search, setSearch] = useState('');
  const [statuses, setStatuses] = useState<AppointmentStatus[]>([]);
  const [sources, setSources] = useState<AppointmentSource[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>(ALL_TIME_RANGE);
  const [page, setPage] = useState(0);

  // Treat the sentinel "all time" range as "no date filter" so the
  // query gets nulls instead of a 79-year window. Lets the user clear
  // the range with the picker's preset list and end up filterless.
  const isAllTime =
    dateRange.start === ALL_TIME_RANGE.start && dateRange.end === ALL_TIME_RANGE.end;

  const filters: AppointmentHistoryFilters = useMemo(
    () => ({
      statuses,
      sources,
      fromDate: isAllTime ? null : dateRange.start,
      toDate: isAllTime ? null : dateRange.end,
      search,
    }),
    [statuses, sources, dateRange, isAllTime, search],
  );

  const { data, loading, error, hasMore } = useAppointmentHistory(filters, page);

  // Any filter change pages back to 0 — staff are starting a new
  // search, not flicking through the previous result set.
  useEffect(() => {
    setPage(0);
  }, [statuses, sources, dateRange, search]);

  useEffect(() => {
    document.getElementById('root')?.scrollTo(0, 0);
  }, [page]);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  const trimmed = search.trim();
  const outerPaddingX = isMobile ? theme.space[4] : theme.space[6];
  const innerMaxWidth = theme.layout.pageMaxWidth;
  const filtersActive =
    statuses.length > 0 || sources.length > 0 || !isAllTime || trimmed.length > 0;

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: `0 ${outerPaddingX}px`,
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + env(safe-area-inset-top, 0px) + ${theme.space[5]}px)`,
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${isMobile ? theme.space[6] : theme.space[8]}px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div style={{ maxWidth: innerMaxWidth, margin: '0 auto' }}>
        <StickyPageHeader
          title="Appointment history"
          meta={
            <Counter
              loading={loading}
              count={data.length}
              hasMore={hasMore}
              page={page}
              filtersActive={filtersActive}
            />
          }
          body={
            <FiltersRow
              search={search}
              onSearchChange={setSearch}
              statuses={statuses}
              onStatusesChange={setStatuses}
              sources={sources}
              onSourcesChange={setSources}
              dateRange={dateRange}
              onDateRangeChange={setDateRange}
              isAllTime={isAllTime}
              onClearDateRange={() => setDateRange(ALL_TIME_RANGE)}
            />
          }
          outerPaddingX={outerPaddingX}
          innerMaxWidth={innerMaxWidth}
          bodyMarginBottom={theme.space[3]}
        />

        {error ? (
          <p style={{ color: theme.color.alert, margin: 0 }}>
            Could not load appointment history: {error}
          </p>
        ) : loading && data.length === 0 ? (
          <SkeletonList />
        ) : data.length === 0 ? (
          <div style={{ paddingTop: theme.space[6] }}>
            <EmptyState
              title={filtersActive ? 'No appointments match' : 'No appointments yet'}
              description={
                filtersActive
                  ? 'Try a different status, date range, or search term.'
                  : 'Bookings made through Schedule, Calendly or the public booking page will appear here.'
              }
            />
          </div>
        ) : (
          <>
            <RowList
              data={data}
              onPick={(r) => {
                if (r.visit_id) {
                  navigate(`/visit/${r.visit_id}`);
                  return;
                }
                navigate(`/patient/${r.patient_id}`);
              }}
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

// ─────────────────────────────────────────────────────────────────────────────
// Filters row
// ─────────────────────────────────────────────────────────────────────────────

function FiltersRow({
  search,
  onSearchChange,
  statuses,
  onStatusesChange,
  sources,
  onSourcesChange,
  dateRange,
  onDateRangeChange,
  isAllTime,
  onClearDateRange,
}: {
  search: string;
  onSearchChange: (v: string) => void;
  statuses: AppointmentStatus[];
  onStatusesChange: (next: AppointmentStatus[]) => void;
  sources: AppointmentSource[];
  onSourcesChange: (next: AppointmentSource[]) => void;
  dateRange: DateRange;
  onDateRangeChange: (next: DateRange) => void;
  isAllTime: boolean;
  onClearDateRange: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
      }}
    >
      <SearchInput value={search} onChange={onSearchChange} />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: theme.space[2],
          alignItems: 'center',
        }}
      >
        <div style={{ minWidth: 160 }}>
          <MultiSelectDropdown<AppointmentStatus>
            label="Status"
            placeholder="All statuses"
            values={statuses}
            options={STATUS_OPTIONS}
            onChange={onStatusesChange}
            totalNoun="statuses"
          />
        </div>
        <div style={{ minWidth: 160 }}>
          <MultiSelectDropdown<AppointmentSource>
            label="Source"
            placeholder="All sources"
            values={sources}
            options={SOURCE_OPTIONS}
            onChange={onSourcesChange}
            totalNoun="sources"
          />
        </div>
        <DateRangePicker value={dateRange} onChange={onDateRangeChange} size="sm" />
        {!isAllTime ? (
          <button
            type="button"
            onClick={onClearDateRange}
            style={{
              appearance: 'none',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'inherit',
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              textDecoration: 'underline',
              textUnderlineOffset: 3,
            }}
          >
            Clear dates
          </button>
        ) : null}
      </div>
    </div>
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
        placeholder="Search by patient name"
        aria-label="Search appointment history"
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

// ─────────────────────────────────────────────────────────────────────────────
// List + row
// ─────────────────────────────────────────────────────────────────────────────

function Counter({
  loading,
  count,
  hasMore,
  page,
  filtersActive,
}: {
  loading: boolean;
  count: number;
  hasMore: boolean;
  page: number;
  filtersActive: boolean;
}) {
  if (loading && count === 0) return <span aria-hidden style={{ minWidth: 56 }} />;
  let label: string;
  if (filtersActive) {
    label = `${count}${hasMore ? '+' : ''}`;
  } else {
    const start = page * APPOINTMENT_HISTORY_PAGE_SIZE + 1;
    const end = page * APPOINTMENT_HISTORY_PAGE_SIZE + count;
    label = count === 0 ? '0' : `${formatThousands(start)}–${formatThousands(end)}`;
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

function RowList({
  data,
  onPick,
}: {
  data: AppointmentHistoryRow[];
  onPick: (row: AppointmentHistoryRow) => void;
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
      {data.map((r) => (
        <li key={r.id}>
          <Row row={r} onPick={() => onPick(r)} />
        </li>
      ))}
    </ul>
  );
}

function Row({ row, onPick }: { row: AppointmentHistoryRow; onPick: () => void }) {
  const [hover, setHover] = useState(false);
  const fullName = patientName(row);
  const dateLabel = formatRowDate(row.start_at);
  const timeLabel = formatRowTime(row.start_at);
  const serviceLabel = row.event_type_label?.trim() || 'Appointment';
  const tone = STATUS_TO_TONE[row.status];

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
      <Avatar name={fullName} src={row.patient_avatar_data} size="md" />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1.4fr) minmax(0, 0.9fr) auto',
          alignItems: 'center',
          gap: theme.space[3],
        }}
      >
        <div style={{ minWidth: 0 }}>
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
          {row.appointment_ref ? (
            <p
              style={{
                margin: '2px 0 0',
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {row.appointment_ref}
            </p>
          ) : null}
        </div>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {serviceLabel}
        </p>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            fontVariantNumeric: 'tabular-nums',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {dateLabel}
          <span style={{ color: theme.color.inkSubtle, marginLeft: theme.space[2] }}>{timeLabel}</span>
        </p>
        <StatusPill tone={tone} size="sm">
          {humaniseStatus(row.status)}
        </StatusPill>
      </div>
      <ChevronRight
        size={18}
        color={hover ? theme.color.ink : theme.color.inkSubtle}
        aria-hidden
        style={{
          flexShrink: 0,
          transition: `color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      />
    </button>
  );
}

function SkeletonList() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {Array.from({ length: APPOINTMENT_HISTORY_PAGE_SIZE }).map((_, i) => (
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
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1.4fr) minmax(0, 0.9fr) 90px',
              gap: theme.space[3],
              alignItems: 'center',
            }}
          >
            <Skeleton width="60%" height={16} radius={4} />
            <Skeleton width="70%" height={14} radius={4} />
            <Skeleton width="80%" height={14} radius={4} />
            <Skeleton width="100%" height={20} radius={999} />
          </div>
          <Skeleton width={18} height={18} radius={4} />
        </div>
      ))}
    </div>
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
      aria-label="Appointment history pagination"
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
        Page {formatThousands(page + 1)}
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function patientName(r: AppointmentHistoryRow): string {
  const first = properCase(r.patient_first_name);
  const last = properCase(r.patient_last_name);
  return `${first} ${last}`.trim() || 'Unnamed patient';
}

function formatRowDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatRowTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

const NUM_FMT = new Intl.NumberFormat('en-GB');
function formatThousands(n: number): string {
  return NUM_FMT.format(n);
}
