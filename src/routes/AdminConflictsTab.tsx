import { useMemo, useState } from 'react';
import { Box, ChevronDown, ChevronRight, Layers, Plus, Settings2, Sparkles, Trash2, Zap } from 'lucide-react';
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Skeleton,
  StatusPill,
  Toast,
  Tooltip,
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
      <PageHeader />

      <OutcomePanel
        pools={pools.data}
        servicePools={servicePools.data}
        configs={configs.data}
      />

      <ResourcesSection
        pools={pools.data}
        servicePools={servicePools.data}
        onChanged={() => {
          pools.reload();
          servicePools.reload();
        }}
        onToast={setToast}
      />

      <ServiceRulesSection
        pools={pools.data}
        servicePools={servicePools.data}
        configs={configs.data}
        onChanged={reloadAll}
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
        <Layers size={20} aria-hidden style={{ color: theme.color.inkMuted }} /> Conflicts &amp; capacity
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
        Tell Lounge what's in your clinic and what each booking type needs.
        Lounge will then prevent double-bookings automatically. Staff can't book
        a click-in veneers if the lab bench is already in use.
      </p>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcome panel — "What can happen at once"
// ─────────────────────────────────────────────────────────────────────────────

function OutcomePanel({
  pools,
  servicePools,
  configs,
}: {
  pools: ResourcePoolRow[];
  servicePools: ServicePoolRow[];
  configs: BookingTypeConfigRow[];
}) {
  // Pre-compute lookup maps so the per-service rendering is just
  // table reads — keeps the JSX legible.
  const consumesByService = useMemo(() => {
    const map = new Map<BookingServiceType, Set<string>>();
    for (const sp of servicePools) {
      const set = map.get(sp.service_type) ?? new Set<string>();
      set.add(sp.pool_id);
      map.set(sp.service_type, set);
    }
    return map;
  }, [servicePools]);

  const poolById = useMemo(() => {
    const m = new Map<string, ResourcePoolRow>();
    for (const p of pools) m.set(p.id, p);
    return m;
  }, [pools]);

  const parentByService = useMemo(() => {
    const m = new Map<BookingServiceType, BookingTypeConfigRow>();
    for (const c of configs) {
      if (c.repair_variant == null && c.product_key == null && c.arch == null) {
        m.set(c.service_type, c);
      }
    }
    return m;
  }, [configs]);

  // selfMax — how many of THIS service can run alongside each
  // other given pool capacities + max_concurrent. Smallest
  // bottleneck across consumed pools, capped by max_concurrent if
  // set on the parent.
  const selfMax = (service: BookingServiceType): number => {
    const consumed = consumesByService.get(service) ?? new Set<string>();
    const parent = parentByService.get(service);
    let cap = parent?.max_concurrent ?? Number.POSITIVE_INFINITY;
    for (const id of consumed) {
      cap = Math.min(cap, poolById.get(id)?.capacity ?? 0);
    }
    return cap === Number.POSITIVE_INFINITY ? 0 : cap;
  };

  // Pairing predicate. Same-service handled by selfMax; cross-
  // service blocked when they share a pool whose capacity is < 2.
  const pairingBlockedBy = (
    a: BookingServiceType,
    b: BookingServiceType,
  ): { pool: ResourcePoolRow } | null => {
    if (a === b) return null;
    const aPools = consumesByService.get(a) ?? new Set<string>();
    const bPools = consumesByService.get(b) ?? new Set<string>();
    for (const id of aPools) {
      if (!bPools.has(id)) continue;
      const pool = poolById.get(id);
      if (!pool) continue;
      if (pool.capacity < 2) return { pool };
    }
    return null;
  };

  return (
    <Card padding="none">
      <SectionHeader
        icon={<Sparkles size={16} aria-hidden />}
        title="What can happen at once"
        subtitle="A live summary of the rules below. Updates as you change things."
      />
      {pools.length === 0 ? (
        <EmptyState
          icon={<Sparkles size={20} />}
          title="Set up your clinic first"
          description="Add chairs, rooms, and any other equipment that limits bookings below. Lounge will then show the rules in plain English here."
          style={{ padding: `${theme.space[8]}px ${theme.space[5]}px` }}
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {BOOKING_SERVICE_TYPES.map((s, i) => {
            const compatible: { service: BookingServiceType; label: string }[] = [];
            const blocked: {
              service: BookingServiceType;
              label: string;
              reason: string;
            }[] = [];
            for (const other of BOOKING_SERVICE_TYPES) {
              if (other.value === s.value) continue;
              const blockedBy = pairingBlockedBy(s.value, other.value);
              if (blockedBy) {
                blocked.push({
                  service: other.value,
                  label: other.label,
                  reason: `share the ${blockedBy.pool.display_name.toLowerCase()}`,
                });
              } else {
                compatible.push({ service: other.value, label: other.label });
              }
            }
            const cap = selfMax(s.value);
            return (
              <OutcomeRow
                key={s.value}
                isFirst={i === 0}
                service={s.value}
                serviceLabel={s.label}
                selfMax={cap}
                compatible={compatible}
                blocked={blocked}
              />
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function OutcomeRow({
  isFirst,
  service,
  serviceLabel,
  selfMax,
  compatible,
  blocked,
}: {
  isFirst: boolean;
  service: BookingServiceType;
  serviceLabel: string;
  selfMax: number;
  compatible: { service: BookingServiceType; label: string }[];
  blocked: { service: BookingServiceType; label: string; reason: string }[];
}) {
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
          background: SERVICE_DOT_COLOUR[service],
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
          {serviceLabel}
        </span>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            lineHeight: 1.55,
          }}
        >
          {selfMax === 0 ? (
            <span style={{ color: theme.color.inkMuted }}>
              Can't be booked yet. This service has no resources mapped.
            </span>
          ) : selfMax === 1 ? (
            <>
              Up to <strong>1</strong> {serviceLabel.toLowerCase()} booking at a time.
            </>
          ) : (
            <>
              Up to <strong>{selfMax}</strong> {serviceLabel.toLowerCase()} bookings at the same time.
            </>
          )}
        </p>
        {compatible.length > 0 ? (
          <PairLine label="Can run alongside" tone="positive" items={compatible} />
        ) : null}
        {blocked.length > 0 ? (
          <PairLine
            label="Cannot run alongside"
            tone="negative"
            items={blocked.map((b) => ({
              service: b.service,
              label: b.label,
              hint: b.reason,
            }))}
          />
        ) : null}
      </div>
    </li>
  );
}

function PairLine({
  label,
  tone,
  items,
}: {
  label: string;
  tone: 'positive' | 'negative';
  items: { service: BookingServiceType; label: string; hint?: string }[];
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: theme.space[2],
        alignItems: 'flex-start',
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
          color: theme.color.inkMuted,
          fontWeight: theme.type.weight.semibold,
          minWidth: 152,
          paddingTop: 3,
        }}
      >
        {label}
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {items.map((it) => (
          <PairChip
            key={it.service}
            service={it.service}
            label={it.label}
            hint={it.hint}
            tone={tone}
          />
        ))}
      </div>
    </div>
  );
}

function PairChip({
  service,
  label,
  hint,
  tone,
}: {
  service: BookingServiceType;
  label: string;
  hint?: string;
  tone: 'positive' | 'negative';
}) {
  const chip = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: `2px ${theme.space[2]}px`,
        borderRadius: theme.radius.pill,
        background: tone === 'positive' ? theme.color.accentBg : theme.color.bg,
        color: tone === 'positive' ? theme.color.accent : theme.color.inkMuted,
        border: `1px solid ${tone === 'positive' ? 'transparent' : theme.color.border}`,
        fontSize: 11,
        fontWeight: theme.type.weight.medium,
        textDecoration: tone === 'negative' ? 'line-through' : 'none',
        textDecorationColor: tone === 'negative' ? theme.color.inkSubtle : undefined,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: SERVICE_DOT_COLOUR[service],
          opacity: 0.8,
        }}
      />
      {label}
    </span>
  );
  if (!hint) return chip;
  return (
    <Tooltip content={`Can't pair: they ${hint}.`}>
      {chip}
    </Tooltip>
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
        title="Things in your clinic"
        subtitle="Chairs, rooms, equipment, anything that limits how many bookings can happen at once."
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
          title="Add what you have"
          description="Most clinics have chairs (one booking per chair), maybe a lab bench for veneers, and a consult room. Add yours below to start."
          action={
            <Button variant="primary" size="sm" onClick={() => setEditing({ kind: 'new' })}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                <Plus size={14} aria-hidden /> Add the first one
              </span>
            </Button>
          }
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
                    title: 'In use. Remove it from every booking type first.',
                  });
                  return;
                }
                try {
                  await deleteResourcePool(p.id);
                  onToast({ tone: 'success', title: 'Removed' });
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
          }}
        >
          We have <strong style={{ color: theme.color.ink, fontVariantNumeric: 'tabular-nums' }}>
            {pool.capacity}
          </strong>
          {consumers.length > 0
            ? ` · used by ${consumers.length} booking type${consumers.length === 1 ? '' : 's'}`
            : ' · not in use yet'}
          {pool.notes ? ` · ${pool.notes}` : ''}
        </span>
      </div>
      <StatusPill tone="neutral" size="sm">
        {pool.capacity === 1 ? 'Only 1' : `${pool.capacity} of these`}
      </StatusPill>
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
    </li>
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

  const handleNameChange = (v: string) => {
    setDisplayName(v);
    if (isNew) setPoolId(poolIdFromDisplayName(v));
  };

  const save = async () => {
    setBusy(true);
    try {
      if (!displayName.trim()) throw new Error('Give it a name first.');
      if (!isValidPoolId(poolId)) {
        throw new Error('Short name must start with a letter and use only lowercase letters, digits, and hyphens.');
      }
      const cap = parseInt(capacity, 10);
      if (!Number.isFinite(cap) || cap <= 0) {
        throw new Error('How many do you have? Enter a positive whole number.');
      }
      if (isNew && existing.some((e) => e.id === poolId)) {
        throw new Error(`Already have a "${poolId}". Pick a different short name.`);
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
      title={isNew ? 'Add to your clinic' : `Edit ${seed?.display_name ?? 'this'}`}
      description={
        isNew
          ? 'Anything finite that limits how many bookings can happen at once. Chairs, rooms, equipment.'
          : 'Changes apply to all future bookings. Existing bookings keep their slots.'
      }
      footer={<DialogFooter onCancel={onClose} onSave={save} busy={busy} />}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        <Input
          label="Name"
          required
          autoFocus
          value={displayName}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder="e.g. Chairs"
          helper="What you'll call this in the rules below."
        />
        <Input
          label="Short name"
          required
          value={poolId}
          onChange={(e) => setPoolId(e.target.value.toLowerCase())}
          placeholder="chairs"
          disabled={!isNew}
          helper={
            isNew
              ? 'Used internally as a stable id. Lowercase letters, digits, hyphens only.'
              : 'Set when this was created. Stays stable to keep mappings intact.'
          }
        />
        <Input
          label="How many do you have?"
          required
          type="number"
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          placeholder="1"
          helper="Bookings that need this can run side-by-side up to this number."
        />
        <Input
          label="Note (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything internal staff should know."
        />
      </div>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Service rules section — "What each booking needs"
// ─────────────────────────────────────────────────────────────────────────────

interface RuleEditTarget {
  service_type: BookingServiceType;
  service_label: string;
  current_pool_ids: string[];
  current_max_concurrent: number | null;
}

function ServiceRulesSection({
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
  const [editing, setEditing] = useState<RuleEditTarget | null>(null);

  const consumesByService = useMemo(() => {
    const map = new Map<BookingServiceType, string[]>();
    for (const sp of servicePools) {
      const list = map.get(sp.service_type) ?? [];
      list.push(sp.pool_id);
      map.set(sp.service_type, list);
    }
    return map;
  }, [servicePools]);

  const parentByService = useMemo(() => {
    const m = new Map<BookingServiceType, BookingTypeConfigRow>();
    for (const c of configs) {
      if (c.repair_variant == null && c.product_key == null && c.arch == null) {
        m.set(c.service_type, c);
      }
    }
    return m;
  }, [configs]);

  const poolById = useMemo(() => {
    const m = new Map<string, ResourcePoolRow>();
    for (const p of pools) m.set(p.id, p);
    return m;
  }, [pools]);

  return (
    <Card padding="none">
      <SectionHeader
        icon={<Zap size={16} aria-hidden />}
        title="What each booking needs"
        subtitle="For every booking type, what it claims from your clinic plus an optional cap on simultaneous bookings of the same type."
      />
      {pools.length === 0 ? (
        <EmptyState
          icon={<Sparkles size={20} />}
          title="Add resources first"
          description="There's nothing to point bookings at yet. Once you add chairs / rooms above, this section becomes editable."
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {BOOKING_SERVICE_TYPES.map((s, i) => {
            const claimed = consumesByService.get(s.value) ?? [];
            const parent = parentByService.get(s.value);
            const max = parent?.max_concurrent ?? null;
            return (
              <ServiceRuleRow
                key={s.value}
                isFirst={i === 0}
                service={s.value}
                serviceLabel={s.label}
                claimedPools={claimed.map((id) => poolById.get(id)).filter((p): p is ResourcePoolRow => !!p)}
                maxConcurrent={max}
                onEdit={() =>
                  setEditing({
                    service_type: s.value,
                    service_label: s.label,
                    current_pool_ids: claimed,
                    current_max_concurrent: max,
                  })
                }
              />
            );
          })}
        </ul>
      )}

      {editing ? (
        <RuleEditorDialog
          target={editing}
          allPools={pools}
          onClose={() => setEditing(null)}
          onSaved={async (poolIds, maxConcurrent) => {
            try {
              await setServicePools(editing.service_type, poolIds);
              await upsertBookingTypeConfig({
                service_type: editing.service_type,
                max_concurrent: maxConcurrent,
              });
              setEditing(null);
              onToast({ tone: 'success', title: 'Saved' });
              onChanged();
            } catch (e) {
              onToast({
                tone: 'error',
                title: e instanceof Error ? e.message : 'Could not save',
              });
            }
          }}
        />
      ) : null}
    </Card>
  );
}

function ServiceRuleRow({
  isFirst,
  service,
  serviceLabel,
  claimedPools,
  maxConcurrent,
  onEdit,
}: {
  isFirst: boolean;
  service: BookingServiceType;
  serviceLabel: string;
  claimedPools: ResourcePoolRow[];
  maxConcurrent: number | null;
  onEdit: () => void;
}) {
  const sentence = describeRule(claimedPools, maxConcurrent);
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
          background: SERVICE_DOT_COLOUR[service],
          flexShrink: 0,
          marginTop: 6,
        }}
      />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
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
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: claimedPools.length === 0 ? theme.color.inkMuted : theme.color.ink,
            lineHeight: 1.55,
          }}
        >
          {sentence}
        </p>
      </div>
      <Button variant="tertiary" size="sm" onClick={onEdit}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
          <Settings2 size={14} aria-hidden /> Edit
        </span>
      </Button>
    </li>
  );
}

