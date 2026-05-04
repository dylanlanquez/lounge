import { useEffect, useMemo, useState } from 'react';
import { Box, Check, ChevronDown, ChevronRight, Layers, Plus, Settings2, Trash2, UserCircle2 } from 'lucide-react';
import {
  BottomSheet,
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton,
  StatusPill,
  Toast,
} from '../components/index.ts';
import { theme } from '../theme/index.ts';
import {
  type BookingServiceType,
  type ResourcePoolKind,
  type ResourcePoolRow,
  BOOKING_SERVICE_TYPES,
  deleteResourcePool,
  isValidPoolId,
  poolIdFromDisplayName,
  upsertResourcePool,
  useResourcePools,
  useResourceUsage,
} from '../lib/queries/bookingTypes.ts';
import { useStaff, type StaffRow } from '../lib/queries/staff.ts';
import {
  setStaffPoolAssignments,
  useAllStaffPoolAssignments,
} from '../lib/queries/staffPoolAssignments.ts';

// Conflicts & capacity tab — operator-facing settings page that
// drives the reschedule conflict checker. Three sections in operator
// language, leading with the *outcome* the page produces:
//
//   1. "What can happen at once" — plain-English summary, per
//      service, of how many of itself can run concurrently and which
//      other services it can or can't be paired with (and why).
//      First thing the eye lands on because this is the answer to
//      "what does this page do for me".
//
//   2. "Things in your clinic" — the literal furniture and equipment
//      that limits how many bookings can happen at once. Add, edit,
//      or remove. EmptyState pattern when nothing is set up yet.
//
//   3. "What each booking needs" — per-service sentences:
//      "Click-in veneers needs 1 chair + the lab bench, max 1 at
//      the same time." Editing opens a focused dialog so the
//      micro-controls have room to breathe.
//
//   4. "How this works" (collapsed) — a single paragraph for the
//      curious. Tucked at the bottom because the live summary
//      already explains what's enforced.
//
// Visual primitives are reused, not reinvented: EmptyState,
// StatusPill, Tooltip, Card, Dialog, Button, Input, DropdownSelect,
// Toast all come from src/components.

