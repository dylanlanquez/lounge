import { Check, Plus } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import type { BookingStateApi } from '../state.ts';
import type { WidgetUpgrade } from '../data.ts';
import { formatPrice } from '../state.ts';

// Upgrades step — surfaces add-ons for whatever catalogue row the
// patient has resolved to (via service + axis pins). Only inserted
// in the active step list when at least one widget-visible upgrade
// applies; the widget shell skips this screen entirely when there
// are no upsells to offer.
//
// Multi-pick: the patient can tick zero, one, or several upgrades.
// State holds an array of upgrade ids; toggleUpgrade adds/removes.
//
// Pricing UX: each card shows the upgrade's per-arch price (and
// both-arches price when the parent catalogue row's arch_match is
// 'single'). The booking summary picks up the selection
// progressively — phase 2c will fold it into the total alongside
// per-axis price resolution.

export function UpgradesStep({
  api,
  upgrades,
}: {
  api: BookingStateApi;
  upgrades: WidgetUpgrade[];
}) {
  const archIsBoth = api.state.axes.arch === 'both';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          lineHeight: theme.type.leading.snug,
          maxWidth: 560,
        }}
      >
        Anything you'd like to add? Pick as many as you want, or none, then continue.
        You can always change your mind in clinic.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
        {upgrades.map((upgrade) => (
          <UpgradeCard
            key={upgrade.id}
            upgrade={upgrade}
            archIsBoth={archIsBoth}
            checked={api.state.upgradeIds.includes(upgrade.id)}
            onToggle={() => api.toggleUpgrade(upgrade.id)}
          />
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={api.goNext}
          style={{
            appearance: 'none',
            border: 'none',
            background: theme.color.ink,
            color: theme.color.surface,
            padding: `${theme.space[3]}px ${theme.space[5]}px`,
            borderRadius: theme.radius.pill,
            fontFamily: 'inherit',
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            cursor: 'pointer',
          }}
        >
          {api.state.upgradeIds.length === 0
            ? 'No extras, continue'
            : `Continue with ${api.state.upgradeIds.length} extra${api.state.upgradeIds.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}

function UpgradeCard({
  upgrade,
  archIsBoth,
  checked,
  onToggle,
}: {
  upgrade: WidgetUpgrade;
  archIsBoth: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  const price =
    archIsBoth && upgrade.bothArchesPricePence !== null
      ? upgrade.bothArchesPricePence
      : upgrade.unitPricePence;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={checked}
      style={{
        appearance: 'none',
        textAlign: 'left',
        fontFamily: 'inherit',
        cursor: 'pointer',
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        borderRadius: theme.radius.card,
        background: theme.color.surface,
        border: `1px solid ${checked ? theme.color.accent : theme.color.border}`,
        boxShadow: checked ? theme.shadow.card : 'none',
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[4],
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
      onMouseEnter={(e) => {
        if (checked) return;
        e.currentTarget.style.borderColor = theme.color.ink;
      }}
      onMouseLeave={(e) => {
        if (checked) return;
        e.currentTarget.style.borderColor = theme.color.border;
      }}
    >
      <span
        aria-hidden
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          border: `2px solid ${checked ? theme.color.accent : theme.color.border}`,
          background: checked ? theme.color.accent : theme.color.surface,
          color: checked ? theme.color.surface : theme.color.inkSubtle,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      >
        {checked ? <Check size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {upgrade.name}
        </p>
        {upgrade.description ? (
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: theme.type.leading.snug,
            }}
          >
            {upgrade.description}
          </p>
        ) : null}
      </div>
      <span
        style={{
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        +{formatPrice(price)}
      </span>
    </button>
  );
}
