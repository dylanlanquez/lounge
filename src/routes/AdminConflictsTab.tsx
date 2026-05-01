import { useEffect, useMemo, useState } from 'react';
import { Box, Layers, Plus, Settings2, Sparkles, Trash2, Zap } from 'lucide-react';
import {
  Button,
  Card,
  Dialog,
  Input,
  Skeleton,
  Toast,
} from '../components/index.ts';
import { theme } from '../theme/index.ts';
import {
  type BookingServiceType,
  type BookingTypeConfigRow,
  type ResourcePoolRow,
  type ServicePoolRow,
  BOOKING_SERVICE_TYPES,
  deleteResourcePool,
  isValidPoolId,
  poolIdFromDisplayName,
  setServicePools,
  upsertBookingTypeConfig,
  upsertResourcePool,
  useBookingTypeConfigs,
  useResourcePools,
  useServicePools,
} from '../lib/queries/bookingTypes.ts';

// Conflicts & capacity tab — three sections, each a self-contained
// concern but reading from the same booking-types backbone:
//
//   1. Resource pools — finite resources with capacity (chairs, lab
//      bench, consult room). Add / edit / remove.
//
//   2. Per-service consumption — for each service type, which pools
//      it claims while a booking runs, plus an optional
//      max_concurrent cap.
//
//   3. Compatibility preview — derived from sections 1 + 2. Shows,
//      per service, which other services can or can't run alongside
//      and how many of itself can run at once. Read-only — the
//      effects of editing the rules above surface here so the admin
//      can see what they've configured at a glance.
//
// Visual language matches AdminBookingTypesTab — hairline-separated
// rows in a single container, service-family colour dots, IconAction
// buttons for inline edit / delete.

const SERVICE_DOT_COLOUR: Record<BookingServiceType, string> = {
  denture_repair: '#4F6F89',
  click_in_veneers: '#2D3539',
  same_day_appliance: theme.color.accent,
  impression_appointment: '#B36815',
  other: '#6B7378',
};

export function AdminConflictsTab() {
  const pools = useResourcePools();
  const servicePools = useServicePools();
  const configs = useBookingTypeConfigs();
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string } | null>(null);

  if (pools.error || servicePools.error || configs.error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load conflicts config: {pools.error || servicePools.error || configs.error}
        </p>
      </Card>
    );
  }
  if (pools.loading || servicePools.loading || configs.loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        <Skeleton height={120} />
        <Skeleton height={240} />
        <Skeleton height={200} />
      </div>
    );
  }

  const reloadAll = () => {
    pools.reload();
    servicePools.reload();
    configs.reload();
  };

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
          <Layers size={20} aria-hidden style={{ color: theme.color.inkMuted }} /> Conflicts &amp; capacity
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
          Resources determine what can run at the same time. A booking consumes 1 unit
          of every pool its service is mapped to — when a pool is at capacity, the next
          booking is blocked. The compatibility preview below shows the effect.
        </p>
      </header>

      <ResourcePoolsSection
        pools={pools.data}
        servicePools={servicePools.data}
        onChanged={() => {
          pools.reload();
          servicePools.reload();
        }}
        onToast={setToast}
      />

      <ServiceConsumptionSection
        pools={pools.data}
        servicePools={servicePools.data}
        configs={configs.data}
        onChanged={reloadAll}
        onToast={setToast}
      />

      <CompatibilityPreview
        pools={pools.data}
        servicePools={servicePools.data}
        configs={configs.data}
      />

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

// ─────────────────────────────────────────────────────────────────────────────
// 1. Resource pools
// ─────────────────────────────────────────────────────────────────────────────

type EditPoolTarget =
  | { kind: 'new' }
  | { kind: 'edit'; pool: ResourcePoolRow };

