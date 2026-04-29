import { Minus, Package, Plus, Trash2 } from 'lucide-react';
import { theme } from '../../theme/index.ts';

export interface CartLineItemProps {
  name: string;
  quantity: number;
  unitPricePence: number;
  lineTotalPence: number;
  description?: string | null;
  onIncrement: () => void;
  onDecrement: () => void;
  onRemove: () => void;
  disabled?: boolean;
  // When false, hide the qty stepper (single-instance services like
  // an in-clinic impression appointment). Defaults true so callers
  // that don't pass this keep the existing behaviour.
  quantityEnabled?: boolean;
  // Snapshot of the catalogue row's image_url. Renders as a small
  // thumbnail at the leading edge. Null falls back to a Package
  // glyph on a tinted square — same treatment the catalogue picker
  // uses when a row has no image.
  thumbnailUrl?: string | null;
}

export function CartLineItem({
  name,
  quantity,
  unitPricePence,
  lineTotalPence,
  description,
  onIncrement,
  onDecrement,
  onRemove,
  disabled = false,
  quantityEnabled = true,
  thumbnailUrl = null,
}: CartLineItemProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        background: theme.color.surface,
        borderRadius: 12,
        boxShadow: theme.shadow.card,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Thumb src={thumbnailUrl} alt={name} />
      <div style={{ flex: 1, minWidth: 0 }}>
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
          {name}
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {description ? `${description} · ` : ''}
          £{(unitPricePence / 100).toFixed(2)} each
        </p>
      </div>

      {quantityEnabled ? (
        <QtyStepper
          value={quantity}
          onIncrement={onIncrement}
          onDecrement={onDecrement}
          disabled={disabled}
        />
      ) : null}

      <div
        style={{
          minWidth: 72,
          textAlign: 'right',
          fontSize: theme.type.size.base,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        £{(lineTotalPence / 100).toFixed(2)}
      </div>

      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label="Remove line item"
        style={{
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          color: theme.color.inkMuted,
          cursor: disabled ? 'not-allowed' : 'pointer',
          padding: theme.space[2],
          borderRadius: theme.radius.pill,
          flexShrink: 0,
        }}
      >
        <Trash2 size={18} />
      </button>
    </div>
  );
}

function QtyStepper({
  value,
  onIncrement,
  onDecrement,
  disabled,
}: {
  value: number;
  onIncrement: () => void;
  onDecrement: () => void;
  disabled: boolean;
}) {
  const button = (_action: 'inc' | 'dec') => ({
    appearance: 'none' as const,
    border: `1px solid ${theme.color.border}`,
    background: theme.color.surface,
    width: 32,
    height: 32,
    borderRadius: theme.radius.pill,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: disabled ? 'not-allowed' : 'pointer',
    color: theme.color.ink,
    flexShrink: 0,
  });
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
      <button type="button" onClick={onDecrement} disabled={disabled} aria-label="Decrement" style={button('dec')}>
        <Minus size={16} />
      </button>
      <span
        style={{
          minWidth: 28,
          textAlign: 'center',
          fontSize: theme.type.size.base,
          fontWeight: theme.type.weight.semibold,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
      <button type="button" onClick={onIncrement} disabled={disabled} aria-label="Increment" style={button('inc')}>
        <Plus size={16} />
      </button>
    </div>
  );
}

// Square thumbnail with rounded clip + subtle border. Falls back to
// a Package glyph on a tinted background when no image_url is set
// (ad-hoc cart rows). Mirrors the CataloguePicker's Thumb pattern so
// the cart line and the picker row share one visual language.
function Thumb({ src, alt }: { src: string | null; alt: string }) {
  const size = 48;
  if (!src) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: theme.radius.input,
          background: theme.color.bg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: theme.color.inkSubtle,
          flexShrink: 0,
        }}
        aria-hidden
      >
        <Package size={20} />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      style={{
        width: size,
        height: size,
        borderRadius: theme.radius.input,
        objectFit: 'cover',
        background: theme.color.bg,
        flexShrink: 0,
      }}
    />
  );
}