// Sentence-builder for the per-service rule. The service label is
// already shown as the row title; this sentence reads as a
// continuation. Examples:
//   "Needs a chair and the lab bench, max 1 at the same time."
//   "Needs a chair, no fixed cap on simultaneous bookings."
//   "Doesn't need anything yet, bookings can't be made until something is mapped."
function describeRule(
  claimedPools: ResourcePoolRow[],
  maxConcurrent: number | null,
): string {
  if (claimedPools.length === 0) {
    return `Doesn't need anything yet. Bookings can't be made until something is mapped.`;
  }
  const pieces = claimedPools.map((p) => describePoolNeed(p));
  const needs = listJoin(pieces);
  const cap =
    maxConcurrent === null
      ? 'no fixed cap on simultaneous bookings'
      : maxConcurrent === 1
      ? 'max 1 at the same time'
      : `max ${maxConcurrent} at the same time`;
  return `Needs ${needs}, ${cap}.`;
}

function describePoolNeed(p: ResourcePoolRow): string {
  const name = p.display_name.toLowerCase();
  // Heuristic article: "a chair" but "the lab bench" / "the consult
  // room". We pick "the" when there's only one, "a" otherwise — it
  // reads more naturally in a sentence.
  if (p.capacity === 1) return `the ${name}`;
  return `a ${name}`;
}