function ResourcePoolsSection({
  pools,
  servicePools,
  onChanged,
  onToast,
}: {
  pools: ResourcePoolRow[];
  servicePools: ServicePoolRow[];
  onChanged: () => void;
  onToast: (t: { tone: 'success' | 'error'; title: string }) => void;
}) {
  const [editing, setEditing] = useState<EditPoolTarget | null>(null);

  const usageByPool = useMemo(() => {
    const map = new Map<string, BookingServiceType[]>();
    for (const sp of servicePools) {
      const list = map.get(sp.pool_id) ?? [];
      list.push(sp.service_type);
      map.set(sp.pool_id, list);
    }
    return map;
  }, [servicePools]);

  return (
    <Card padding="none">
      <SectionHeader
        icon={<Box size={16} aria-hidden />}
        title="Resource pools"
        subtitle="Each pool has a capacity. A booking that consumes a pool occupies 1 unit while it runs."
        action={
          <Button variant="tertiary" size="sm" onClick={() => setEditing({ kind: 'new' })}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <Plus size={14} aria-hidden /> Add pool
            </span>
          </Button>
        }
      />
      {pools.length === 0 ? (
        <EmptyStrip
          icon={<Sparkles size={16} aria-hidden />}
          title="No resource pools yet"
          body="Add chairs, a lab bench, or whatever else gates concurrency."
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {pools.map((p, i) => (
            <PoolRow
              key={p.id}
              isFirst={i === 0}
              pool={p}
              consumers={usageByPool.get(p.id) ?? []}
              onEdit={() => setEditing({ kind: 'edit', pool: p })}
              onRemove={async () => {
                if ((usageByPool.get(p.id) ?? []).length > 0) {
                  onToast({
                    tone: 'error',
                    title: 'Pool is in use — remove it from every service first.',
                  });
                  return;
                }
                try {
                  await deleteResourcePool(p.id);
                  onToast({ tone: 'success', title: 'Pool removed' });
                  onChanged();
                } catch (e) {
                  onToast({
                    tone: 'error',
                    title: e instanceof Error ? e.message : 'Could not remove',
                  });
                }
              }}
            />
          ))}
        </ul>
      )}

      {editing ? (
        <PoolEditorDialog
          target={editing}
          existing={pools}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onToast({ tone: 'success', title: 'Saved' });
            onChanged();
          }}
          onError={(msg) => onToast({ tone: 'error', title: msg })}
        />
      ) : null}
    </Card>
  );
}

function PoolRow({
  isFirst,
  pool,
  consumers,
  onEdit,
  onRemove,
}: {
  isFirst: boolean;
  pool: ResourcePoolRow;
  consumers: BookingServiceType[];
  onEdit: () => void;
  onRemove: () => void;
}) {
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
        <Box size={16} aria-hidden />
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
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          Capacity {pool.capacity}
          {consumers.length > 0
            ? ` · used by ${consumers.length} service${consumers.length === 1 ? '' : 's'}`
            : ' · not in use'}
          {pool.notes ? ` · ${pool.notes}` : ''}
        </span>
      </div>
      <CapacityChip capacity={pool.capacity} />
      <IconAction
        ariaLabel={`Configure ${pool.display_name}`}
        onClick={onEdit}
        icon={<Settings2 size={16} aria-hidden />}
      />
      <IconAction
        ariaLabel={`Remove ${pool.display_name}`}
        onClick={onRemove}
        icon={<Trash2 size={16} aria-hidden />}
        tone="danger"
      />
    </li>
  );
}

function CapacityChip({ capacity }: { capacity: number }) {
  return (
    <span
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: `2px ${theme.space[2]}px`,
        borderRadius: theme.radius.pill,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.bg,
        color: theme.color.ink,
        fontSize: 11,
        fontWeight: theme.type.weight.semibold,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      ×{capacity}
    </span>
  );
}

