import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Clock, Plus, Settings2, Sparkles, Trash2 } from 'lucide-react';
import {
  BottomSheet,
  Button,
  Card,
  Checkbox,
  DropdownSelect,
  Input,
  PatientFacingDurationEditor,
  PhaseEditor,
  type PhaseEditorTarget,
  type PhaseEditorValues,
  PhaseRibbon,
  type PhaseRibbonPhase,
  SegmentedControl,
  Skeleton,
  Toast,
} from '../components/index.ts';
import {
  useClinicSettings,
  type OpeningHoursDay,
  type OpeningHoursWeek,
} from '../lib/queries/clinicSettings.ts';
import { theme } from '../theme/index.ts';
import { fmtTzAbbr } from '../lib/dateFormat.ts';
import {
  type BookingServiceType,
  type BookingTypeConfigRow,
  type BookingTypePhaseRow,
  type ResourcePoolRow,
  BOOKING_SERVICE_TYPES,
  bookingTypeRowDerivedLabel,
  bookingTypeRowLabel,
  deleteBookingTypeChildOverride,
  deleteBookingTypePhase,
  reorderBookingTypePhases,
  reorderChildPhases,
  setPhasePoolIds,
  upsertBookingTypeConfig,
  upsertBookingTypePhase,
  useBookingTypeConfigs,
  useBookingTypePhases,
  useResourcePools,
} from '../lib/queries/bookingTypes.ts';
import {
  type AxisDef,
  type AxisPin,
  type AxisValueOption,
  axesForService,
  loadAxisValues,
  pinnedAxesLabel,
} from '../lib/queries/bookingTypeAxes.ts';

// Service-family palette. Matches the Visitor Heatmap markers
// (src/lib/visitorMapStyling.ts) so a service's identity reads
// the same on every Lounge surface — the dot on the booking-types
// row is the same colour as the dot for that service on the map.
const SERVICE_DOT_COLOUR: Record<BookingServiceType, string> = {
  denture_repair: '#4F6F89',
  click_in_veneers: '#2D3539',
  same_day_appliance: theme.color.accent,
  impression_appointment: '#B36815',
  virtual_impression_appointment: theme.category.virtualImpression,
  other: '#6B7378',
};

// AdminBookingTypesTab — manages the per-booking-type scheduling config
// that drives the reschedule slot picker, conflict checker, and (later)
// the new-booking flow.
//
// Tree shape:
//   Service (parent)               working hours summary, default duration
//     ↳ child override 1           own hours / inherited; own duration / inherited
//     ↳ child override 2
//     ↳ + add override             dropdown to pick a catalogue child
//
// The parent rows are seeded by the migration and aren't deletable;
// only their fields are editable. Child rows are added by the admin
// when they want to override the parent's defaults for a specific
// repair variant / appliance product / arch.
//
// Hours / durations on a child are *per-field nullable* — leaving a
// field empty means "inherit from parent". The editor surfaces this
// with a "Use parent default" toggle next to each section.

// What's being edited in the dialog. A row from the DB (parent or
// child), or a new child row being authored — in which case the
// child key is set but no row exists yet.
type EditTarget =
  | { kind: 'parent'; row: BookingTypeConfigRow }
  | { kind: 'child'; row: BookingTypeConfigRow }
  | {
      kind: 'new-child';
      service_type: BookingServiceType;
      // Multi-axis pins (ADR-007). One pin per axis the admin chose
      // a value for; axes left as "Any" are absent from this array.
      // Order is presentational only; the editor maps each pin to
      // its column when writing the row.
      pins: AxisPin[];
    };