function listJoin(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function RuleEditorDialog({
  target,
  allPools,
  onClose,
  onSaved,
}: {
  target: RuleEditTarget;
  allPools: ResourcePoolRow[];
  onClose: () => void;
  onSaved: (poolIds: string[], maxConcurrent: number | null) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(target.current_pool_ids),
  );
  const [maxStr, setMaxStr] = useState<string>(
    target.current_max_concurrent != null ? String(target.current_max_concurrent) : '',
  );
  const [busy, setBusy] = useState(false);

  const togglePool = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const save = () => {
    setBusy(true);
    const trimmed = maxStr.trim();
    let max: number | null = null;
    if (trimmed !== '') {
      const n = parseInt(trimmed, 10);
      if (!Number.isFinite(n) || n <= 0) {
        setBusy(false);
        return;
      }
      max = n;
    }
    onSaved(Array.from(selected), max);
    setBusy(false);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={560}
      title={`${target.service_label} rules`}
      description="Pick what's needed when one of these is booked, and an optional cap on how many can run at the same time."
      footer={<DialogFooter onCancel={onClose} onSave={save} busy={busy} />}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <section style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          <header>
            <span
              style={{
                fontSize: theme.type.size.xs,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
                color: theme.color.inkMuted,
                fontWeight: theme.type.weight.semibold,
              }}
            >
              What it needs
            </span>
          </header>
          {allPools.length === 0 ? (
            <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              Add resources in the section above first.
            </p>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: theme.space[2],
              }}
            >
              {allPools.map((p) => {
                const on = selected.has(p.id);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => togglePool(p.id)}
                      aria-pressed={on}
                      style={{
                        appearance: 'none',
                        width: '100%',
                        textAlign: 'left',
                        border: `1px solid ${on ? theme.color.ink : theme.color.border}`,
                        background: on ? theme.color.bg : 'transparent',
                        borderRadius: theme.radius.input,
                        padding: `${theme.space[3]}px ${theme.space[4]}px`,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        display: 'flex',
                        alignItems: 'center',
                        gap: theme.space[3],
                        WebkitTapHighlightColor: 'transparent',
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: 4,
                          border: `1.5px solid ${on ? theme.color.ink : theme.color.border}`,
                          background: on ? theme.color.ink : 'transparent',
                          color: theme.color.surface,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          fontSize: 12,
                          fontWeight: theme.type.weight.semibold,
                        }}
                      >
                        {on ? '✓' : ''}
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
                          {p.display_name}
                        </span>
                        <span style={{ display: 'block', fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                          We have {p.capacity}
                          {p.notes ? ` · ${p.notes}` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          <header>
            <span
              style={{
                fontSize: theme.type.size.xs,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
                color: theme.color.inkMuted,
                fontWeight: theme.type.weight.semibold,
              }}
            >
              Most at once
            </span>
          </header>
          <Input
            type="number"
            min={1}
            value={maxStr}
            onChange={(e) => setMaxStr(e.target.value)}
            placeholder="No fixed cap"
            helper="Optional. Leave blank to let the resources above decide. Set a number when you want a hard cap regardless of resources."
          />
        </section>
      </div>
    </Dialog>
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