export function AdminConflictsTab() {
  const pools = useResourcePools();
  const usage = useResourceUsage();
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string } | null>(null);

  if (pools.error || usage.error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load resources: {pools.error || usage.error}
        </p>
      </Card>
    );
  }
  if (pools.loading || usage.loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        <Skeleton height={120} />
        <Skeleton height={240} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
      <PageHeader />

      <ResourcesSection
        pools={pools.data}
        usageByPool={usage.byPoolId}
        onChanged={() => {
          pools.reload();
          usage.reload();
        }}
        onToast={setToast}
      />

      <HowThisWorks />

      {toast ? (
        <Toast tone={toast.tone} title={toast.title} onDismiss={() => setToast(null)} />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page header
// ─────────────────────────────────────────────────────────────────────────────

function PageHeader() {
  return (
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
        <Layers size={20} aria-hidden style={{ color: theme.color.inkMuted }} /> Resources
      </h2>
      <p
        style={{
          margin: `${theme.space[2]}px 0 0`,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          lineHeight: 1.55,
          maxWidth: 680,
        }}
      >
        The chairs, rooms, equipment, and staff roles that limit how many
        bookings can run at once. Set them up here, then pick which ones each
        phase needs in <strong>Booking types</strong>. Lounge prevents
        double-bookings automatically.
      </p>
    </header>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Resources section — "Things in your clinic"
// ─────────────────────────────────────────────────────────────────────────────

type EditPoolTarget =
  | { kind: 'new' }
  | { kind: 'edit'; pool: ResourcePoolRow };

function ResourcesSection({
  pools,
  usageByPool,
  onChanged,
  onToast,
}: {
  pools: ResourcePoolRow[];
  // Map of pool_id → list of service types whose phases consume the
  // resource. Pre-computed by useResourceUsage in the parent so this
  // component is render-only.
  usageByPool: Map<string, BookingServiceType[]>;
  onChanged: () => void;
  onToast: (t: { tone: 'success' | 'error'; title: string }) => void;
}) {
  const [editing, setEditing] = useState<EditPoolTarget | null>(null);
  // Staff registry + the staff↔pool assignment matrix. Both live one
  // up-tree from PoolRow because every staff_role pool needs to render
  // its assigned-staff chips and we don't want N hooks for N pools.
  const staff = useStaff();
  const staffAssignments = useAllStaffPoolAssignments();

  // Staff lookup keyed by id for fast name resolution inside rows.
  const staffById = useMemo(() => {
    const m = new Map<string, StaffRow>();
    for (const s of staff.data) m.set(s.staff_member_id, s);
    return m;
  }, [staff.data]);

  // Split pools into the two visual groups. Same conflict semantics
  // apply to both — this is purely a presentation split so the
  // admin can scan resources and staff roles without mixing them.
  const resourcePools = useMemo(
    () => pools.filter((p) => p.kind === 'resource'),
    [pools],
  );
  const staffRolePools = useMemo(
    () => pools.filter((p) => p.kind === 'staff_role'),
    [pools],
  );

  // Removing a pool cascades through the FK on
  // lng_booking_service_pools.pool_id (and lng_staff_pool_assignments
  // for staff_role pools), so the database happily detaches every
  // mapping in one delete. The earlier guard that blocked removal
  // when "in use" was over-protective — staff would land on a toast
  // with no obvious next step. Replaced with a confirmation dialog
  // that names exactly what's tied to the pool so the operator can
  // make the call with eyes open.
  const [removeTarget, setRemoveTarget] = useState<ResourcePoolRow | null>(null);
  const [removing, setRemoving] = useState(false);

  const requestRemove = (poolId: string) => {
    const pool = pools.find((p) => p.id === poolId);
    if (!pool) return;
    setRemoveTarget(pool);
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await deleteResourcePool(removeTarget.id);
      onToast({ tone: 'success', title: `Removed ${removeTarget.display_name}` });
      onChanged();
      staffAssignments.refresh();
      setRemoveTarget(null);
    } catch (e) {
      onToast({
        tone: 'error',
        title: e instanceof Error ? e.message : 'Could not remove',
      });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Card padding="none">
      <SectionHeader
        icon={<Box size={16} aria-hidden />}
        title="Your resources"
        subtitle="The things and people that limit how many bookings can run at once. Spaces and equipment, plus staff roles like an impression taker or a denture tech. Pick which ones each phase needs in Booking types."
        action={
          <Button variant="tertiary" size="sm" onClick={() => setEditing({ kind: 'new' })}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <Plus size={14} aria-hidden /> Add
            </span>
          </Button>
        }
      />
      {pools.length === 0 ? (
        <EmptyState
          icon={<Box size={20} />}
          title="Add your first resource"
          description="Most clinics start with chairs (one booking per chair), a lab bench, and a consult room. Add staff roles too if a service needs a specific team member, like an impression taker."
          action={
            <Button variant="primary" size="sm" onClick={() => setEditing({ kind: 'new' })}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                <Plus size={14} aria-hidden /> Add the first one
              </span>
            </Button>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <PoolGroup
            title="Spaces & equipment"
            emptyText="No physical resources yet."
            pools={resourcePools}
            usageByPool={usageByPool}
            staffAssignmentsByPool={staffAssignments.byPoolId}
            staffById={staffById}
            onEdit={(pool) => setEditing({ kind: 'edit', pool })}
            onRemove={requestRemove}
          />
          <PoolGroup
            title="Staff roles"
            emptyText="No staff roles yet. Add one when a service needs a specific kind of staff member, like an impression taker. Capacity is the count of active staff you assign."
            pools={staffRolePools}
            usageByPool={usageByPool}
            staffAssignmentsByPool={staffAssignments.byPoolId}
            staffById={staffById}
            onEdit={(pool) => setEditing({ kind: 'edit', pool })}
            onRemove={requestRemove}
          />
        </div>
      )}

      {editing ? (
        <PoolEditorDialog
          target={editing}
          existing={pools}
          activeStaff={staff.data.filter((s) => s.status === 'active')}
          initialStaffIds={
            editing.kind === 'edit'
              ? staffAssignments.byPoolId[editing.pool.id] ?? []
              : []
          }
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onToast({ tone: 'success', title: 'Saved' });
            onChanged();
            staffAssignments.refresh();
          }}
          onError={(msg) => onToast({ tone: 'error', title: msg })}
        />
      ) : null}

      {removeTarget ? (
        <RemovePoolDialog
          pool={removeTarget}
          consumers={usageByPool.get(removeTarget.id) ?? []}
          assignedStaff={
            removeTarget.kind === 'staff_role'
              ? (staffAssignments.byPoolId[removeTarget.id] ?? [])
                  .map((sid) => staffById.get(sid))
                  .filter((s): s is StaffRow => !!s)
              : []
          }
          removing={removing}
          onCancel={() => (removing ? undefined : setRemoveTarget(null))}
          onConfirm={confirmRemove}
        />
      ) : null}
    </Card>
  );
}

// Confirmation dialog for removing a resource pool. Names every
// mapping that goes with it (booking types, assigned staff) so the
// admin doesn't accidentally erase a critical constraint, and
// follows through with a single cascade-delete on confirm.
function RemovePoolDialog({
  pool,
  consumers,
  assignedStaff,
  removing,
  onCancel,
  onConfirm,
}: {
  pool: ResourcePoolRow;
  consumers: BookingServiceType[];
  assignedStaff: StaffRow[];
  removing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const consumerLabels = consumers.map(
    (s) => BOOKING_SERVICE_TYPES.find((b) => b.value === s)?.label ?? s,
  );
  const hasConsumers = consumerLabels.length > 0;
  const hasStaff = assignedStaff.length > 0;
  const isClean = !hasConsumers && !hasStaff;

  return (
    <BottomSheet
      open
      onClose={onCancel}
      title={`Remove ${pool.display_name}?`}
      description={
        isClean ? (
          <span>
            Nothing in your clinic uses this. Removing it is a clean wipe, no booking types or staff are tied to it.
          </span>
        ) : (
          <span>
            Removing this also untangles every mapping that depends on it. Existing bookings keep their slots; future bookings of the listed services will no longer be capped by this resource.
          </span>
        )
      }
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[2] }}>
          <Button variant="tertiary" onClick={onCancel} disabled={removing}>
            Keep it
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            loading={removing}
            disabled={removing}
          >
            {removing ? 'Removing…' : 'Remove'}
          </Button>
        </div>
      }
    >
      {isClean ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          {hasConsumers ? (
            <RemovePoolImpactList
              eyebrow={
                consumerLabels.length === 1
                  ? '1 booking type currently consumes this'
                  : `${consumerLabels.length} booking types currently consume this`
              }
              items={consumerLabels}
            />
          ) : null}
          {hasStaff ? (
            <RemovePoolImpactList
              eyebrow={
                assignedStaff.length === 1
                  ? '1 staff member is assigned to this role'
                  : `${assignedStaff.length} staff members are assigned to this role`
              }
              items={assignedStaff.map((s) => s.display_name)}
            />
          ) : null}
        </div>
      )}
    </BottomSheet>
  );
}

function RemovePoolImpactList({
  eyebrow,
  items,
}: {
  eyebrow: string;
  items: string[];
}) {
  return (
    <div
      style={{
        background: theme.color.bg,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.input,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 11,
          fontWeight: theme.type.weight.semibold,
          letterSpacing: theme.type.tracking.wide,
          textTransform: 'uppercase',
          color: theme.color.inkMuted,
        }}
      >
        {eyebrow}
      </p>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexWrap: 'wrap',
          gap: theme.space[2],
        }}
      >
        {items.map((item) => (
          <li
            key={item}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: `${theme.space[1]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.pill,
              background: theme.color.surface,
              border: `1px solid ${theme.color.border}`,
              fontSize: theme.type.size.sm,
              color: theme.color.ink,
              fontWeight: theme.type.weight.medium,
            }}
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Sub-group inside the Things-in-your-clinic card. One per pool
// kind (Spaces & equipment / Staff roles). Renders an eyebrow
// header + the matching rows, or a quiet "none yet" hint when
// the group is empty.
function PoolGroup({
  title,
  emptyText,
  pools,
  usageByPool,
  staffAssignmentsByPool,
  staffById,
  onEdit,
  onRemove,
}: {
  title: string;
  emptyText: string;
  pools: ResourcePoolRow[];
  usageByPool: Map<string, BookingServiceType[]>;
  staffAssignmentsByPool: Record<string, string[]>;
  staffById: Map<string, StaffRow>;
  onEdit: (pool: ResourcePoolRow) => void;
  onRemove: (poolId: string) => void;
}) {
  return (
    <div
      style={{
        borderTop: `1px solid ${theme.color.border}`,
      }}
    >
      <div
        style={{
          padding: `${theme.space[3]}px ${theme.space[5]}px ${theme.space[2]}px`,
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: 11,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.wide,
            textTransform: 'uppercase',
            color: theme.color.inkMuted,
          }}
        >
          {title}
        </p>
      </div>
      {pools.length === 0 ? (
        <p
          style={{
            margin: 0,
            padding: `0 ${theme.space[5]}px ${theme.space[4]}px`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkSubtle,
            lineHeight: theme.type.leading.snug,
          }}
        >
          {emptyText}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {pools.map((p, i) => (
            <PoolRow
              key={p.id}
              isFirst={i === 0}
              pool={p}
              consumers={usageByPool.get(p.id) ?? []}
              assignedStaff={
                p.kind === 'staff_role'
                  ? (staffAssignmentsByPool[p.id] ?? [])
                      .map((sid) => staffById.get(sid))
                      .filter((s): s is StaffRow => !!s)
                  : []
              }
              onEdit={() => onEdit(p)}
              onRemove={() => onRemove(p.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PoolRow({
  isFirst,
  pool,
  consumers,
  assignedStaff,
  onEdit,
  onRemove,
}: {
  isFirst: boolean;
  pool: ResourcePoolRow;
  consumers: BookingServiceType[];
  /** Active staff assigned to this pool. Empty for non-staff-role pools. */
  assignedStaff: StaffRow[];
  onEdit: () => void;
  onRemove: () => void;
}) {
  const isStaffRole = pool.kind === 'staff_role';
  // Staff-role rows lead with the people in the role and treat
  // capacity as a derived consequence ("Sarah & Tom · 2 in this
  // role"), since that's how an admin scans the list. Resource rows
  // keep the original "We have N" copy because there's no list of
  // human names to render.
  // Resource pools surface "how many we have" and, when each unit
  // holds more than 1 patient, the per-unit factor too. Staff-role
  // rows lead with the people in the role.
  const resourceCountLine =
    pool.per_unit_capacity > 1
      ? `${pool.units} ${pool.units === 1 ? 'unit' : 'units'} · ${pool.per_unit_capacity} patients each · capacity ${pool.capacity}`
      : `We have ${pool.units}`;
  const summaryLine = isStaffRole
    ? assignedStaff.length === 0
      ? 'No staff assigned yet · the booking checker will block any service that needs this role'
      : pool.per_unit_capacity > 1
        ? `${formatStaffList(assignedStaff)} · ${assignedStaff.length} in this role · each handles ${pool.per_unit_capacity} at a time · capacity ${pool.capacity}`
        : `${formatStaffList(assignedStaff)} · ${assignedStaff.length} in this role`
    : `${resourceCountLine}${
        consumers.length > 0
          ? ` · used by ${consumers.length} booking type${consumers.length === 1 ? '' : 's'}`
          : ' · not in use yet'
      }`;
  // Pill copy: staff_role at 0 reads "0 assigned" (alarming on
  // purpose); resource rows keep the original "Only 1" / "N of these".
  const pillCopy = isStaffRole
    ? assignedStaff.length === 0
      ? '0 assigned'
      : `${assignedStaff.length} assigned`
    : pool.capacity === 1
    ? 'Only 1'
    : `${pool.capacity} of these`;
  // For staff-role rows with no assignments yet we tone the pill
  // soft-orange so the "you need to assign somebody" signal lands —
  // a 0-staff role silently blocks every booking that consumes it
  // until the admin assigns somebody, and that needs to be visible.
  const pillTone: 'neutral' | 'unsuitable' =
    isStaffRole && assignedStaff.length === 0 ? 'unsuitable' : 'neutral';

  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        borderTop: isFirst ? 'none' : `1px solid ${theme.color.border}`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 32,
          height: 32,
          borderRadius: theme.radius.input,
          background: theme.color.bg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: theme.color.inkMuted,
          flexShrink: 0,
        }}
      >
        {isStaffRole ? <UserCircle2 size={16} aria-hidden /> : <Box size={16} aria-hidden />}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {pool.display_name}
        </span>
        <span
          style={{
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {summaryLine}
          {!isStaffRole && consumers.length === 0 ? '' : null}
          {pool.notes ? ` · ${pool.notes}` : ''}
        </span>
      </div>
      <StatusPill tone={pillTone} size="sm">
        {pillCopy}
      </StatusPill>
      {/* Visible divider separates the informational pill on the left
          from the row-action buttons on the right. Without it the pill
          and the icon buttons all read as the same control cluster
          and it isn't obvious what's tappable. */}
      <span
        aria-hidden
        style={{
          width: 1,
          alignSelf: 'stretch',
          background: theme.color.border,
          marginInline: theme.space[2],
        }}
      />
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
        <IconAction
          ariaLabel={`Edit ${pool.display_name}`}
          onClick={onEdit}
          icon={<Settings2 size={16} aria-hidden />}
        />
        <IconAction
          ariaLabel={`Remove ${pool.display_name}`}
          onClick={onRemove}
          icon={<Trash2 size={16} aria-hidden />}
          tone="danger"
        />
      </div>
    </li>
  );
}

// Two names join with "and"; three or more get the Oxford-comma + "and"
// treatment so the row reads naturally at a glance: "Sarah, Tom and Mira"
// instead of "Sarah, Tom, Mira" (which reads like a list mid-sentence)
// or "Sarah, Tom, and Mira" (heavier punctuation). Single name renders
// alone.
function formatStaffList(staff: StaffRow[]): string {
  const names = staff.map((s) => s.display_name);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const head = names.slice(0, -1).join(', ');
  return `${head} and ${names[names.length - 1]}`;
}

function PoolEditorDialog({
  target,
  existing,
  activeStaff,
  initialStaffIds,
  onClose,
  onSaved,
  onError,
}: {
  target: EditPoolTarget;
  existing: ResourcePoolRow[];
  /** Active staff members the admin can assign to this role. */
  activeStaff: StaffRow[];
  /** Staff currently assigned to this pool (only meaningful on edit). */
  initialStaffIds: string[];
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const isNew = target.kind === 'new';
  const seed = isNew ? null : target.pool;
  const [poolKind, setPoolKind] = useState<ResourcePoolKind>(
    seed?.kind ?? 'resource',
  );
  const [displayName, setDisplayName] = useState(seed?.display_name ?? '');
  const [poolId, setPoolId] = useState(seed?.id ?? '');
  // Units: how many of this resource exist. For physical resources
  // it's a manual input; for staff_role it's the count of selected
  // staff (computed below). Per-unit capacity: how many patients
  // each unit handles at once — defaults to 1 and is rarely changed.
  const [unitsInput, setUnitsInput] = useState<string>(
    seed?.units != null ? String(seed.units) : '1',
  );
  const [perUnitInput, setPerUnitInput] = useState<string>(
    seed?.per_unit_capacity != null ? String(seed.per_unit_capacity) : '1',
  );
  const [notes, setNotes] = useState(seed?.notes ?? '');
  // Staff selection. Re-seeded whenever the row changes — same
  // pattern as the email-template editor: any external version bump
  // refreshes the form.
  const [selectedStaffIds, setSelectedStaffIds] = useState<string[]>(initialStaffIds);
  useEffect(() => {
    setSelectedStaffIds(initialStaffIds);
  }, [initialStaffIds]);
  const [busy, setBusy] = useState(false);

  const handleNameChange = (v: string) => {
    setDisplayName(v);
    if (isNew) setPoolId(poolIdFromDisplayName(v));
  };

  const isStaffRole = poolKind === 'staff_role';

  // Effective units: for staff_role it's the count of picked staff
  // (auto), for resource it's the parsed input. Effective capacity
  // mirrors the DB-side generated column.
  const effectiveUnits = isStaffRole
    ? selectedStaffIds.length
    : Math.max(parseInt(unitsInput, 10) || 0, 0);
  const effectivePerUnit = Math.max(parseInt(perUnitInput, 10) || 0, 0);
  const effectiveCapacity = effectiveUnits * effectivePerUnit;

  const save = async () => {
    setBusy(true);
    try {
      if (!displayName.trim()) throw new Error('Give it a name first.');
      if (!isValidPoolId(poolId)) {
        throw new Error('Short name must start with a letter and use only lowercase letters, digits, and hyphens.');
      }
      const units = effectiveUnits;
      if (units <= 0) {
        throw new Error(
          isStaffRole
            ? 'Pick at least one staff member for this role.'
            : 'How many do you have? Enter a positive whole number.',
        );
      }
      if (effectivePerUnit <= 0) {
        throw new Error('Each unit needs to handle at least 1 patient at a time.');
      }
      if (isNew && existing.some((e) => e.id === poolId)) {
        throw new Error(`Already have a "${poolId}". Pick a different short name.`);
      }
      await upsertResourcePool({
        id: poolId,
        display_name: displayName.trim(),
        units,
        per_unit_capacity: effectivePerUnit,
        kind: poolKind,
        notes: notes.trim() === '' ? null : notes.trim(),
      });
      // For staff_role pools, replace the assignment set in the same
      // save action. The RPC handles diffing internally.
      if (isStaffRole) {
        await setStaffPoolAssignments(poolId, selectedStaffIds);
      }
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const namePlaceholder = isStaffRole ? 'e.g. Impression Clinician' : 'e.g. Chairs';

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={isNew ? 'Add to your clinic' : `Edit ${seed?.display_name ?? 'this'}`}
      description={
        isNew
          ? 'Anything finite that limits how many bookings can run at once. Pick whether this is a space, piece of equipment, or a staff role.'
          : 'Changes apply to all future bookings. Existing bookings keep their slots.'
      }
      footer={<DialogFooter onCancel={onClose} onSave={save} busy={busy} />}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        {isNew ? (
          <KindPicker value={poolKind} onChange={setPoolKind} />
        ) : (
          <KindBadge kind={poolKind} />
        )}
        <Input
          label="Name"
          required
          autoFocus
          value={displayName}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder={namePlaceholder}
          helper="What you'll call this in the rules below."
        />
        <Input
          label="Short name"
          required
          value={poolId}
          onChange={(e) => setPoolId(e.target.value.toLowerCase())}
          placeholder={isStaffRole ? 'impression-takers' : 'chairs'}
          disabled={!isNew}
          helper={
            isNew
              ? 'Used internally as a stable id. Lowercase letters, digits, hyphens only.'
              : 'Set when this was created. Stays stable to keep mappings intact.'
          }
        />
        {isStaffRole ? (
          <StaffPicker
            allStaff={activeStaff}
            selectedIds={selectedStaffIds}
            onChange={setSelectedStaffIds}
          />
        ) : (
          <Input
            label="How many do you have?"
            required
            type="number"
            value={unitsInput}
            onChange={(e) => setUnitsInput(e.target.value)}
            placeholder="1"
            helper="The count of these in your clinic."
          />
        )}
        <Input
          label={isStaffRole ? 'Each person handles how many at a time?' : 'Each one handles how many at a time?'}
          required
          type="number"
          value={perUnitInput}
          onChange={(e) => setPerUnitInput(e.target.value)}
          placeholder="1"
          helper={
            isStaffRole
              ? 'Usually 1. Bump up for roles where one person can juggle several patients (e.g. Reception greeting and seating multiple at once).'
              : 'Usually 1. Bump up for things that fit multiple patients (e.g. a room with two chairs).'
          }
        />
        <CapacitySummary
          isStaffRole={isStaffRole}
          units={effectiveUnits}
          perUnit={effectivePerUnit}
          capacity={effectiveCapacity}
        />
        <Input
          label="Note (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything internal staff should know."
        />
      </div>
    </BottomSheet>
  );
}

// Honest, computed capacity readout sitting between the two inputs
// and the notes field. Mirrors the DB-side generated column so the
// admin sees the same number the conflict checker will read.
function CapacitySummary({
  isStaffRole,
  units,
  perUnit,
  capacity,
}: {
  isStaffRole: boolean;
  units: number;
  perUnit: number;
  capacity: number;
}) {
  const unitWord = isStaffRole
    ? units === 1
      ? 'person'
      : 'people'
    : units === 1
      ? 'unit'
      : 'units';
  const eachWord = isStaffRole
    ? perUnit === 1
      ? '1 patient each'
      : `${perUnit} patients each`
    : perUnit === 1
      ? '1 patient each'
      : `${perUnit} patients each`;
  return (
    <div
      style={{
        background: theme.color.accentBg,
        borderRadius: theme.radius.input,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <span
        style={{
          fontSize: theme.type.size.xs,
          color: theme.color.accent,
          fontWeight: theme.type.weight.semibold,
          letterSpacing: theme.type.tracking.wide,
          textTransform: 'uppercase',
        }}
      >
        Capacity
      </span>
      <span
        style={{
          fontSize: theme.type.size.base,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
        }}
      >
        {units} {unitWord} × {eachWord} = {capacity}{' '}
        {capacity === 1 ? 'patient at a time' : 'patients at a time'}
      </span>
    </div>
  );
}

// Checkbox list of active staff members. Replaces the manual capacity
// input for staff_role pools — capacity is the count of ticked rows.
// Empty-active-staff state hands the admin a pointer to the Staff tab
// rather than a useless empty box.
function StaffPicker({
  allStaff,
  selectedIds,
  onChange,
}: {
  allStaff: StaffRow[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const toggle = (id: string) => {
    if (selectedSet.has(id)) onChange(selectedIds.filter((x) => x !== id));
    else onChange([...selectedIds, id]);
  };
  const empty = allStaff.length === 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.medium,
            color: theme.color.ink,
          }}
        >
          Who is in this role?
          <span style={{ color: theme.color.alert, marginLeft: 4 }}>*</span>
        </span>
        <span
          style={{
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {selectedIds.length} of {allStaff.length} selected
        </span>
      </div>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
          lineHeight: theme.type.leading.snug,
        }}
      >
        Capacity is the count of active staff in this role. Toggling someone off here drops the booking checker's cap accordingly. Deactivating them on the Staff tab does the same automatically.
      </p>
      {empty ? (
        <div
          style={{
            padding: `${theme.space[3]}px ${theme.space[4]}px`,
            border: `1px dashed ${theme.color.border}`,
            borderRadius: theme.radius.input,
            background: theme.color.bg,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          No active staff yet. Add staff on the Staff tab and they'll appear here.
        </div>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.input,
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          {allStaff.map((s, i) => {
            const checked = selectedSet.has(s.staff_member_id);
            return (
              <li
                key={s.staff_member_id}
                style={{
                  borderTop: i === 0 ? 'none' : `1px solid ${theme.color.border}`,
                }}
              >
                <button
                  type="button"
                  onClick={() => toggle(s.staff_member_id)}
                  aria-pressed={checked}
                  style={{
                    appearance: 'none',
                    width: '100%',
                    background: checked ? theme.color.accentBg : 'transparent',
                    border: 'none',
                    padding: `${theme.space[3]}px ${theme.space[4]}px`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.space[3],
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'inherit',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 4,
                      border: `1.5px solid ${checked ? theme.color.accent : theme.color.border}`,
                      background: checked ? theme.color.accent : theme.color.surface,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
                    }}
                  >
                    {checked ? <Check size={12} color={theme.color.surface} aria-hidden /> : null}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: theme.type.size.sm,
                        fontWeight: theme.type.weight.semibold,
                        color: theme.color.ink,
                      }}
                    >
                      {s.display_name}
                    </span>
                    {s.login_email ? (
                      <span
                        style={{
                          display: 'block',
                          marginTop: 2,
                          fontSize: theme.type.size.xs,
                          color: theme.color.inkMuted,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {s.login_email}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Two-button picker for the pool kind, used at create time. Once a
// pool is created its kind is locked in (changing it would be a
// data-model edit dressed up as a checkbox), so the editor renders
// a read-only badge instead.
function KindPicker({
  value,
  onChange,
}: {
  value: ResourcePoolKind;
  onChange: (k: ResourcePoolKind) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      <span
        style={{
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.medium,
          color: theme.color.ink,
        }}
      >
        What kind of thing?<span style={{ color: theme.color.alert, marginLeft: 4 }}>*</span>
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[2] }}>
        <KindOption
          active={value === 'resource'}
          onClick={() => onChange('resource')}
          title="Space or equipment"
          sub="Chairs, rooms, lab bench."
        />
        <KindOption
          active={value === 'staff_role'}
          onClick={() => onChange('staff_role')}
          title="Staff role"
          sub="Impression taker, denture tech."
        />
      </div>
    </div>
  );
}

function KindOption({
  active,
  onClick,
  title,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        appearance: 'none',
        textAlign: 'left',
        background: active ? theme.color.accentBg : theme.color.surface,
        border: `1px solid ${active ? theme.color.accent : theme.color.border}`,
        borderRadius: theme.radius.input,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      <div
        style={{
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          color: active ? theme.color.accent : theme.color.ink,
        }}
      >
        {title}
      </div>
      <div
        style={{
          marginTop: 2,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
          lineHeight: theme.type.leading.snug,
        }}
      >
        {sub}
      </div>
    </button>
  );
}

function KindBadge({ kind }: { kind: ResourcePoolKind }) {
  const label = kind === 'staff_role' ? 'Staff role' : 'Space or equipment';
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[2],
        padding: `${theme.space[1]}px ${theme.space[3]}px`,
        background: theme.color.bg,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.pill,
        fontSize: theme.type.size.xs,
        color: theme.color.inkMuted,
        fontWeight: theme.type.weight.medium,
        alignSelf: 'flex-start',
      }}
    >
      {label}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// "How this works" — collapsed by default
// ─────────────────────────────────────────────────────────────────────────────

function HowThisWorks() {
  const [open, setOpen] = useState(false);
  return (
    <Card padding="none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          width: '100%',
          textAlign: 'left',
          padding: `${theme.space[4]}px ${theme.space[5]}px`,
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[2],
          fontFamily: 'inherit',
          color: theme.color.ink,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {open ? (
          <ChevronDown size={14} aria-hidden style={{ color: theme.color.inkSubtle }} />
        ) : (
          <ChevronRight size={14} aria-hidden style={{ color: theme.color.inkSubtle }} />
        )}
        <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold }}>
          How this works
        </span>
      </button>
      {open ? (
        <div
          style={{
            padding: `${theme.space[2]}px ${theme.space[5]}px ${theme.space[5]}px ${theme.space[8]}px`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: 1.6,
            borderTop: `1px solid ${theme.color.border}`,
          }}
        >
          <p style={{ margin: 0 }}>
            Imagine you have <strong style={{ color: theme.color.ink }}>2 chairs</strong>{' '}
            and <strong style={{ color: theme.color.ink }}>1 lab bench</strong>. A click-in
            veneers booking needs a chair AND the lab bench. A denture repair only needs a
            chair. So the rules let you have 2 denture repairs running side-by-side, but
            only 1 click-in veneers, because the lab bench is shared. While that
            click-in veneers is running, you can still fit a denture repair in the other
            chair, but a same-day appliance is blocked because it also needs the bench.
            Lounge does this maths automatically every time staff try to book a slot.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared layout primitives
// ─────────────────────────────────────────────────────────────────────────────

function SectionHeader({
  icon,
  title,
  subtitle,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  action?: React.ReactNode;
}) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        borderBottom: `1px solid ${theme.color.border}`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 28,
          height: 28,
          borderRadius: theme.radius.input,
          background: theme.color.bg,
          color: theme.color.inkMuted,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {title}
        </h3>
        <p
          style={{
            margin: `2px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            lineHeight: 1.5,
          }}
        >
          {subtitle}
        </p>
      </div>
      {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
    </header>
  );
}

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
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {icon}
    </button>
  );
}

function DialogFooter({
  onCancel,
  onSave,
  busy,
}: {
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: theme.space[2],
        borderTop: `1px solid ${theme.color.border}`,
        marginInline: -theme.space[5],
        marginBottom: -theme.space[5],
        paddingInline: theme.space[5],
        paddingBlock: theme.space[4],
        background: theme.color.bg,
      }}
    >
      <Button variant="tertiary" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button variant="primary" onClick={onSave} loading={busy}>
        {busy ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}