export function AdminBookingTypesTab() {
  const { data, loading, error, reload } = useBookingTypeConfigs();
  const pools = useResourcePools();
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string } | null>(null);

  // Group rows by service. Per service: the parent row (always
  // exactly one due to the seed migration) and a sorted children
  // array.
  const grouped = useMemo(() => groupByService(data), [data]);

  if (error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load booking-type config: {error}
        </p>
      </Card>
    );
  }
  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        <Skeleton height={120} />
        <Skeleton height={240} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
      <header>
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.xl,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[2],
          }}
        >
          <Clock size={20} aria-hidden style={{ color: theme.color.inkMuted }} /> Booking types
        </h2>
        <p
          style={{
            margin: `${theme.space[2]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: 1.5,
            maxWidth: 640,
          }}
        >
          Working hours and durations per service. Add overrides only for the
          specific variants, products, or arches that need to differ from the parent.
        </p>
      </header>

      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[3],
        }}
      >
          {BOOKING_SERVICE_TYPES.map((s) => {
            const group = grouped.get(s.value);
            if (!group) return null;
            return (
              <ServiceNode
                key={s.value}
                serviceLabel={s.label}
                serviceType={s.value}
                parent={group.parent}
                children={group.children}
                pools={pools.data}
                onEditParent={() => setEditTarget({ kind: 'parent', row: group.parent })}
                onEditChild={(row) => setEditTarget({ kind: 'child', row })}
                onAddChild={(target) => setEditTarget(target)}
                onRemoveChild={async (row) => {
                  try {
                    await deleteBookingTypeChildOverride({
                      service_type: row.service_type,
                      repair_variant: row.repair_variant,
                      product_key: row.product_key,
                      arch: row.arch,
                    });
                    setToast({ tone: 'success', title: 'Override removed' });
                    reload();
                  } catch (e) {
                    setToast({
                      tone: 'error',
                      title: e instanceof Error ? e.message : 'Could not remove',
                    });
                  }
                }}
                onPhaseSaved={() => {
                  setToast({ tone: 'success', title: 'Saved' });
                  // Reload configs too — saving the patient-facing
                  // duration writes to lng_booking_type_config and the
                  // resolved value lives on the parent row.
                  reload();
                }}
                onPhaseReordered={() => {
                  // Reorder only changes phase_index on rows that
                  // already exist locally; the parent config row
                  // itself didn't change, so we deliberately DO NOT
                  // refetch the config list here. Avoids the
                  // re-mount + dropdown-collapse glitch operators
                  // saw mid-drag.
                  setToast({ tone: 'success', title: 'Order updated' });
                }}
                onPhaseDeleted={() => setToast({ tone: 'success', title: 'Phase deleted' })}
                onPhaseError={(msg) => setToast({ tone: 'error', title: msg })}
              />
            );
          })}
      </ul>

      {editTarget ? (
        <BookingTypeEditorDialog
          target={editTarget}
          parent={
            editTarget.kind === 'parent'
              ? null
              : grouped.get(serviceOfTarget(editTarget))?.parent ?? null
          }
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            setToast({ tone: 'success', title: 'Saved' });
            reload();
          }}
          onError={(msg) => setToast({ tone: 'error', title: msg })}
        />
      ) : null}

      {toast ? (
        <Toast
          tone={toast.tone}
          title={toast.title}
          onDismiss={() => setToast(null)}
        />
      ) : null}
    </div>
  );
}

interface ServiceGroup {
  parent: BookingTypeConfigRow;
  children: BookingTypeConfigRow[];
}

// Read-only helper used when looking up the parent of a child or new-
// child edit target. Parent edits don't go through here — they
// already know their service from the row itself.
function serviceOfTarget(t: EditTarget): BookingServiceType {
  if (t.kind === 'parent' || t.kind === 'child') return t.row.service_type;
  return t.service_type;
}

function groupByService(rows: BookingTypeConfigRow[]): Map<BookingServiceType, ServiceGroup> {
  const out = new Map<BookingServiceType, ServiceGroup>();
  for (const r of rows) {
    const isParent = !r.repair_variant && !r.product_key && !r.arch;
    let group = out.get(r.service_type);
    if (!group) {
      // Initialise with the row as parent if it is one; placeholder
      // otherwise. Misshapen data (a child without a parent) is a
      // setup error but we tolerate it without crashing.
      group = isParent ? { parent: r, children: [] } : { parent: r, children: [r] };
      out.set(r.service_type, group);
      continue;
    }
    if (isParent) group.parent = r;
    else group.children.push(r);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// One service block — parent row + collapsible children.
// ─────────────────────────────────────────────────────────────────────────────

// Service card — one entry in the booking-types list. Each service
// is its own card with a coloured left edge in its identity colour
// so the eye picks out denture / veneers / appliance / impression
// without reading the title. The cog opens the editor; the override
// disclosure below the ribbon expands the variants.
function ServiceNode({
  serviceLabel,
  serviceType,
  parent,
  children,
  pools,
  onEditParent,
  onEditChild,
  onAddChild,
  onRemoveChild,
  onPhaseSaved,
  onPhaseReordered,
  onPhaseDeleted,
  onPhaseError,
}: {
  serviceLabel: string;
  serviceType: BookingServiceType;
  parent: BookingTypeConfigRow;
  children: BookingTypeConfigRow[];
  pools: ResourcePoolRow[];
  onEditParent: () => void;
  onEditChild: (row: BookingTypeConfigRow) => void;
  onAddChild: (target: EditTarget) => void;
  onRemoveChild: (row: BookingTypeConfigRow) => void;
  onPhaseSaved: () => void;
  /** Toast-only callback for drag-and-drop reorder. Deliberately
   *  does not refetch the parent config list — the reorder only
   *  changes phase_index on rows that already exist locally. */
  onPhaseReordered: () => void;
  onPhaseDeleted: () => void;
  onPhaseError: (msg: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const phases = useBookingTypePhases(parent.id);
  const [phaseEditorTarget, setPhaseEditorTarget] = useState<PhaseEditorTarget | null>(null);
  const [patientFacingOpen, setPatientFacingOpen] = useState(false);

  // Map DB rows → ribbon shape. Always uses duration_default (the
  // operational default); admin can edit the trio in the editor.
  const ribbonPhases: PhaseRibbonPhase[] = useMemo(
    () =>
      phases.data.map((p) => ({
        key: p.id,
        phase_index: p.phase_index,
        label: p.label,
        patient_required: p.patient_required,
        duration_minutes: p.duration_default ?? 0,
        pool_ids: p.pool_ids,
      })),
    [phases.data],
  );

  const operationalMinutes = ribbonPhases.reduce(
    (acc, p) => acc + (p.duration_minutes || 0),
    0,
  );
  const patientInMinutes = ribbonPhases
    .filter((p) => p.patient_required)
    .reduce((acc, p) => acc + (p.duration_minutes || 0), 0);
  // Resolved patient-facing min for the ribbon's "Telling patient X"
  // pill — falls back to the operational total when the column is
  // null. Max stays null unless the admin opted into a range.
  const patientFacingMinResolved =
    parent.patient_facing_min_minutes ?? operationalMinutes;
  const patientFacingMaxResolved = parent.patient_facing_max_minutes;
  const nextPhaseIndex =
    ribbonPhases.length === 0
      ? 1
      : Math.max(...ribbonPhases.map((p) => p.phase_index)) + 1;

  const handlePhaseSave = async (values: PhaseEditorValues) => {
    try {
      const phaseId = await upsertBookingTypePhase({
        id: values.id,
        config_id: values.config_id,
        phase_index: values.phase_index,
        label: values.label,
        patient_required: values.patient_required,
        duration_default: values.duration_default,
        duration_min: values.duration_min,
        duration_max: values.duration_max,
        notes: values.notes,
      });
      await setPhasePoolIds(phaseId, values.pool_ids);
      phases.reload();
      onPhaseSaved();
    } catch (e) {
      onPhaseError(e instanceof Error ? e.message : 'Could not save phase');
      throw e;
    }
  };

  const handlePhaseDelete = async (phaseId: string) => {
    try {
      await deleteBookingTypePhase(phaseId);
      phases.reload();
      onPhaseDeleted();
    } catch (e) {
      onPhaseError(e instanceof Error ? e.message : 'Could not delete phase');
      throw e;
    }
  };

  const handlePatientFacingSave = async (values: {
    min: number | null;
    max: number | null;
  }) => {
    try {
      await upsertBookingTypeConfig({
        service_type: parent.service_type,
        repair_variant: parent.repair_variant,
        product_key: parent.product_key,
        arch: parent.arch,
        patient_facing_min_minutes: values.min,
        patient_facing_max_minutes: values.max,
      });
      onPhaseSaved();
    } catch (e) {
      onPhaseError(e instanceof Error ? e.message : 'Could not save');
      throw e;
    }
  };
  // Axes this service supports. Drives whether the Add-override
  // button is shown at all and what the AddOverrideSheet renders
  // when opened. Single source of truth: bookingTypeAxes registry.
  const axes = useMemo(() => axesForService(serviceType), [serviceType]);
  const canAddOverride = axes.length > 0;
  const [addSheetOpen, setAddSheetOpen] = useState(false);

  const dot = SERVICE_DOT_COLOUR[serviceType];

  return (
    <li
      style={{
        position: 'relative',
        background: theme.color.surface,
        borderRadius: theme.radius.card,
        boxShadow: theme.shadow.card,
        // Coloured left edge bar in the service's identity colour.
        // Sits inside the card border-radius via overflow:hidden so it
        // hugs the rounded corners cleanly.
        overflow: 'hidden',
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: 8,
          background: dot,
        }}
      />
      <div
        style={{
          width: '100%',
          padding: `${theme.space[4]}px ${theme.space[5]}px`,
          paddingLeft: theme.space[5] + 8,
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            {serviceLabel}
          </span>
        </div>
        <IconAction
          ariaLabel={`Configure ${serviceLabel}`}
          onClick={onEditParent}
          icon={<Settings2 size={16} aria-hidden />}
        />
      </div>

      <div
        style={{
          padding: `0 ${theme.space[5]}px ${theme.space[3]}px ${theme.space[8]}px`,
        }}
      >
        {phases.loading ? (
          <Skeleton height={48} />
        ) : (
          <PhaseRibbon
            phases={ribbonPhases}
            operational_minutes={operationalMinutes}
            patient_in_minutes={patientInMinutes}
            patient_facing_min_minutes={patientFacingMinResolved}
            patient_facing_max_minutes={patientFacingMaxResolved}
            onPhaseClick={(key) => {
              const target = phases.data.find((p) => p.id === key);
              if (target) setPhaseEditorTarget({ kind: 'edit', phase: target });
            }}
            onAddPhase={() =>
              setPhaseEditorTarget({
                kind: 'create',
                config_id: parent.id,
                next_phase_index: nextPhaseIndex,
              })
            }
            onReorder={async (orderedKeys) => {
              // The parent ribbon's chip keys are the phase row ids
              // (see ribbonPhases above), so the new order is a
              // direct argument to the renumber RPC. After the RPC
              // succeeds we reload phases (silent refetch — the
              // hook keeps showing the existing ribbon during the
              // network round-trip so the chips don't flash) and
              // fire the toast-only callback. We intentionally do
              // NOT call onPhaseSaved here, which would refetch the
              // whole config list and re-mount the ServiceListItem
              // (collapsing the override dropdown + scrolling the
              // page back to the top — what operators were seeing).
              try {
                await reorderBookingTypePhases(parent.id, orderedKeys);
                phases.reload();
                onPhaseReordered();
              } catch (e) {
                onPhaseError(
                  e instanceof Error ? e.message : 'Could not reorder phases',
                );
              }
            }}
            onEditPatientFacing={() => setPatientFacingOpen(true)}
          />
        )}
      </div>

      <OverridesDisclosure
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        count={children.length}
        canAdd={canAddOverride}
        serviceLabel={serviceLabel}
      />

      <Collapse open={expanded}>
        <div
          style={{
            background: theme.color.bg,
            padding: `${theme.space[3]}px ${theme.space[5]}px ${theme.space[4]}px ${theme.space[8]}px`,
            borderTop: `1px solid ${theme.color.border}`,
          }}
        >
          {children.length === 0 ? (
            <EmptyOverrides
              serviceLabel={serviceLabel}
              canAdd={canAddOverride}
            />
          ) : (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                border: `1px solid ${theme.color.border}`,
                borderRadius: theme.radius.input,
                background: theme.color.surface,
                overflow: 'hidden',
              }}
            >
              {children.map((c, i) => (
                <ChildRow
                  key={c.id}
                  isFirst={i === 0}
                  dot={dot}
                  row={c}
                  parentPhases={phases.data}
                  parentLabel={serviceLabel}
                  pools={pools}
                  onEdit={() => onEditChild(c)}
                  onRemove={() => onRemoveChild(c)}
                  onChanged={onPhaseSaved}
                  onReordered={onPhaseReordered}
                  onError={onPhaseError}
                />
              ))}
            </ul>
          )}

          {canAddOverride ? (
            <AddOverrideButton onClick={() => setAddSheetOpen(true)} />
          ) : null}
        </div>
      </Collapse>

      <PhaseEditor
        open={phaseEditorTarget !== null}
        target={phaseEditorTarget}
        pools={pools}
        onClose={() => setPhaseEditorTarget(null)}
        onSave={handlePhaseSave}
        onDelete={handlePhaseDelete}
      />

      <PatientFacingDurationEditor
        open={patientFacingOpen}
        configId={parent.id}
        serviceLabel={serviceLabel}
        currentOverrideMin={parent.patient_facing_min_minutes}
        currentOverrideMax={parent.patient_facing_max_minutes}
        operationalMinutes={operationalMinutes}
        onClose={() => setPatientFacingOpen(false)}
        onSave={handlePatientFacingSave}
      />

      <AddOverrideSheet
        open={addSheetOpen}
        serviceLabel={serviceLabel}
        serviceType={serviceType}
        axes={axes}
        existingChildren={children}
        onClose={() => setAddSheetOpen(false)}
        onCreate={(pins) => {
          setAddSheetOpen(false);
          onAddChild({
            kind: 'new-child',
            service_type: serviceType,
            pins,
          });
        }}
      />
    </li>
  );
}

// Disclosure button below the parent ribbon — the explicit "open/
// close overrides" affordance. Replaces the ambiguous static count
// pill that used to sit on the right of the parent header. Reads as
// a button (chevron + label) and announces state via aria-expanded.
//
// Copy switches based on count:
//   0 + can-add → "Add an override"
//   0 + cannot   → null (no axes for this service, nothing to expand)
//   N            → "1 override · Show" / "N overrides · Show" /
//                  "Hide" when expanded
function OverridesDisclosure({
  expanded,
  onToggle,
  count,
  canAdd,
  serviceLabel,
}: {
  expanded: boolean;
  onToggle: () => void;
  count: number;
  canAdd: boolean;
  serviceLabel: string;
}) {
  if (count === 0 && !canAdd) return null;

  const labelWhenExpanded = count === 0 ? 'Hide' : 'Hide overrides';
  const labelWhenCollapsed = count === 0
    ? 'Add an override'
    : `${count} ${count === 1 ? 'override' : 'overrides'}`;

  return (
    <div
      style={{
        padding: `0 ${theme.space[5]}px ${theme.space[3]}px ${theme.space[8]}px`,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${expanded ? labelWhenExpanded : labelWhenCollapsed} for ${serviceLabel}`}
        style={{
          appearance: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[2],
          padding: `${theme.space[2]}px ${theme.space[3]}px`,
          borderRadius: theme.radius.pill,
          border: `1px solid ${theme.color.border}`,
          background: theme.color.surface,
          color: theme.color.ink,
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.medium,
          cursor: 'pointer',
          fontFamily: 'inherit',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <ChevronRight
          size={14}
          aria-hidden
          style={{
            transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.spring}`,
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            color: theme.color.inkMuted,
          }}
        />
        <span>{expanded ? labelWhenExpanded : labelWhenCollapsed}</span>
      </button>
    </div>
  );
}

// Animated open/close container using the grid-template-rows 0fr/1fr
// trick. Smoothly transitions height without measuring children. The
// inner div has min-height: 0 + overflow: hidden so the grid row can
// collapse to zero. Contents are still rendered when closed (so any
// internal state is preserved between open/close cycles), just
// height-clipped.
function Collapse({
  open,
  children,
}: {
  open: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: open ? '1fr' : '0fr',
        transition: `grid-template-rows ${theme.motion.duration.base}ms ${theme.motion.easing.standard}`,
      }}
      aria-hidden={!open}
    >
      <div style={{ minHeight: 0, overflow: 'hidden' }}>{children}</div>
    </div>
  );
}

// Subtle icon button. Used for the cog and the overflow trash actions
// — distinct from a pill button visually so a row's visual weight
// stays balanced.
function IconAction({
  ariaLabel,
  onClick,
  icon,
  tone = 'default',
}: {
  ariaLabel: string;
  onClick: (e: React.MouseEvent) => void;
  icon: React.ReactNode;
  tone?: 'default' | 'danger';
}) {
  const colour = tone === 'danger' ? theme.color.alert : theme.color.inkMuted;
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      style={{
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        padding: theme.space[2],
        margin: -theme.space[1],
        borderRadius: theme.radius.input,
        color: colour,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        WebkitTapHighlightColor: 'transparent',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {icon}
    </button>
  );
}

// Empty state when a service has no overrides yet. Quiet card with
// icon + copy + (no inline action — the AddOverrideRow below handles
// adding so we don't double up the affordance).
function EmptyOverrides({
  serviceLabel,
  canAdd,
}: {
  serviceLabel: string;
  canAdd: boolean;
}) {
  return (
    <div
      style={{
        border: `1px dashed ${theme.color.border}`,
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
      }}
    >
      <span
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: theme.color.bg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: theme.color.inkMuted,
          flexShrink: 0,
        }}
      >
        <Sparkles size={16} aria-hidden />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.medium,
            color: theme.color.ink,
          }}
        >
          No overrides yet
        </p>
        <p
          style={{
            margin: `2px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            lineHeight: 1.5,
          }}
        >
          Every {serviceLabel.toLowerCase()} booking uses the parent defaults.
          {canAdd ? ' Add the first override below to deviate for a specific case.' : ''}
        </p>
      </div>
    </div>
  );
}

