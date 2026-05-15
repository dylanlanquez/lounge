import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import {
  useRepairCatalogueRows,
  type RepairCatalogueRow,
} from '../data.ts';
import type { BookingStateApi, RepairLine } from '../state.ts';
import { formatPrice } from '../state.ts';
import { QUIZ } from '../quizTokens.ts';

// RepairBuilder — denture-repair step.
//
// Replaces the single-select AxisStep when the patient is booking a
// denture repair. The customer can pile up multiple repairs in one
// appointment (reline upper + 2 broken teeth on lower + cracked
// denture), each with its own arch + quantity. Built primarily for
// elderly users who are uncomfortable with digital flows:
//
//   • Big tiles, big text, generous tap targets (no row narrower
//     than 56px on touch).
//   • Plain-English copy. "What needs fixing?" not "Select repair
//     variant." "Which denture?" not "Pick arch."
//   • One question at a time. Tapping a tile opens a slide-up sheet
//     that asks just the arch (+ how many, if the repair is priced
//     per tooth). No silent state, no compound decisions.
//   • A visible cart below the tiles so they always know what
//     they've already picked and what it will cost. Remove is one
//     unambiguous × tap per line.
//   • The catalogue drives everything — repair names, prices,
//     per-tooth vs flat, both-arches discount. Editing
//     lwo_catalogue updates the widget without code changes.