function PoolEditorDialog({
  target,
  existing,
  onClose,
  onSaved,
  onError,
}: {
  target: EditPoolTarget;
  existing: ResourcePoolRow[];
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const isNew = target.kind === 'new';
  const seed = isNew ? null : target.pool;
  const [displayName, setDisplayName] = useState(seed?.display_name ?? '');
  const [poolId, setPoolId] = useState(seed?.id ?? '');
  const [capacity, setCapacity] = useState<string>(
    seed?.capacity != null ? String(seed.capacity) : '1',
  );
  const [notes, setNotes] = useState(seed?.notes ?? '');
  const [busy, setBusy] = useState(false);

  // Auto-derive id from display name on new pools so the admin
  // doesn't have to think about slugs. Editable if they want a
  // specific value.
  const handleNameChange = (v: string) => {
    setDisplayName(v);
    if (isNew) setPoolId(poolIdFromDisplayName(v));
  };

  const save = async () => {
    setBusy(true);
    try {
      if (!displayName.trim()) throw new Error('Pool needs a display name.');
      if (!isValidPoolId(poolId)) {
        throw new Error('Pool id must start with a letter and use only lowercase letters, digits, and hyphens.');
      }
      const cap = parseInt(capacity, 10);
      if (!Number.isFinite(cap) || cap <= 0) {
        throw new Error('Capacity must be a positive whole number.');
      }
      // New-pool ID collision check (the DB will reject it anyway,
      // but a friendly message beats the constraint error).
      if (isNew && existing.some((e) => e.id === poolId)) {
        throw new Error(`A pool with id "${poolId}" already exists.`);
      }
      await upsertResourcePool({
        id: poolId,
        display_name: displayName.trim(),
        capacity: cap,
        notes: notes.trim() === '' ? null : notes.trim(),
      });
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={520}
      title={isNew ? 'Add a resource pool' : `Edit ${seed?.display_name ?? 'pool'}`}
      description={
        isNew
          ? 'A pool is something with finite capacity that bookings consume — a chair, a lab bench, a consult room.'
          : 'Capacity changes apply to all future bookings. Existing bookings keep their slots.'
      }
      footer={
        <DialogFooter onCancel={onClose} onSave={save} busy={busy} />
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        <Input
          label="Display name"
          required
          autoFocus
          value={displayName}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder="Chairs"
        />
        <Input
          label="Pool id"
          required
          value={poolId}
          onChange={(e) => setPoolId(e.target.value.toLowerCase())}
          placeholder="chairs"
          disabled={!isNew}
          helper={
            isNew
              ? 'Lowercase, hyphenated. Used as a stable id across services.'
              : 'Pool id is set at creation and stays stable to keep service mappings intact.'
          }
        />
        <Input
          label="Capacity"
          required
          type="number"
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          placeholder="1"
          helper="How many simultaneous bookings this pool can absorb."
        />
        <Input
          label="Notes (admin only)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional. What this pool represents for staff."
        />
      </div>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Per-service consumption
// ─────────────────────────────────────────────────────────────────────────────

function ServiceConsumptionSection({
  pools,
  servicePools,
  configs,
  onChanged,
  onToast,
}: {
  pools: ResourcePoolRow[];
  servicePools: ServicePoolRow[];
  configs: BookingTypeConfigRow[];
  onChanged: () => void;
  onToast: (t: { tone: 'success' | 'error'; title: string }) => void;
}) {
  return (
    <Card padding="none">
      <SectionHeader
        icon={<Zap size={16} aria-hidden />}
        title="Per-service consumption"
        subtitle="Which pools each service claims, plus an optional cap on simultaneous bookings of the same service."
      />
      {pools.length === 0 ? (
        <EmptyStrip
          icon={<Sparkles size={16} aria-hidden />}
          title="Add a resource pool first"
          body="Service consumption needs at least one pool to point at."
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {BOOKING_SERVICE_TYPES.map((s, i) => {
            const claimed = new Set(
              servicePools.filter((sp) => sp.service_type === s.value).map((sp) => sp.pool_id),
            );
            const parentRow = configs.find(
              (c) =>
                c.service_type === s.value &&
                c.repair_variant == null &&
                c.product_key == null &&
                c.arch == null,
            );
            return (
              <ServiceConsumptionRow
                key={s.value}
                isFirst={i === 0}
                serviceType={s.value}
                serviceLabel={s.label}
                pools={pools}
                claimed={claimed}
                maxConcurrent={parentRow?.max_concurrent ?? null}
                onTogglePool={async (poolId) => {
                  const next = new Set(claimed);
                  if (next.has(poolId)) next.delete(poolId);
                  else next.add(poolId);
                  try {
                    await setServicePools(s.value, Array.from(next));
                    onChanged();
                  } catch (e) {
                    onToast({
                      tone: 'error',
                      title: e instanceof Error ? e.message : 'Could not update',
                    });
                  }
                }}
                onMaxConcurrentChange={async (next) => {
                  try {
                    await upsertBookingTypeConfig({
                      service_type: s.value,
                      max_concurrent: next,
                    });
                    onChanged();
                  } catch (e) {
                    onToast({
                      tone: 'error',
                      title: e instanceof Error ? e.message : 'Could not update',
                    });
                  }
                }}
              />
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function ServiceConsumptionRow({
  isFirst,
  serviceType,
  serviceLabel,
  pools,
  claimed,
  maxConcurrent,
  onTogglePool,
  onMaxConcurrentChange,
}: {
  isFirst: boolean;
  serviceType: BookingServiceType;
  serviceLabel: string;
  pools: ResourcePoolRow[];
  claimed: Set<string>;
  maxConcurrent: number | null;
  onTogglePool: (poolId: string) => void;
  onMaxConcurrentChange: (next: number | null) => void;
}) {
  // Local string state for the input so the user can clear it and
  // type freely; we commit on blur.
  const [maxStr, setMaxStr] = useState(
    maxConcurrent != null ? String(maxConcurrent) : '',
  );
  useEffect(() => {
    setMaxStr(maxConcurrent != null ? String(maxConcurrent) : '');
  }, [maxConcurrent]);

  const commit = () => {
    const trimmed = maxStr.trim();
    if (trimmed === '') {
      if (maxConcurrent != null) onMaxConcurrentChange(null);
      return;
    }
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n <= 0) {
      // Reset to last good value silently — user can re-edit.
      setMaxStr(maxConcurrent != null ? String(maxConcurrent) : '');
      return;
    }
    if (n !== maxConcurrent) onMaxConcurrentChange(n);
  };

  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        borderTop: isFirst ? 'none' : `1px solid ${theme.color.border}`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: SERVICE_DOT_COLOUR[serviceType],
          flexShrink: 0,
          marginTop: 6,
        }}
      />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
        <span
          style={{
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {serviceLabel}
        </span>
        <div>
          <span
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
              color: theme.color.inkMuted,
              fontWeight: theme.type.weight.semibold,
              display: 'block',
              marginBottom: theme.space[1],
            }}
          >
            Consumes
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: theme.space[1] }}>
            {pools.map((p) => {
              const on = claimed.has(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onTogglePool(p.id)}
                  style={{
                    appearance: 'none',
                    border: `1px solid ${on ? theme.color.ink : theme.color.border}`,
                    background: on ? theme.color.bg : 'transparent',
                    color: on ? theme.color.ink : theme.color.inkMuted,
                    padding: `${theme.space[1]}px ${theme.space[2]}px`,
                    borderRadius: theme.radius.pill,
                    fontFamily: 'inherit',
                    fontSize: theme.type.size.xs,
                    fontWeight: on ? theme.type.weight.semibold : theme.type.weight.medium,
                    cursor: 'pointer',
                    WebkitTapHighlightColor: 'transparent',
                  }}
                >
                  {p.display_name}
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      color: theme.color.inkSubtle,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    ×{p.capacity}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1], flexShrink: 0, width: 110 }}>
        <span
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: theme.type.tracking.wide,
            color: theme.color.inkMuted,
            fontWeight: theme.type.weight.semibold,
          }}
        >
          Max concurrent
        </span>
        <input
          type="number"
          min={1}
          value={maxStr}
          onChange={(e) => setMaxStr(e.target.value)}
          onBlur={commit}
          placeholder="—"
          aria-label={`${serviceLabel} max concurrent`}
          style={{
            appearance: 'none',
            border: `1px solid ${theme.color.border}`,
            background: theme.color.bg,
            borderRadius: theme.radius.input,
            padding: `6px ${theme.space[2]}px`,
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            fontFamily: 'inherit',
            fontVariantNumeric: 'tabular-nums',
            textAlign: 'center',
            width: '100%',
            outline: 'none',
            fontWeight: theme.type.weight.semibold,
          }}
        />
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Compatibility preview
// ─────────────────────────────────────────────────────────────────────────────

function CompatibilityPreview({
  pools,
  servicePools,
  configs,
}: {
  pools: ResourcePoolRow[];
  servicePools: ServicePoolRow[];
  configs: BookingTypeConfigRow[];
}) {
  const consumesByService = useMemo(() => {
    const map = new Map<BookingServiceType, Set<string>>();
    for (const sp of servicePools) {
      const set = map.get(sp.service_type) ?? new Set<string>();
      set.add(sp.pool_id);
      map.set(sp.service_type, set);
    }
    return map;
  }, [servicePools]);

  const poolCapacity = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of pools) map.set(p.id, p.capacity);
    return map;
  }, [pools]);

  // Per-service self-cap: how many of THIS service can run alongside
  // each other given pool caps + max_concurrent. Take the min of:
  //   • max_concurrent (or ∞)
  //   • for every consumed pool, capacity / 1 (one claim per booking)
  // i.e. the smallest capacity bottleneck across consumed pools.
  const selfMax = (service: BookingServiceType): number => {
    const consumed = consumesByService.get(service) ?? new Set<string>();
    const parent = configs.find(
      (c) =>
        c.service_type === service &&
        c.repair_variant == null &&
        c.product_key == null &&
        c.arch == null,
    );
    let cap = parent?.max_concurrent ?? Number.POSITIVE_INFINITY;
    for (const id of consumed) {
      cap = Math.min(cap, poolCapacity.get(id) ?? 0);
    }
    return cap === Number.POSITIVE_INFINITY ? 0 : cap;
  };

  // For each pair (a, b), can they overlap at the same minute?
  // Yes iff for every shared pool the capacity is at least 2 (one
  // for each). max_concurrent doesn't apply pairwise across
  // services, only same-service.
  const canOverlap = (a: BookingServiceType, b: BookingServiceType): boolean => {
    if (a === b) return selfMax(a) >= 2;
    const aPools = consumesByService.get(a) ?? new Set<string>();
    const bPools = consumesByService.get(b) ?? new Set<string>();
    for (const id of aPools) {
      if (bPools.has(id) && (poolCapacity.get(id) ?? 0) < 2) return false;
    }
    return true;
  };

  return (
    <Card padding="none">
      <SectionHeader
        icon={<Sparkles size={16} aria-hidden />}
        title="Compatibility preview"
        subtitle="Read-only. Reflects the resource pools and consumption above."
      />
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {BOOKING_SERVICE_TYPES.map((s, i) => {
          const compatible: BookingServiceType[] = [];
          const incompatible: BookingServiceType[] = [];
          for (const other of BOOKING_SERVICE_TYPES) {
            if (other.value === s.value) continue;
            (canOverlap(s.value, other.value) ? compatible : incompatible).push(other.value);
          }
          const selfCap = selfMax(s.value);
          return (
            <li
              key={s.value}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: theme.space[3],
                padding: `${theme.space[4]}px ${theme.space[5]}px`,
                borderTop: i === 0 ? 'none' : `1px solid ${theme.color.border}`,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: SERVICE_DOT_COLOUR[s.value],
                  flexShrink: 0,
                  marginTop: 6,
                }}
              />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                <span
                  style={{
                    fontSize: theme.type.size.md,
                    fontWeight: theme.type.weight.semibold,
                    color: theme.color.ink,
                    letterSpacing: theme.type.tracking.tight,
                  }}
                >
                  {s.label}
                </span>
                <span
                  style={{
                    fontSize: theme.type.size.xs,
                    color: theme.color.inkMuted,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  Up to <strong style={{ color: theme.color.ink }}>{selfCap}</strong>{' '}
                  concurrent {selfCap === 1 ? 'booking' : 'bookings'} of this service
                </span>
                <CompatibilityChips
                  label="Can run alongside"
                  services={compatible}
                  tone="positive"
                />
                {incompatible.length > 0 ? (
                  <CompatibilityChips
                    label="Cannot run alongside"
                    services={incompatible}
                    tone="negative"
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function CompatibilityChips({
  label,
  services,
  tone,
}: {
  label: string;
  services: BookingServiceType[];
  tone: 'positive' | 'negative';
}) {
  if (services.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: theme.space[2] }}>
        <span
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: theme.type.tracking.wide,
            color: theme.color.inkMuted,
            fontWeight: theme.type.weight.semibold,
            minWidth: 152,
          }}
        >
          {label}
        </span>
        <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle, fontStyle: 'italic' }}>
          —
        </span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: theme.space[2] }}>
      <span
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
          color: theme.color.inkMuted,
          fontWeight: theme.type.weight.semibold,
          minWidth: 152,
        }}
      >
        {label}
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {services.map((sv) => {
          const label = BOOKING_SERVICE_TYPES.find((s) => s.value === sv)?.label ?? sv;
          return (
            <span
              key={sv}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: `2px ${theme.space[2]}px`,
                borderRadius: theme.radius.pill,
                border: `1px solid ${tone === 'positive' ? theme.color.border : theme.color.border}`,
                background: tone === 'positive' ? theme.color.accentBg : theme.color.bg,
                color: tone === 'positive' ? theme.color.accent : theme.color.inkMuted,
                fontSize: 11,
                fontWeight: theme.type.weight.medium,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: SERVICE_DOT_COLOUR[sv],
                  opacity: 0.8,
                }}
              />
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared layout primitives.
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

function EmptyStrip({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[5]}px ${theme.space[5]}px`,
        background: theme.color.bg,
      }}
    >
      <span
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: theme.color.surface,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: theme.color.inkMuted,
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium, color: theme.color.ink }}>
          {title}
        </p>
        <p style={{ margin: `2px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
          {body}
        </p>
      </div>
    </div>
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