// Child row inside an expanded service. Sits in a contained
// rectangle (border + radius on the parent ul); rows separated by
// hairlines, no per-row borders.
function ChildRow({
  isFirst,
  dot,
  row,
  parentPhases,
  parentLabel,
  pools,
  onEdit,
  onRemove,
  onChanged,
  onReordered,
  onError,
}: {
  isFirst: boolean;
  dot: string;
  row: BookingTypeConfigRow;
  parentPhases: BookingTypePhaseRow[];
  parentLabel: string;
  pools: ResourcePoolRow[];
  onEdit: () => void;
  onRemove: () => void;
  onChanged: () => void;
  /** Toast-only callback for drag-and-drop reorder. Does not refetch
   *  the parent config list. See parent for rationale. */
  onReordered: () => void;
  onError: (msg: string) => void;
}) {
  const childPhases = useBookingTypePhases(row.id);
  const [phaseEditorTarget, setPhaseEditorTarget] = useState<PhaseEditorTarget | null>(null);
  const [patientFacingOpen, setPatientFacingOpen] = useState(false);

  // Map of phase_index → child override row (when one exists). The
  // resolver does this server-side too, but for the editor we want
  // the raw child row so we can edit / delete it directly.
  const childOverrideByIndex = useMemo(() => {
    const m = new Map<number, BookingTypePhaseRow>();
    for (const p of childPhases.data) m.set(p.phase_index, p);
    return m;
  }, [childPhases.data]);

  // Effective ribbon phases — mirrors the DB resolver
  // (lng_booking_type_resolve, M12 + M17). Two sources combined and
  // sorted by phase_index:
  //
  //   1. Every parent phase, with the child override applied
  //      wholesale at matching phase_index.
  //   2. Every child-only phase (phase_index not present on the
  //      parent) — variant-only steps the parent doesn't have.
  //
  // Without source 2 the override "+ Add" affordance would write a
  // row to lng_booking_type_phases but the ribbon would never render
  // it, because the iteration was driven by parentPhases alone.
  const ribbonPhases: PhaseRibbonPhase[] = useMemo(() => {
    const parentIndices = new Set(parentPhases.map((pp) => pp.phase_index));
    const fromParent = parentPhases.map((parentPhase) => {
      const override = childOverrideByIndex.get(parentPhase.phase_index);
      // Per M12, when a child phase row exists every field comes
      // from it; otherwise the parent's wholesale.
      const effective = override ?? parentPhase;
      return {
        key: String(parentPhase.phase_index),
        phase_index: parentPhase.phase_index,
        label: effective.label,
        patient_required: effective.patient_required,
        duration_minutes: effective.duration_default ?? 0,
        pool_ids: effective.pool_ids,
      } satisfies PhaseRibbonPhase;
    });
    const fromChildOnly: PhaseRibbonPhase[] = childPhases.data
      .filter((cp) => !parentIndices.has(cp.phase_index))
      .map((cp) => ({
        key: String(cp.phase_index),
        phase_index: cp.phase_index,
        label: cp.label,
        patient_required: cp.patient_required,
        duration_minutes: cp.duration_default ?? 0,
        pool_ids: cp.pool_ids,
      }));
    return [...fromParent, ...fromChildOnly].sort(
      (a, b) => a.phase_index - b.phase_index,
    );
  }, [parentPhases, childOverrideByIndex, childPhases.data]);

  const operationalMinutes = ribbonPhases.reduce(
    (acc, p) => acc + (p.duration_minutes || 0),
    0,
  );
  const patientInMinutes = ribbonPhases
    .filter((p) => p.patient_required)
    .reduce((acc, p) => acc + (p.duration_minutes || 0), 0);
  const patientFacingMin = row.patient_facing_min_minutes ?? operationalMinutes;
  const patientFacingMax = row.patient_facing_max_minutes;

  const handleChildPhaseSave = async (values: PhaseEditorValues) => {
    try {
      const phaseId = await upsertBookingTypePhase({
        id: values.id,
        config_id: values.config_id,
        phase_index: values.phase_index,
        label: values.label,
        patient_required: values.patient_required,
        duration_default: values.duration_default,
        duration_min: values.duration_min,
        duration_max: values.duration_max,
        notes: values.notes,
      });
      // Child override pools live on the child phase id (M12 row-level
      // override semantics) so the resolver returns them when the
      // child row is present.
      await setPhasePoolIds(phaseId, values.pool_ids);
      childPhases.reload();
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not save override');
      throw e;
    }
  };

  const handleChildPhaseDelete = async (phaseId: string) => {
    try {
      await deleteBookingTypePhase(phaseId);
      childPhases.reload();
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not reset override');
      throw e;
    }
  };

  const handleChildPatientFacingSave = async (values: {
    min: number | null;
    max: number | null;
  }) => {
    try {
      await upsertBookingTypeConfig({
        service_type: row.service_type,
        repair_variant: row.repair_variant,
        product_key: row.product_key,
        arch: row.arch,
        patient_facing_min_minutes: values.min,
        patient_facing_max_minutes: values.max,
      });
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not save');
      throw e;
    }
  };

  return (
    <li
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderTop: isFirst ? 'none' : `1px solid ${theme.color.border}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: dot,
            flexShrink: 0,
            opacity: 0.5,
          }}
        />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span
            style={{
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
            }}
          >
            {bookingTypeRowLabel(row)}
          </span>
        </div>
        <IconAction
          ariaLabel={`Configure ${bookingTypeRowLabel(row)}`}
          onClick={onEdit}
          icon={<Settings2 size={16} aria-hidden />}
        />
        <IconAction
          ariaLabel={`Remove override for ${bookingTypeRowLabel(row)}`}
          onClick={onRemove}
          icon={<Trash2 size={16} aria-hidden />}
          tone="danger"
        />
      </div>

      {parentPhases.length > 0 && !childPhases.loading && (
        <div style={{ paddingLeft: 14 }}>
          <PhaseRibbon
            phases={ribbonPhases}
            operational_minutes={operationalMinutes}
            patient_in_minutes={patientInMinutes}
            patient_facing_min_minutes={patientFacingMin}
            patient_facing_max_minutes={patientFacingMax}
            onPhaseClick={(key) => {
              const phaseIndex = Number.parseInt(key, 10);
              const parentPhase = parentPhases.find((pp) => pp.phase_index === phaseIndex);
              if (parentPhase) {
                // Phase exists on parent — open the override
                // editor so the admin sees inherited values + can
                // edit divergences.
                setPhaseEditorTarget({
                  kind: 'child-override',
                  childConfigId: row.id,
                  parentPhase,
                  childOverride: childOverrideByIndex.get(phaseIndex) ?? null,
                  parentLabel,
                });
                return;
              }
              // Child-only phase (M17): no parent counterpart. Edit
              // the child row directly via the regular 'edit' kind.
              const childPhase = childOverrideByIndex.get(phaseIndex);
              if (childPhase) {
                setPhaseEditorTarget({ kind: 'edit', phase: childPhase });
              }
            }}
            onAddPhase={() =>
              // Append a phase that exists only on this override — at
              // an index beyond the parent's phase count, so the
              // resolver returns it after every inherited parent phase.
              // Useful for variants that need an extra step the parent
              // shape doesn't have (e.g. a "Fitting" phase only Relining
              // needs after Try In).
              setPhaseEditorTarget({
                kind: 'create',
                config_id: row.id,
                next_phase_index:
                  ribbonPhases.length === 0
                    ? 1
                    : Math.max(...ribbonPhases.map((p) => p.phase_index)) + 1,
              })
            }
            onReorder={async (orderedKeys) => {
              // Override-ribbon reorder. The chip key is the
              // phase_index as a string (see ribbonPhases above —
              // child and parent phases share that key space). To
              // materialise the new order we snapshot every effective
              // phase's full payload (label / patient_required /
              // durations / pool_ids) from whichever source is current
              // — child override row when present, otherwise the
              // parent row — and ship the array to lng_reorder_child
              // _phases, which wipes the override's existing rows and
              // inserts fresh ones in array order. After this the
              // override fully owns its shape; parent edits to label /
              // duration / pools no longer flow through at these
              // indices. Operators are free to delete an override
              // phase later to re-inherit.
              try {
                const entries = orderedKeys.map((key) => {
                  const phaseIndex = Number.parseInt(key, 10);
                  const override = childOverrideByIndex.get(phaseIndex);
                  const parent = parentPhases.find(
                    (pp) => pp.phase_index === phaseIndex,
                  );
                  const source = override ?? parent;
                  if (!source) {
                    throw new Error(
                      `reorder: no source row for phase_index ${phaseIndex}`,
                    );
                  }
                  return {
                    label: source.label,
                    patient_required: source.patient_required,
                    duration_min: source.duration_min ?? null,
                    duration_max: source.duration_max ?? null,
                    duration_default: source.duration_default ?? null,
                    pool_ids: source.pool_ids,
                  };
                });
                await reorderChildPhases(row.id, entries);
                // Silent refetch — the hook keeps showing the
                // existing ribbon during the round-trip so the
                // chips don't flash a skeleton mid-interaction.
                // onReordered is toast-only by design (does NOT
                // refetch the parent config list, which would
                // re-mount the row and collapse the override
                // dropdown).
                childPhases.reload();
                onReordered();
              } catch (e) {
                onError(
                  e instanceof Error ? e.message : 'Could not reorder phases',
                );
              }
            }}
            onEditPatientFacing={() => setPatientFacingOpen(true)}
          />
        </div>
      )}

      <PhaseEditor
        open={phaseEditorTarget !== null}
        target={phaseEditorTarget}
        pools={pools}
        onClose={() => setPhaseEditorTarget(null)}
        onSave={handleChildPhaseSave}
        onDelete={handleChildPhaseDelete}
      />

      <PatientFacingDurationEditor
        open={patientFacingOpen}
        configId={row.id}
        serviceLabel={bookingTypeRowLabel(row)}
        currentOverrideMin={row.patient_facing_min_minutes}
        currentOverrideMax={row.patient_facing_max_minutes}
        operationalMinutes={operationalMinutes}
        onClose={() => setPatientFacingOpen(false)}
        onSave={handleChildPatientFacingSave}
      />
    </li>
  );
}

// "+ Add override" trigger button. Always full-width with a dashed
// border so it reads as a "create something new" affordance, not a
// primary action. Same visual language as the empty-state cards
// elsewhere in the app.
function AddOverrideButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        border: `1px dashed ${theme.color.border}`,
        background: 'transparent',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.medium,
        color: theme.color.inkMuted,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        marginTop: theme.space[3],
        width: '100%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space[2],
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <Plus size={14} aria-hidden /> Add an override
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AddOverrideSheet — multi-axis picker for creating a new override row.
// Renders one DropdownSelect per axis the service declares, each with
// an "Any" option meaning "leave this axis unpinned". On Save, calls
// back with the AxisPin[] for the non-"Any" picks. Refuses to save
// when no axis is pinned (that would be the parent), and detects
// duplicate combinations against the existing children list so the
// admin gets a clear "you already have this" error instead of a DB
// unique-constraint failure.
// ─────────────────────────────────────────────────────────────────────────────

const ANY_VALUE = '__any__';

function AddOverrideSheet({
  open,
  serviceLabel,
  serviceType,
  axes,
  existingChildren,
  onClose,
  onCreate,
}: {
  open: boolean;
  serviceLabel: string;
  serviceType: BookingServiceType;
  axes: readonly AxisDef[];
  existingChildren: BookingTypeConfigRow[];
  onClose: () => void;
  onCreate: (pins: AxisPin[]) => void;
}) {
  // picks: per-axis selection. ANY_VALUE = "Any" (axis stays unpinned).
  // Empty string = "not yet picked" (forces the admin to commit a
  // choice, even if it's "Any", before Save activates).
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [optionsByAxis, setOptionsByAxis] = useState<Record<string, AxisValueOption[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state every time the sheet opens. Each axis defaults to
  // ANY_VALUE so the dropdowns read "Any product / Any arch" out of
  // the box — the admin only has to touch the dimensions they want
  // to pin. Without this default, Save stayed disabled until they
  // explicitly clicked "Any" on every axis they didn't care about,
  // which made arch-only overrides feel like extra work.
  useEffect(() => {
    if (!open) return;
    setError(null);
    const seed: Record<string, string> = {};
    for (const a of axes) seed[a.key] = ANY_VALUE;
    setPicks(seed);
    setLoading(true);
    let cancelled = false;
    void (async () => {
      const map: Record<string, AxisValueOption[]> = {};
      for (const axis of axes) {
        map[axis.key] = await loadAxisValues(axis);
      }
      if (cancelled) return;
      setOptionsByAxis(map);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, axes]);

  // Compute the candidate pin set from current picks. ANY_VALUE picks
  // mean "axis stays unpinned" → not in pins.
  const candidatePins: AxisPin[] = axes
    .map((a) => {
      const v = picks[a.key];
      if (!v || v === ANY_VALUE) return null;
      return { key: a.key, value: v } as AxisPin;
    })
    .filter((p): p is AxisPin => p !== null);

  const hasAtLeastOnePin = candidatePins.length > 0;

  // Duplicate detection: an existing child row has the same axis
  // pinning when, for every axis the registry declares, both rows
  // pin the same value (or both leave it unpinned).
  const duplicate = existingChildren.find((c) => {
    return axes.every((a) => {
      const cVal =
        a.key === 'repair_variant' ? c.repair_variant
        : a.key === 'product_key' ? c.product_key
        : a.key === 'arch' ? c.arch
        : null;
      const pickedVal = picks[a.key] === ANY_VALUE ? null : (picks[a.key] || null);
      return (cVal ?? null) === (pickedVal ?? null);
    });
  });

  const canSave = hasAtLeastOnePin && !duplicate && !loading;

  const handleSave = () => {
    if (!hasAtLeastOnePin) {
      setError('Pick a specific value for at least one dimension. "Any" everywhere is the parent default.');
      return;
    }
    if (duplicate) {
      setError('An override with this exact combination already exists.');
      return;
    }
    onCreate(candidatePins);
  };

  // Each axis option is the registry-supplied list plus an "Any" entry
  // at the top. Memoised so the DropdownSelect doesn't see a new array
  // identity on every render.
  const renderAxis = (axis: AxisDef) => {
    const opts = optionsByAxis[axis.key] ?? [];
    const dropdownOptions = [
      { value: ANY_VALUE, label: `Any ${axis.label.toLowerCase()}` },
      ...opts.map((o) => ({ value: o.key, label: o.label })),
    ];
    return (
      <div key={axis.key} style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        <label
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          {axis.label}
        </label>
        <DropdownSelect<string>
          ariaLabel={`Pick ${axis.label}`}
          value={picks[axis.key] ?? ANY_VALUE}
          placeholder={`Any ${axis.label.toLowerCase()}`}
          options={dropdownOptions}
          onChange={(v) => {
            setError(null);
            setPicks((prev) => ({ ...prev, [axis.key]: v }));
          }}
        />
      </div>
    );
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={`Add an override for ${serviceLabel.toLowerCase()}`}
      description={
        axes.length > 1
          ? `Pick a value for any combination of dimensions below. "Any" leaves a dimension unpinned so the override applies broadly across it.`
          : `Pick the specific ${axes[0]?.label.toLowerCase() ?? 'value'} this override applies to.`
      }
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: theme.space[3] }}>
          <span style={{ fontSize: theme.type.size.xs, color: theme.color.alert, minHeight: 16 }}>
            {error ?? (duplicate ? 'This combination already exists.' : '')}
          </span>
          <div style={{ display: 'flex', gap: theme.space[2] }}>
            <Button variant="tertiary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={!canSave}>
              Add override
            </Button>
          </div>
        </div>
      }
    >
      {loading ? (
        <Skeleton height={120} />
      ) : axes.length === 0 ? (
        <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          {serviceLabel} doesn't support overrides.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          {axes.map(renderAxis)}
          {/* Live preview of what this override will be called once
              saved. Helps the admin sanity-check before committing. */}
          {hasAtLeastOnePin ? (
            <div
              style={{
                marginTop: theme.space[2],
                padding: `${theme.space[3]}px ${theme.space[4]}px`,
                background: theme.color.bg,
                borderRadius: theme.radius.input,
                border: `1px solid ${theme.color.border}`,
              }}
            >
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                  letterSpacing: theme.type.tracking.wide,
                  textTransform: 'uppercase',
                  fontWeight: theme.type.weight.semibold,
                }}
              >
                Override label
              </p>
              <p
                style={{
                  margin: `${theme.space[1]}px 0 0`,
                  fontSize: theme.type.size.md,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.ink,
                }}
              >
                {pinnedAxesLabel(serviceType, candidatePinsToRow(candidatePins))}
              </p>
            </div>
          ) : null}
        </div>
      )}
    </BottomSheet>
  );
}

// Helper: shape the pin list back into a partial config-row so
// pinnedAxesLabel can read it. Inverse of axesPinned.
function candidatePinsToRow(pins: AxisPin[]): {
  repair_variant: string | null;
  product_key: string | null;
  arch: string | null;
} {
  return {
    repair_variant: pins.find((p) => p.key === 'repair_variant')?.value ?? null,
    product_key: pins.find((p) => p.key === 'product_key')?.value ?? null,
    arch: pins.find((p) => p.key === 'arch')?.value ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor dialog — one form for parent rows, child rows, and new-child rows.
// ─────────────────────────────────────────────────────────────────────────────

function BookingTypeEditorDialog({
  target,
  parent,
  onClose,
  onSaved,
  onError,
}: {
  target: EditTarget;
  parent: BookingTypeConfigRow | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  // Existing row vs new — drives initial values and the "inherits"
  // toggles below.
  const isNew = target.kind === 'new-child';
  const isParent = target.kind === 'parent';
  const row = isNew ? null : (target as { row: BookingTypeConfigRow }).row;

  // Clinic-wide hours are the bottom of the fallback chain: a parent
  // row with working_hours = null inherits from clinic; a child row
  // with working_hours = null inherits from its parent (which may
  // itself be inheriting from clinic). The editor surfaces this so
  // admins see what they're inheriting before choosing to override.
  const clinic = useClinicSettings();

  // Working-hours mode + buffer. Both parent and child surfaces share
  // the same toggle: 'inherit' writes null, 'custom' writes the array.
  // The semantic meaning differs (parent inherits clinic, child
  // inherits parent), but the data shape and toggle are identical.
  const initialHours: OpeningHoursWeek = (() => {
    const fromRow = row?.working_hours as OpeningHoursWeek | null | undefined;
    if (fromRow && fromRow.length === 7) return cloneHoursWeek(fromRow);
    if (parent?.working_hours && (parent.working_hours as OpeningHoursWeek).length === 7) {
      return cloneHoursWeek(parent.working_hours as OpeningHoursWeek);
    }
    return cloneHoursWeek(clinic.data.openingHours);
  })();
  const [hours, setHours] = useState<OpeningHoursWeek>(initialHours);
  const [hoursInherits, setHoursInherits] = useState<boolean>(() => {
    // New child / row without working_hours set defaults to "inherit"
    // so the admin opts in to a custom schedule rather than getting
    // surprised by stale defaults.
    if (isNew) return true;
    return !(row?.working_hours);
  });

  // Sync the prefill buffer with clinic settings as long as the row
  // is still inheriting AND no upstream source has set hours. The
  // useState initialiser runs before useClinicSettings has resolved,
  // so `hours` could otherwise hold the hard-coded DEFAULTS instead
  // of the actual clinic.opening_hours value. When the operator then
  // toggles to Custom we'd prefill from a stale baseline.
  useEffect(() => {
    if (!hoursInherits) return;
    const fromRow = row?.working_hours as OpeningHoursWeek | null | undefined;
    if (fromRow && fromRow.length === 7) return;
    const fromParent = parent?.working_hours as OpeningHoursWeek | null | undefined;
    if (fromParent && fromParent.length === 7) return;
    if (clinic.loading) return;
    setHours(cloneHoursWeek(clinic.data.openingHours));
  }, [hoursInherits, row?.working_hours, parent?.working_hours, clinic.loading, clinic.data.openingHours]);

  // Editable display label — admin can rename any override row.
  // Empty / whitespace = clear, falls back to the catalogue / arch /
  // service-derived label. Only shown for non-parent rows; the
  // parent label IS the service name.
  const [displayLabel, setDisplayLabel] = useState<string>(row?.display_label ?? '');

  const [notes, setNotes] = useState<string>(row?.notes ?? '');
  const [busy, setBusy] = useState(false);

  // Title for the editor sheet. For new multi-axis children, the
  // axes are joined into the same "Whitening Tray · Upper" chain
  // the override list uses, so the editor's header is consistent
  // with how the row will appear once saved.
  const newChildPinsLabel = (() => {
    if (target.kind !== 'new-child') return '';
    const stub = candidatePinsToRow(target.pins);
    return pinnedAxesLabel(target.service_type, stub);
  })();
  const title = isParent
    ? BOOKING_SERVICE_TYPES.find((s) => s.value === (row as BookingTypeConfigRow).service_type)?.label ?? 'Booking type'
    : isNew
    ? `${labelOfService((target as { service_type: BookingServiceType }).service_type)} · ${newChildPinsLabel}`
    : `${labelOfService((row as BookingTypeConfigRow).service_type)} · ${bookingTypeRowLabel(row as BookingTypeConfigRow)}`;

  // For new-child targets, look up which axes were pinned. The
  // editor maps these into the appropriate columns at write time.
  const newChildPinValue = (axisKey: AxisPin['key']): string | null => {
    if (target.kind !== 'new-child') return null;
    return target.pins.find((p) => p.key === axisKey)?.value ?? null;
  };

  // Any open day with a malformed lunch break is unsaveable — would
  // write a zero-length or inverted window to JSONB. Surfaced as a
  // disabled Save button + inline note below.
  const hoursHaveInvalidLunch = (() => {
    if (hoursInherits) return false;
    return hours.some((day) => {
      if (!day || day.closed === true) return false;
      const br = day.break;
      if (!br || br.length !== 2) return false;
      return br[1] <= br[0];
    });
  })();

  const save = async () => {
    if (hoursHaveInvalidLunch) return;
    setBusy(true);
    try {
      const trimmedLabel = displayLabel.trim();
      const payload: Parameters<typeof upsertBookingTypeConfig>[0] = {
        service_type:
          target.kind === 'new-child'
            ? target.service_type
            : (target as { row: BookingTypeConfigRow }).row.service_type,
        repair_variant:
          target.kind === 'new-child'
            ? newChildPinValue('repair_variant')
            : (target as { row: BookingTypeConfigRow }).row.repair_variant,
        product_key:
          target.kind === 'new-child'
            ? newChildPinValue('product_key')
            : (target as { row: BookingTypeConfigRow }).row.product_key,
        arch:
          target.kind === 'new-child'
            ? (newChildPinValue('arch') as 'upper' | 'lower' | 'both' | null)
            : ((target as { row: BookingTypeConfigRow }).row.arch),
        // Hours: 'inherit' clears the column so the resolver/fall-
        // through (child → parent → clinic) picks up the right value
        // at read time. 'custom' writes the array in clinic shape
        // (Mon-first, 7 entries, { closed } | { open, close, break? }).
        working_hours: hoursInherits ? null : hours,
        // display_label only meaningful for non-parent rows; the
        // parent's label is the service name and shouldn't be
        // overridden from this dialog.
        ...(isParent
          ? {}
          : { display_label: trimmedLabel === '' ? null : trimmedLabel }),
        notes: notes.trim() === '' ? null : notes.trim(),
      };

      // Duration columns are vestigial — the phase ribbon owns
      // duration now. We don't include them in the payload so
      // existing values stay untouched.

      await upsertBookingTypeConfig(payload);
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  // Resolver inheritance order for the sub copy: child inherits the
  // parent's row when its own column is null. The parent itself
  // inherits clinic-wide. The copy reflects the visible source so
  // admins read "inherits clinic hours" instead of staring at a
  // generic toggle.
  const inheritsSourceLabel = isParent
    ? 'clinic-wide hours'
    : parent?.working_hours
      ? 'the parent service’s hours'
      : 'clinic-wide hours (via the parent)';
  const inheritsPreview = (() => {
    if (isParent) return summariseHours(clinic.data.openingHours);
    if (parent?.working_hours && (parent.working_hours as OpeningHoursWeek).length === 7) {
      return summariseHours(parent.working_hours as OpeningHoursWeek);
    }
    return summariseHours(clinic.data.openingHours);
  })();

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={title}
      description={
        isParent
          ? 'These are the defaults that everything inside this service inherits from.'
          : 'Flip Override on for the sections that should differ from the parent. Sections left off read from the parent automatically.'
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
          <Button variant="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={save}
            loading={busy}
            disabled={hoursHaveInvalidLunch}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        {!isParent && (
          <DialogSection
            title="Title"
            sub="How this override appears in the booking-types tree, schedule cards, and emails. Leave blank to use the catalogue default."
            action={
              displayLabel.trim() !== '' &&
              displayLabel.trim() !== derivedLabelForTarget(target) ? (
                <ResetLink onClick={() => setDisplayLabel('')}>
                  Use catalogue default ({derivedLabelForTarget(target)})
                </ResetLink>
              ) : null
            }
          >
            <Input
              value={displayLabel}
              onChange={(e) => setDisplayLabel(e.target.value)}
              placeholder={derivedLabelForTarget(target)}
            />
          </DialogSection>
        )}

        <DialogSection
          title="Working hours"
          sub={
            hoursInherits
              ? `Inheriting ${inheritsSourceLabel}: ${inheritsPreview}. Switch to Custom to deviate just for this ${isParent ? 'service' : 'variant'}.`
              : `Custom hours just for this ${isParent ? 'service' : 'variant'}. Edit clinic-wide hours in Admin → Branding → Opening times.`
          }
          action={
            <SegmentedControl
              size="sm"
              value={hoursInherits ? 'inherit' : 'custom'}
              onChange={(v) => {
                const next = v === 'inherit';
                if (!next) {
                  // Switching INTO custom: always re-prefill from the
                  // current inheritance source. useClinicSettings may
                  // have only resolved AFTER mount, so the `hours`
                  // state initialised in useState could still be the
                  // hard-coded DEFAULTS — re-reading here picks up the
                  // real clinic hours the operator actually configured.
                  const fromRow = row?.working_hours as OpeningHoursWeek | null | undefined;
                  if (fromRow && fromRow.length === 7) {
                    setHours(cloneHoursWeek(fromRow));
                  } else if (parent?.working_hours && (parent.working_hours as OpeningHoursWeek).length === 7) {
                    setHours(cloneHoursWeek(parent.working_hours as OpeningHoursWeek));
                  } else {
                    setHours(cloneHoursWeek(clinic.data.openingHours));
                  }
                }
                setHoursInherits(next);
              }}
              options={[
                { value: 'inherit', label: isParent ? 'Use clinic hours' : 'Inherit from parent' },
                { value: 'custom', label: 'Custom hours' },
              ]}
            />
          }
        >
          {!hoursInherits ? (
            <WorkingHoursEditor value={hours} onChange={setHours} />
          ) : null}
        </DialogSection>

        <DialogSection
          title="Notes"
          sub="Optional. Anything internal staff should know."
        >
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything internal staff should know."
          />
        </DialogSection>
      </div>
    </BottomSheet>
  );
}

// Compute the catalogue / arch / service derived label for the
// current edit target, ignoring any admin override. Used by the
// Title section's "Use catalogue default" link copy.
function derivedLabelForTarget(target: EditTarget): string {
  if (target.kind === 'new-child') {
    return pinnedAxesLabel(target.service_type, candidatePinsToRow(target.pins));
  }
  return bookingTypeRowDerivedLabel(target.row);
}

// Section helper for the booking-type editor dialog. Mirrors the
// Arrival.tsx Section pattern (the canonical Lounge form section):
// bold H2 title, muted sub paragraph, optional right-aligned action
// slot, content below. Per the saved memory, no uppercase eyebrow
// labels — they read as low-priority captions on tablet, the H2
// pattern reads as the actual section it is.
function DialogSection({
  title,
  sub,
  action,
  children,
}: {
  title: string;
  sub?: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: theme.space[3],
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1], minWidth: 0 }}>
          <h2
            style={{
              margin: 0,
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
              color: theme.color.ink,
            }}
          >
            {title}
          </h2>
          {sub ? (
            <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              {sub}
            </p>
          ) : null}
        </div>
        {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
      </header>
      {children ? <div>{children}</div> : null}
    </section>
  );
}

// Small "reset to default" link button used in section action slots.
// Accent-coloured, no underline by default — matches the link
// affordance in PatientFacingDurationEditor.
function ResetLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        padding: 0,
        cursor: 'pointer',
        color: theme.color.accent,
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.medium,
        fontFamily: 'inherit',
        textAlign: 'right',
      }}
    >
      {children}
    </button>
  );
}

function labelOfService(s: BookingServiceType): string {
  return BOOKING_SERVICE_TYPES.find((x) => x.value === s)?.label ?? s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Working-hours helpers — share the OpeningHoursWeek shape with the
// clinic-wide editor. Mon-first 7-element array; each entry is either
// { closed: true } or { open, close, break?: [start, end] }.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_LABELS: readonly string[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

function cloneHoursWeek(week: OpeningHoursWeek): OpeningHoursWeek {
  return week.map((day) => {
    if (day.closed === true) return { closed: true } as OpeningHoursDay;
    return {
      open: day.open,
      close: day.close,
      ...(day.break ? { break: [day.break[0], day.break[1]] as [string, string] } : {}),
    } as OpeningHoursDay;
  }) as unknown as OpeningHoursWeek;
}

// One-line summary used in the editor sub-copy ("Mon–Fri 09:00–17:00,
// Sat closed") so admins see what they're inheriting without
// expanding the editor.
function summariseHours(week: OpeningHoursWeek | null | undefined): string {
  if (!week || week.length !== 7) return 'not set';
  const days: OpeningHoursDay[] = [
    week[0], week[1], week[2], week[3], week[4], week[5], week[6],
  ];
  const buckets: Array<{ key: string; days: number[] }> = [];
  for (let i = 0; i < days.length; i += 1) {
    const d = days[i]!;
    const key = d.closed === true
      ? 'closed'
      : `${d.open ?? '??:??'}-${d.close ?? '??:??'}${
          d.break ? ` (br ${d.break[0]}-${d.break[1]})` : ''
        }`;
    const lastBucket = buckets[buckets.length - 1];
    if (lastBucket && lastBucket.key === key) {
      lastBucket.days.push(i);
    } else {
      buckets.push({ key, days: [i] });
    }
  }
  return buckets
    .map((b) => {
      const first = b.days[0]!;
      const last = b.days[b.days.length - 1]!;
      const range = b.days.length === 1
        ? DAY_LABELS[first]!.slice(0, 3)
        : `${DAY_LABELS[first]!.slice(0, 3)}–${DAY_LABELS[last]!.slice(0, 3)}`;
      return `${range} ${b.key === 'closed' ? 'closed' : b.key}`;
    })
    .join(', ');
}

// WorkingHoursEditor — Mon-first row grid mirroring the Calendly /
// Shopify-admin pattern: one row per day, checkbox + label on the
// left, open/close TimeFields on the right, optional lunch-break
// sub-row underneath. Same shape used for the clinic-wide editor and
// for the per-booking-type override.
function WorkingHoursEditor({
  value,
  onChange,
}: {
  value: OpeningHoursWeek;
  onChange: (next: OpeningHoursWeek) => void;
}) {
  const setDay = (index: number, day: OpeningHoursDay) => {
    const next = value.slice() as unknown as OpeningHoursDay[];
    next[index] = day;
    onChange(next as unknown as OpeningHoursWeek);
  };

  // Apply-to-weekdays shortcut. Only surfaces when Monday's hours
  // actually differ from at least one weekday — avoids visual noise
  // when nothing's actionable.
  const monday = value[0];
  const sameDay = (a: OpeningHoursDay, b: OpeningHoursDay) => {
    if (a.closed === true || b.closed === true) {
      return a.closed === true && b.closed === true;
    }
    if (a.open !== b.open || a.close !== b.close) return false;
    const aBr = a.break;
    const bBr = b.break;
    if (!aBr && !bBr) return true;
    if (!aBr || !bBr) return false;
    return aBr[0] === bBr[0] && aBr[1] === bBr[1];
  };
  const canApplyMonday = !!monday && monday.closed !== true && [1, 2, 3, 4].some(
    (i) => {
      const other = value[i];
      if (!other) return false;
      return !sameDay(other, monday);
    },
  );
  const applyMondayToWeekdays = () => {
    if (!monday || monday.closed === true) return;
    const next = value.slice() as unknown as OpeningHoursDay[];
    for (let i = 1; i < 5; i += 1) {
      next[i] = {
        open: monday.open,
        close: monday.close,
        ...(monday.break ? { break: [monday.break[0], monday.break[1]] as [string, string] } : {}),
      } as OpeningHoursDay;
    }
    onChange(next as unknown as OpeningHoursWeek);
  };

  // Single zone banner above the day rows so a Cairo-based admin
  // (or anyone whose device isn't on UK time) doesn't have to guess
  // which clock these HH:MM values are in. Lounge stores working
  // hours as UK clinic wall-clock; we surface that explicitly here.
  const tzAbbr = fmtTzAbbr(new Date().toISOString());

  return (
    <div
      style={{
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: `${theme.space[2]}px ${theme.space[4]}px`,
          background: theme.color.bg,
          borderBottom: `1px solid ${theme.color.border}`,
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.inkMuted,
          letterSpacing: theme.type.tracking.wide,
          textTransform: 'uppercase',
        }}
      >
        All times shown in UK clinic time ({tzAbbr})
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {value.map((day, i) => {
          const closed = day.closed === true;
          const lunch = !closed ? day.break ?? null : null;
          const lunchInvalid = !!lunch && lunch[1] <= lunch[0];
          const toggleBreak = (next: boolean) => {
            if (closed) return;
            setDay(i, {
              open: day.open!,
              close: day.close!,
              ...(next ? { break: ['12:00', '13:00'] as [string, string] } : {}),
            } as OpeningHoursDay);
          };
          return (
            <li
              key={i}
              style={{
                display: 'flex',
                flexDirection: 'column',
                padding: `${theme.space[2]}px ${theme.space[3]}px`,
                borderTop: i === 0 ? 'none' : `1px solid ${theme.color.border}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], minHeight: 44 }}>
                <Checkbox
                  checked={!closed}
                  onChange={(c) =>
                    setDay(
                      i,
                      c
                        ? ({ open: '09:00', close: '18:00' } as OpeningHoursDay)
                        : ({ closed: true } as OpeningHoursDay),
                    )
                  }
                  size={18}
                  ariaLabel={`${DAY_LABELS[i]} open`}
                />
                <span
                  style={{
                    width: 96,
                    fontSize: theme.type.size.sm,
                    fontWeight: theme.type.weight.medium,
                    color: closed ? theme.color.inkMuted : theme.color.ink,
                  }}
                >
                  {DAY_LABELS[i]}
                </span>
                <div
                  style={{
                    marginLeft: 'auto',
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.space[2],
                  }}
                >
                  {closed ? (
                    <span
                      style={{
                        fontSize: theme.type.size.sm,
                        color: theme.color.inkSubtle,
                        fontStyle: 'italic',
                      }}
                    >
                      Closed
                    </span>
                  ) : (
                    <>
                      <TimeField
                        value={day.open!}
                        onChange={(t) =>
                          setDay(i, {
                            open: t,
                            close: day.close!,
                            ...(day.break ? { break: [day.break[0], day.break[1]] as [string, string] } : {}),
                          } as OpeningHoursDay)
                        }
                        ariaLabel={`${DAY_LABELS[i]} open time`}
                      />
                      <span aria-hidden style={{ fontSize: theme.type.size.sm, color: theme.color.inkSubtle }}>
                        —
                      </span>
                      <TimeField
                        value={day.close!}
                        onChange={(t) =>
                          setDay(i, {
                            open: day.open!,
                            close: t,
                            ...(day.break ? { break: [day.break[0], day.break[1]] as [string, string] } : {}),
                          } as OpeningHoursDay)
                        }
                        ariaLabel={`${DAY_LABELS[i]} close time`}
                      />
                    </>
                  )}
                </div>
              </div>
              {!closed && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.space[3],
                    padding: `0 0 ${theme.space[2]}px 30px`,
                    fontSize: theme.type.size.xs,
                    color: theme.color.inkMuted,
                  }}
                >
                  <Checkbox
                    checked={!!lunch}
                    onChange={(c) => toggleBreak(c)}
                    size={16}
                    ariaLabel={`${DAY_LABELS[i]} lunch break`}
                  />
                  <span style={{ width: 78 }}>Lunch break</span>
                  {lunch ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
                      <TimeField
                        value={lunch[0]}
                        onChange={(t) =>
                          setDay(i, {
                            open: day.open!,
                            close: day.close!,
                            break: [t, lunch[1]] as [string, string],
                          } as OpeningHoursDay)
                        }
                        ariaLabel={`${DAY_LABELS[i]} lunch start`}
                      />
                      <span aria-hidden style={{ color: theme.color.inkSubtle }}>—</span>
                      <TimeField
                        value={lunch[1]}
                        onChange={(t) =>
                          setDay(i, {
                            open: day.open!,
                            close: day.close!,
                            break: [lunch[0], t] as [string, string],
                          } as OpeningHoursDay)
                        }
                        ariaLabel={`${DAY_LABELS[i]} lunch end`}
                      />
                      {lunchInvalid ? (
                        <span style={{ color: theme.color.alert, marginLeft: theme.space[2] }}>
                          End must be after start
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {canApplyMonday ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            padding: `${theme.space[2]}px ${theme.space[3]}px`,
            borderTop: `1px solid ${theme.color.border}`,
            background: theme.color.bg,
          }}
        >
          <button
            type="button"
            onClick={applyMondayToWeekdays}
            style={{
              appearance: 'none',
              border: 'none',
              background: 'transparent',
              padding: 0,
              cursor: 'pointer',
              color: theme.color.accent,
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.medium,
              fontFamily: 'inherit',
            }}
          >
            Apply Monday to weekdays
          </button>
        </div>
      ) : null}
    </div>
  );
}

// Lightweight time-of-day field. Renders a native <input type="time">
// but styled to match the rest of the form. Inline styles only —
// honours the Lounge no-Tailwind rule.
function TimeField({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
}) {
  return (
    <input
      type="time"
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      style={{
        appearance: 'none',
        WebkitAppearance: 'none',
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        color: theme.color.ink,
        fontSize: theme.type.size.sm,
        fontFamily: 'inherit',
        padding: `${theme.space[1]}px ${theme.space[2]}px`,
        minWidth: 96,
        height: 36,
      }}
    />
  );
}

