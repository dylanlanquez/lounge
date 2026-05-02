import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
} from 'lucide-react';
import {
  Avatar,
  DateRangePicker,
  EmptyState,
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
import {
  humaniseStatus,
  patientFullDisplayName,
  properCase,
  type AppointmentSource,
} from '../lib/queries/appointments.ts';
import { humaniseEventTypeLabel } from '../lib/queries/patientProfile.ts';
import {
  APPOINTMENT_HISTORY_PAGE_SIZE,
  useAppointmentHistory,
  type AppointmentHistoryFilters,
  type AppointmentHistoryRow,
} from '../lib/queries/appointmentHistory.ts';
import type { DateRange } from '../lib/dateRange.ts';

// Appointments route — every booking the clinic has ever taken or
// scheduled, past and future. The list mirrors Patients in shape
// (avatar, name, ref, sticky filters at the top, page-50 pagination
// at the bottom) so receptionists don't relearn a new pattern. What
// makes it different is the filter row: status + source + date
// range + name search compose freely, and any active filter can be
// dismissed inline so a chain like "show me every cancelled booking
// in May" takes two clicks to set up and one to clear.
//
// Click-through routes by visit linkage: an attended appointment has
// a visit row, so the click goes to /visit/:id; a cancelled or
// not-yet-arrived appointment has none, so the click goes to the
// patient profile (where the timeline lists the same booking with
// every other event around it). The router state we set here drives
// the destination's breadcrumb so the back-trail says "Appointments
// › ..." instead of the default "Schedule › ...".

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

// Booked rows show a soft outlined pill (the same `pending` tone the
// In-Clinic board uses for "not yet"). Every other status maps to its
// own tone so the column reads like a dashboard at a glance.
const STATUS_TO_TONE: Record<AppointmentStatus, StatusTone> = {
  booked: 'pending',
  arrived: 'arrived',
  in_progress: 'in_progress',
  complete: 'complete',
  no_show: 'no_show',
  cancelled: 'cancelled',
  rescheduled: 'cancelled',
};

export function AppointmentHistory() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile(640);
  const [search, setSearch] = useState('');
  const [statuses, setStatuses] = useState<AppointmentStatus[]>([]);
  const [sources, setSources] = useState<AppointmentSource[]>([]);
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [page, setPage] = useState(0);

  const filters: AppointmentHistoryFilters = useMemo(
    () => ({
      statuses,
      sources,
      fromDate: dateRange?.start ?? null,
      toDate: dateRange?.end ?? null,
      search,
    }),
    [statuses, sources, dateRange, search],
  );

  const { data, loading, error, hasMore } = useAppointmentHistory(filters, page);

  // Filter changes reset to page 0 — the receptionist is starting a
  // new search, not flicking through the previous result set.
  useEffect(() => {
    setPage(0);
  }, [statuses, sources, dateRange, search]);

  // Page changes scroll to top of the list. The route doesn't change
  // so App's ScrollToTop doesn't fire here; the page scroll lives on
  // #root (body is pinned for iOS rubber-band) so window.scrollTo is
  // a no-op.
  useEffect(() => {
    document.getElementById('root')?.scrollTo(0, 0);
  }, [page]);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  const trimmed = search.trim();
  const outerPaddingX = isMobile ? theme.space[4] : theme.space[6];
  const innerMaxWidth = theme.layout.pageMaxWidth;
  const filtersActive =
    statuses.length > 0 || sources.length > 0 || dateRange !== null || trimmed.length > 0;
  const clearAll = () => {
    setStatuses([]);
    setSources([]);
    setDateRange(null);
    setSearch('');
  };

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
          title="Appointments"
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
              filtersActive={filtersActive}
              onClearAll={clearAll}
            />
          }
          outerPaddingX={outerPaddingX}
          innerMaxWidth={innerMaxWidth}
          bodyMarginBottom={theme.space[3]}
        />

        {error ? (
          <ErrorPanel message={error} />
        ) : loading && data.length === 0 ? (
          <SkeletonList />
        ) : data.length === 0 ? (
          <div style={{ paddingTop: theme.space[6] }}>
            <EmptyState
              title={filtersActive ? 'No appointments match' : 'No appointments yet'}
              description={
                filtersActive
                  ? 'Try a different status, source, date range, or name.'
                  : 'Bookings made via Schedule, Calendly or the public booking page will appear here.'
              }
            />
          </div>
        ) : (
          <>
            <RowList
              data={data}
              onPick={(row) => {
                const fullName = patientFullDisplayName({
                  patient_first_name: row.patient_first_name,
                  patient_last_name: row.patient_last_name,
                } as never);
                if (row.visit_id) {
                  navigate(`/visit/${row.visit_id}`, {
                    state: {
                      from: 'appointments',
                      patientId: row.patient_id,
                      patientName: fullName,
                    },
                  });
                  return;
                }
                navigate(`/patient/${row.patient_id}`, {
                  state: {
                    from: 'appointments',
                    patientName: fullName,
                  },
                });
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
  filtersActive,
  onClearAll,
}: {
  search: string;
  onSearchChange: (v: string) => void;
  statuses: AppointmentStatus[];
  onStatusesChange: (next: AppointmentStatus[]) => void;
  sources: AppointmentSource[];
  onSourcesChange: (next: AppointmentSource[]) => void;
  dateRange: DateRange | null;
  onDateRangeChange: (next: DateRange | null) => void;
  filtersActive: boolean;
  onClearAll: () => void;
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
        <FilterPill<AppointmentStatus>
          label="Status"
          placeholder="All statuses"
          values={statuses}
          options={STATUS_OPTIONS}
          onChange={onStatusesChange}
          totalNoun="statuses"
        />
        <FilterPill<AppointmentSource>
          label="Source"
          placeholder="All sources"
          values={sources}
          options={SOURCE_OPTIONS}
          onChange={onSourcesChange}
          totalNoun="sources"
        />
        <DateRangePicker
          value={dateRange}
          onChange={(r) => onDateRangeChange(r)}
          onClear={() => onDateRangeChange(null)}
          placeholder="Any date"
          size="sm"
        />
        {filtersActive ? (
          <button
            type="button"
            onClick={onClearAll}
            style={{
              appearance: 'none',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'inherit',
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.medium,
              color: theme.color.inkMuted,
              textDecoration: 'underline',
              textUnderlineOffset: 3,
              marginLeft: theme.space[1],
            }}
          >
            Clear all filters
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
        aria-label="Search appointments"
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
// Counter / error / list / row
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
    label = count === 0 ? '0' : `${formatThousands(count)}${hasMore ? '+' : ''}`;
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

function ErrorPanel({ message }: { message: string }) {
  // Failures already log to lng_system_failures via the hook; this
  // panel is the user-visible side. Honest, non-technical, with the
  // raw message available for the receptionist to read aloud to a
  // dev if needed.
  return (
    <div
      role="alert"
      style={{
        marginTop: theme.space[5],
        padding: `${theme.space[5]}px ${theme.space[5]}px`,
        borderRadius: theme.radius.card,
        background: theme.color.surface,
        border: `1px solid ${theme.color.alert}`,
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.alert,
        }}
      >
        Could not load appointments
      </p>
      <p
        style={{
          margin: `${theme.space[2]}px 0 0`,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          lineHeight: theme.type.leading.snug,
        }}
      >
        {message}
      </p>
    </div>
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
  const serviceLabel = humaniseEventTypeLabel(row.event_type_label) ?? 'Appointment';
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
          <p
            style={{
              margin: '2px 0 0',
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              fontVariantNumeric: 'tabular-nums',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {sourceMeta(row.source).label}
            {row.appointment_ref ? ` · ${row.appointment_ref}` : ''}
          </p>
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

// ─────────────────────────────────────────────────────────────────────────────
// Source label helper — lives next to the patient name as part of
// the row's secondary line ("Calendly · LAP-00042"). Earlier revs
// rendered this as a circular icon next to the avatar; that read as
// a duplicate avatar. Plain text in the existing meta line is the
// less visually noisy answer.
// ─────────────────────────────────────────────────────────────────────────────

function sourceMeta(source: AppointmentSource): { label: string } {
  switch (source) {
    case 'native':
      return { label: 'Native' };
    case 'calendly':
      return { label: 'Calendly' };
    case 'manual':
      return { label: 'Manually added' };
    default:
      // Unrecognised source: surface the raw value rather than guess.
      // The schema constrains this so the branch shouldn't fire — if
      // it does, the data model has changed and this map should
      // change with it.
      return { label: source };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FilterPill — compact multi-select trigger styled to match the
// DateRangePicker's tertiary button. Shows label + active selection
// count; opens a portal-positioned panel of checkbox rows. When at
// least one value is selected, an inline X next to the trigger lets
// the receptionist clear that filter without opening the panel.
//
// This is local to the Appointments page on purpose: the existing
// MultiSelectDropdown is a full form field (label-above-value, ~72px
// tall) which dominates the filter row visually. If a second filter
// surface needs the same shape, lift this into a primitive then.
// ─────────────────────────────────────────────────────────────────────────────

function FilterPill<T extends string>({
  label,
  placeholder,
  values,
  options,
  onChange,
  totalNoun,
}: {
  label: string;
  placeholder: string;
  values: T[];
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T[]) => void;
  totalNoun: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );

  const valueSet = new Set(values);
  const selected = options.filter((o) => valueSet.has(o.value));
  const display =
    selected.length === 0
      ? placeholder
      : selected.length === options.length
        ? `All ${totalNoun}`
        : selected.length === 1
          ? selected[0]!.label
          : `${selected.length} ${totalNoun}`;

  const hasValue = selected.length > 0 && selected.length < options.length;

  // Outside-click + Escape dismiss while open. Close fires before any
  // click outside the wrapper resolves so the panel doesn't flash on
  // the very next interaction.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Position the panel under the trigger. Re-runs on scroll/resize
  // while open so the panel tracks if the page reflows.
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const update = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      setPanelPos({
        top: rect.bottom + 6,
        left: rect.left,
        width: Math.max(rect.width, 220),
      });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  const toggle = (v: T) => {
    if (valueSet.has(v)) onChange(values.filter((x) => x !== v));
    else onChange([...values, v]);
  };

  return (
    <span
      ref={wrapperRef}
      style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          appearance: 'none',
          height: 36,
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[2],
          padding: `0 ${theme.space[3]}px`,
          borderRadius: theme.radius.input,
          border: `1px solid ${hasValue ? theme.color.ink : theme.color.border}`,
          background: theme.color.surface,
          color: hasValue ? theme.color.ink : theme.color.inkMuted,
          fontFamily: 'inherit',
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.medium,
          cursor: 'pointer',
          transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      >
        <span style={{ color: theme.color.inkMuted }}>{label}</span>
        <span
          style={{
            color: hasValue ? theme.color.ink : theme.color.inkSubtle,
            fontWeight: theme.type.weight.semibold,
            maxWidth: 200,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {display}
        </span>
        <ChevronDown size={14} aria-hidden style={{ color: theme.color.inkSubtle }} />
      </button>
      {hasValue ? (
        <button
          type="button"
          aria-label={`Clear ${label.toLowerCase()} filter`}
          onClick={(e) => {
            e.stopPropagation();
            onChange([]);
          }}
          style={{
            appearance: 'none',
            border: `1px solid ${theme.color.border}`,
            background: theme.color.surface,
            color: theme.color.inkSubtle,
            cursor: 'pointer',
            padding: 0,
            width: 26,
            height: 26,
            borderRadius: theme.radius.pill,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'inherit',
          }}
        >
          <X size={12} aria-hidden />
        </button>
      ) : null}
      {open && panelPos
        ? (() => {
            const panelStyle: CSSProperties = {
              position: 'fixed',
              top: panelPos.top,
              left: panelPos.left,
              width: panelPos.width,
              maxHeight: 320,
              overflowY: 'auto',
              background: theme.color.surface,
              border: `1px solid ${theme.color.border}`,
              borderRadius: theme.radius.input,
              boxShadow: theme.shadow.overlay,
              zIndex: 1200,
              padding: theme.space[1],
              display: 'flex',
              flexDirection: 'column',
            };
            return (
              <div role="listbox" aria-multiselectable="true" style={panelStyle}>
                {options.map((opt) => {
                  const isChecked = valueSet.has(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="option"
                      aria-selected={isChecked}
                      onClick={() => toggle(opt.value)}
                      style={{
                        appearance: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: theme.space[3],
                        padding: `${theme.space[2]}px ${theme.space[3]}px`,
                        background: 'transparent',
                        border: 'none',
                        borderRadius: theme.radius.input,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        fontSize: theme.type.size.sm,
                        color: theme.color.ink,
                        textAlign: 'left',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = theme.color.bg;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <span>{opt.label}</span>
                      <span
                        aria-hidden
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 18,
                          height: 18,
                          borderRadius: 4,
                          border: `1px solid ${isChecked ? theme.color.ink : theme.color.border}`,
                          background: isChecked ? theme.color.ink : theme.color.surface,
                          color: theme.color.surface,
                          flexShrink: 0,
                        }}
                      >
                        {isChecked ? <Check size={12} aria-hidden /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })()
        : null}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton + pagination
// ─────────────────────────────────────────────────────────────────────────────

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
      aria-label="Appointments pagination"
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