export function RepairBuilder({
  api,
  accent = QUIZ.ACCENT,
}: {
  api: BookingStateApi;
  accent?: string;
}) {
  const rowsResult = useRepairCatalogueRows();
  const [editing, setEditing] = useState<RepairCatalogueRow | null>(null);
  // Prefill landing: when the host page's data-attr / Shopify
  // trigger pinned a repair_variant, open that tile's sheet on
  // mount so the patient lands directly in "confirm arch + qty"
  // rather than another tap. Runs once per session: we clear the
  // axes pin after opening so a Back-Cancel-Back loop doesn't keep
  // re-opening it.
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (prefilledRef.current) return;
    const wantsVariant = api.state.axes.repair_variant;
    if (!wantsVariant || api.state.repairItems.length > 0) return;
    if (!rowsResult.data) return;
    // Match by repair_variant text (what the host page's data-attr
    // resolves to via Widget.tsx prefill). Also accept a code match
    // as a fallback so a future trigger could pass either.
    const match = rowsResult.data.find(
      (r) => r.repairVariant === wantsVariant || r.code === wantsVariant,
    );
    if (match) {
      setEditing(match);
      prefilledRef.current = true;
    }
  }, [rowsResult.data, api.state.axes.repair_variant, api.state.repairItems.length]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <Helper />

      {rowsResult.loading ? (
        <SkeletonTiles />
      ) : rowsResult.error ? (
        <ErrorCard message={rowsResult.error} />
      ) : !rowsResult.data || rowsResult.data.length === 0 ? (
        <EmptyCard />
      ) : (
        <TileGrid
          rows={rowsResult.data}
          onTap={setEditing}
          accent={accent}
        />
      )}

      <Cart
        items={api.state.repairItems}
        onRemove={api.removeRepairItem}
        accent={accent}
      />

      {editing ? (
        <RepairSheet
          row={editing}
          onClose={() => setEditing(null)}
          onAdd={(line) => {
            api.addRepairItem(line);
            setEditing(null);
          }}
          accent={accent}
        />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helper paragraph
// ─────────────────────────────────────────────────────────────────────

function Helper() {
  return (
    <p
      style={{
        margin: 0,
        fontSize: 15,
        color: QUIZ.MUTED_2,
        lineHeight: 1.45,
        maxWidth: 560,
        textAlign: 'center',
        marginLeft: 'auto',
        marginRight: 'auto',
      }}
    >
      Tap each repair you need. You can choose more than one.
    </p>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Tile grid — one large tile per catalogue row
// ─────────────────────────────────────────────────────────────────────

function TileGrid({
  rows,
  onTap,
  accent,
}: {
  rows: RepairCatalogueRow[];
  onTap: (row: RepairCatalogueRow) => void;
  accent: string;
}) {
  return (
    <div
      className="vlounge-stagger"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 16,
        margin: '0 auto',
        maxWidth: 920,
        width: '100%',
      }}
    >
      {rows.map((row) => (
        <RepairTile key={row.id} row={row} onTap={() => onTap(row)} accent={accent} />
      ))}
    </div>
  );
}

function RepairTile({
  row,
  onTap,
  accent,
}: {
  row: RepairCatalogueRow;
  onTap: () => void;
  accent: string;
}) {
  const [hovered, setHovered] = useState(false);
  const priceLine = formatTilePrice(row);
  return (
    <button
      type="button"
      onClick={onTap}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      aria-label={`${row.name}, ${priceLine}. Tap to add.`}
      style={{
        position: 'relative',
        background: QUIZ.SURFACE,
        border: `2px solid ${hovered ? accent : 'transparent'}`,
        borderRadius: QUIZ.R_CARD,
        padding: '22px 20px',
        minHeight: 130,
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: `all 0.2s ${QUIZ.EASE_CARD}, transform 0.15s ${QUIZ.EASE_CARD}`,
        transform: hovered ? 'translateY(-2px)' : 'none',
        boxShadow: hovered ? QUIZ.SHADOW_LIFT : 'none',
        animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <h3
        style={{
          margin: 0,
          fontSize: 19,
          fontWeight: 600,
          color: QUIZ.INK,
          letterSpacing: '-0.01em',
          lineHeight: 1.3,
        }}
      >
        {tileTitleFor(row)}
      </h3>
      {row.description ? (
        <p
          style={{
            margin: 0,
            fontSize: 14,
            color: QUIZ.MUTED,
            lineHeight: 1.45,
          }}
        >
          {row.description}
        </p>
      ) : null}
      <p
        style={{
          margin: 'auto 0 0',
          paddingTop: 6,
          fontSize: 15,
          fontWeight: 700,
          color: accent,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {priceLine}
      </p>
    </button>
  );
}

// "Broken tooth on denture" reads heavy in a tile heading; trim the
// "on denture" suffix so the tile says "Broken tooth". The full name
// stays available in the cart line where the larger row format
// carries it gracefully.
function tileTitleFor(row: RepairCatalogueRow): string {
  return row.name.replace(/ on denture$/i, '').replace(/ to denture$/i, '');
}

// Tile price line:
//   per tooth → "£50 per tooth"
//   per arch  → "£160 per arch"
//   flat      → "£70"
function formatTilePrice(row: RepairCatalogueRow): string {
  const base = formatPrice(row.unitPricePence);
  if (row.unitLabel === 'per tooth') return `${base} per tooth`;
  if (row.unitLabel === 'per arch') return `${base} per arch`;
  return base;
}

// ─────────────────────────────────────────────────────────────────────
// Cart — visible list of selected repairs
// ─────────────────────────────────────────────────────────────────────

function Cart({
  items,
  onRemove,
  accent,
}: {
  items: RepairLine[];
  onRemove: (lineId: string) => void;
  accent: string;
}) {
  return (
    <section
      aria-label="Your repairs"
      style={{
        margin: '0 auto',
        maxWidth: 920,
        width: '100%',
        background: QUIZ.SURFACE,
        border: `1px solid ${QUIZ.BORDER}`,
        borderRadius: QUIZ.R_CARD,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <h3
        style={{
          margin: 0,
          fontSize: 16,
          fontWeight: 600,
          color: QUIZ.INK,
          letterSpacing: '-0.005em',
        }}
      >
        Your repairs
      </h3>
      {items.length === 0 ? (
        <p
          style={{
            margin: 0,
            fontSize: 14,
            color: QUIZ.MUTED_2,
            lineHeight: 1.5,
          }}
        >
          Tap a repair above to start. You can add as many as you need.
        </p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {items.map((line) => (
            <CartLine
              key={line.lineId}
              line={line}
              onRemove={() => onRemove(line.lineId)}
              accent={accent}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CartLine({
  line,
  onRemove,
  accent,
}: {
  line: RepairLine;
  onRemove: () => void;
  accent: string;
}) {
  const archLabel = ARCH_LABEL[line.arch];
  const qtySuffix =
    line.unitLabel === 'per tooth' && line.quantity > 1
      ? `, ${line.quantity} teeth`
      : '';
  const description = `${archLabel}${qtySuffix}`;
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        background: QUIZ.SOFT_BG,
        borderRadius: QUIZ.R_INPUT,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: QUIZ.INK,
            lineHeight: 1.3,
          }}
        >
          {line.name}
        </div>
        <div
          style={{
            fontSize: 13,
            color: QUIZ.MUTED_2,
            lineHeight: 1.4,
            marginTop: 2,
          }}
        >
          {description}
        </div>
      </div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: accent,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        {formatPrice(line.lineTotalPence)}
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${line.name}`}
        style={{
          border: 'none',
          background: 'transparent',
          width: 36,
          height: 36,
          borderRadius: '50%',
          cursor: 'pointer',
          color: QUIZ.MUTED_2,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: `all 0.15s ${QUIZ.EASE_CARD}`,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = QUIZ.BG_HOVER;
          e.currentTarget.style.color = QUIZ.ALERT;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = QUIZ.MUTED_2;
        }}
      >
        <X size={18} aria-hidden />
      </button>
    </li>
  );
}

const ARCH_LABEL: Record<'upper' | 'lower' | 'both', string> = {
  upper: 'Upper denture',
  lower: 'Lower denture',
  both: 'Both dentures',
};

// ─────────────────────────────────────────────────────────────────────
// Slide-up sheet — confirm arch + quantity for one repair
// ─────────────────────────────────────────────────────────────────────

function RepairSheet({
  row,
  onClose,
  onAdd,
  accent,
}: {
  row: RepairCatalogueRow;
  onClose: () => void;
  onAdd: (line: Omit<RepairLine, 'lineId'>) => void;
  accent: string;
}) {
  const [arch, setArch] = useState<'upper' | 'lower' | 'both' | null>(null);
  const [quantity, setQuantity] = useState(1);
  const isPerTooth = row.unitLabel === 'per tooth';

  // Force per-tooth repairs into two separate cart lines per arch —
  // the technician needs to see "3 teeth on upper, 1 on lower" not
  // "4 teeth somewhere on both." Hide the 'both' tile entirely so
  // the only outcome is one-arch-per-line.
  const archOptions: Array<'upper' | 'lower' | 'both'> = isPerTooth
    ? ['upper', 'lower']
    : ['upper', 'lower', 'both'];

  // Esc + backdrop close. The first tile gets autofocus so keyboard
  // users land on a meaningful control rather than the dialog
  // container.
  const sheetRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Lock body scroll while the sheet is open so the patient can't
    // accidentally scroll the underlying tiles while reaching for the
    // sheet's stepper.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const linePence = computeLinePrice(row, arch, quantity);
  const canAdd = arch !== null;
  const teethLabel = isPerTooth ? 'How many teeth?' : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Add ${row.name}`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        animation: `vlounge-fadeIn 0.2s ${QUIZ.EASE_CARD}`,
      }}
    >
      <div
        onClick={onClose}
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.45)',
        }}
      />
      <div
        ref={sheetRef}
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 560,
          background: QUIZ.SURFACE,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          padding: '20px 20px calc(20px + env(safe-area-inset-bottom, 0px))',
          boxShadow: '0 -8px 32px rgba(0, 0, 0, 0.18)',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          maxHeight: '85vh',
          overflowY: 'auto',
          animation: `vlounge-sheet-up 0.28s ${QUIZ.EASE_BOUNCE}`,
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <h2
              style={{
                margin: 0,
                fontSize: 22,
                fontWeight: 600,
                color: QUIZ.INK,
                letterSpacing: '-0.01em',
                lineHeight: 1.25,
              }}
            >
              {row.name}
            </h2>
            <p
              style={{
                margin: '4px 0 0',
                fontSize: 14,
                color: QUIZ.MUTED_2,
                fontWeight: 500,
              }}
            >
              {formatTilePrice(row)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              border: 'none',
              background: QUIZ.BG_HOVER,
              width: 40,
              height: 40,
              borderRadius: '50%',
              cursor: 'pointer',
              color: QUIZ.INK,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              transition: `background 0.15s ${QUIZ.EASE_CARD}`,
            }}
          >
            <X size={20} aria-hidden />
          </button>
        </header>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h3
            style={{
              margin: 0,
              fontSize: 17,
              fontWeight: 600,
              color: QUIZ.INK,
            }}
          >
            Which denture?
          </h3>
          <ArchPicker
            options={archOptions}
            selected={arch}
            onSelect={setArch}
            accent={accent}
          />
        </section>

        {isPerTooth ? (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h3
              style={{
                margin: 0,
                fontSize: 17,
                fontWeight: 600,
                color: QUIZ.INK,
              }}
            >
              {teethLabel}
            </h3>
            <Stepper
              value={quantity}
              onChange={setQuantity}
              min={1}
              max={14}
              accent={accent}
            />
            <p
              style={{
                margin: 0,
                fontSize: 14,
                color: QUIZ.MUTED_2,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {quantity} × {formatPrice(row.unitPricePence)} ={' '}
              <strong style={{ color: QUIZ.INK }}>
                {formatPrice(linePence)}
              </strong>
            </p>
          </section>
        ) : null}

        <button
          type="button"
          onClick={() => {
            if (!arch) return;
            onAdd({
              catalogueId: row.id,
              code: row.code,
              repairVariant: row.repairVariant,
              name: row.name,
              unitLabel: row.unitLabel,
              arch,
              quantity,
              unitPricePence: row.unitPricePence,
              bothArchesPricePence: row.bothArchesPricePence,
              lineTotalPence: linePence,
            });
          }}
          disabled={!canAdd}
          style={{
            marginTop: 4,
            border: 'none',
            padding: '14px 28px',
            borderRadius: QUIZ.R_PILL,
            cursor: canAdd ? 'pointer' : 'not-allowed',
            fontSize: 16,
            fontWeight: 700,
            background: accent,
            color: '#fff',
            fontFamily: 'inherit',
            transition: `all 0.2s ${QUIZ.EASE_CARD}`,
            opacity: canAdd ? 1 : 0.4,
            height: 52,
          }}
        >
          {canAdd
            ? `Add to my repairs — ${formatPrice(linePence)}`
            : 'Choose a denture above'}
        </button>
      </div>
    </div>
  );
}

// Per-line price resolution. Mirrors computePriceBreakdown's
// priceFor() but applied per-row at add-time so the cart shows a
// stable amount and the summing in state.ts stays trivial.
//
//   per arch + arch='both' + both_arches_price set → both_arches_price
//   per arch + arch='both' + no override          → 2 × unit_price
//   per tooth                                     → qty × unit_price
//   flat                                          → unit_price
function computeLinePrice(
  row: RepairCatalogueRow,
  arch: 'upper' | 'lower' | 'both' | null,
  quantity: number,
): number {
  if (!arch) return 0;
  if (row.unitLabel === 'per tooth') {
    return quantity * row.unitPricePence;
  }
  if (row.unitLabel === 'per arch' && arch === 'both') {
    return row.bothArchesPricePence ?? row.unitPricePence * 2;
  }
  return row.unitPricePence;
}

// ─────────────────────────────────────────────────────────────────────
// Arch picker — three mini tiles (or two for per-tooth)
// ─────────────────────────────────────────────────────────────────────

function ArchPicker({
  options,
  selected,
  onSelect,
  accent,
}: {
  options: Array<'upper' | 'lower' | 'both'>;
  selected: 'upper' | 'lower' | 'both' | null;
  onSelect: (value: 'upper' | 'lower' | 'both') => void;
  accent: string;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${options.length}, 1fr)`,
        gap: 10,
      }}
    >
      {options.map((opt) => {
        const isOn = selected === opt;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onSelect(opt)}
            aria-pressed={isOn}
            aria-label={ARCH_LABEL[opt]}
            style={{
              border: `2px solid ${isOn ? accent : QUIZ.BORDER}`,
              background: isOn ? QUIZ.SOFT_BG_HIGHLIGHT : QUIZ.SURFACE,
              color: QUIZ.INK,
              borderRadius: QUIZ.R_INPUT,
              padding: '14px 8px',
              fontFamily: 'inherit',
              fontSize: 16,
              fontWeight: 600,
              cursor: 'pointer',
              transition: `all 0.15s ${QUIZ.EASE_CARD}`,
              minHeight: 64,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              lineHeight: 1.2,
            }}
          >
            <span>{ARCH_TILE_TITLE[opt]}</span>
            <span
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: isOn ? accent : QUIZ.MUTED_2,
              }}
            >
              {ARCH_TILE_SUB[opt]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const ARCH_TILE_TITLE: Record<'upper' | 'lower' | 'both', string> = {
  upper: 'Upper',
  lower: 'Lower',
  both: 'Both',
};

const ARCH_TILE_SUB: Record<'upper' | 'lower' | 'both', string> = {
  upper: 'Top denture',
  lower: 'Bottom denture',
  both: 'Top and bottom',
};

// ─────────────────────────────────────────────────────────────────────
// Stepper — −/+ around a big readout
// ─────────────────────────────────────────────────────────────────────

function Stepper({
  value,
  onChange,
  min,
  max,
  accent,
}: {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  accent: string;
}) {
  const canDec = value > min;
  const canInc = value < max;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        background: QUIZ.SOFT_BG,
        borderRadius: QUIZ.R_INPUT,
        padding: 8,
      }}
    >
      <StepButton
        onClick={() => canDec && onChange(value - 1)}
        disabled={!canDec}
        ariaLabel="Decrease quantity"
        accent={accent}
      >
        <Minus size={20} aria-hidden />
      </StepButton>
      <div
        aria-live="polite"
        aria-label={`Quantity ${value}`}
        style={{
          flex: 1,
          textAlign: 'center',
          fontSize: 28,
          fontWeight: 700,
          color: QUIZ.INK,
          fontVariantNumeric: 'tabular-nums',
          minWidth: 60,
        }}
      >
        {value}
      </div>
      <StepButton
        onClick={() => canInc && onChange(value + 1)}
        disabled={!canInc}
        ariaLabel="Increase quantity"
        accent={accent}
      >
        <Plus size={20} aria-hidden />
      </StepButton>
    </div>
  );
}

function StepButton({
  onClick,
  disabled,
  ariaLabel,
  accent,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  ariaLabel: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{
        border: 'none',
        width: 52,
        height: 52,
        borderRadius: '50%',
        background: disabled ? QUIZ.BG_HOVER : accent,
        color: disabled ? QUIZ.SUBTLE : '#fff',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        transition: `all 0.15s ${QUIZ.EASE_CARD}`,
      }}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Loading / error / empty states
// ─────────────────────────────────────────────────────────────────────

function SkeletonTiles() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 16,
        margin: '0 auto',
        maxWidth: 920,
        width: '100%',
      }}
    >
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          aria-hidden
          style={{
            height: 130,
            background: QUIZ.SURFACE,
            border: `1px solid ${QUIZ.BORDER}`,
            borderRadius: QUIZ.R_CARD,
            opacity: 0.6,
            animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
          }}
        />
      ))}
    </div>
  );
}

function EmptyCard() {
  return (
    <div
      style={{
        background: QUIZ.SURFACE,
        border: `1px dashed ${QUIZ.BORDER}`,
        borderRadius: QUIZ.R_CARD,
        padding: 24,
        textAlign: 'center',
        color: QUIZ.MUTED_2,
        fontSize: 14,
        maxWidth: 480,
        margin: '0 auto',
      }}
    >
      No repair options available. Give us a call so we can sort it for
      you.
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div
      style={{
        background: QUIZ.SURFACE,
        border: `1px solid ${QUIZ.ALERT}`,
        borderRadius: QUIZ.R_CARD,
        padding: 20,
        maxWidth: 480,
        margin: '0 auto',
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 16,
          fontWeight: 600,
          color: QUIZ.ALERT,
        }}
      >
        Couldn't load the repairs
      </p>
      <p
        style={{
          margin: '8px 0 0',
          fontSize: 14,
          color: QUIZ.MUTED_2,
        }}
      >
        Refresh the page, or call us if it sticks. ({message})
      </p>
    </div>
  );
}
