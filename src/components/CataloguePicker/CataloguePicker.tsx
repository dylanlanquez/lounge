import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Minus, Package, Plus, Search, Sparkles, X } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { Toast } from '../Toast/Toast.tsx';
import { theme } from '../../theme/index.ts';
import {
  type CatalogueRow,
  useCatalogueActive,
} from '../../lib/queries/catalogue.ts';
import { findMatches, type MatchCriteria, totalForQty } from '../../lib/catalogueMatch.ts';
import {
  type IntakeAnswer,
  archToAnatomy,
  filterCareIntake,
} from '../../lib/queries/appointments.ts';
import {
  addCatalogueItemsToCart,
  type CatalogueAddOptions,
} from '../../lib/queries/carts.ts';

// ─────────────────────────────────────────────────────────────────────────────
// CataloguePicker — a single-screen accordion modal.
//
// Each catalogue row renders as a collapsed tile (thumbnail + name +
// price + caret). Tapping the tile expands it inline to reveal the
// per-line options (qty + arch + shade + notes) and an "Add to bag"
// action. Only one row is expanded at a time; tapping another collapses
// the previous and opens the new one. After adding, the row collapses
// and the receptionist can pick another product without bouncing
// between screens.
//
// Operates in two modes:
//   - cartId set:  writes to lng_cart_items immediately (visit page).
//   - onStage set: returns the (row, qty, options) tuple to the parent
//                  which holds it in component state until the arrival
//                  wizard's final submit creates a cart.
// ─────────────────────────────────────────────────────────────────────────────

export interface CataloguePickerProps {
  open: boolean;
  onClose: () => void;
  cartId?: string | null;
  onStage?: (row: CatalogueRow, qty: number, options: CatalogueAddOptions) => void;
  intake: IntakeAnswer[] | null;
  eventTypeLabel: string | null;
  onItemAdded: () => void;
}

export function CataloguePicker({
  open,
  onClose,
  cartId,
  onStage,
  intake,
  eventTypeLabel,
  onItemAdded,
}: CataloguePickerProps) {
  const { rows, loading, error } = useCatalogueActive();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string } | null>(null);

  const criteria = useMemo(
    () => criteriaFromAppointment(intake, eventTypeLabel),
    [intake, eventTypeLabel]
  );
  const suggestions = useMemo(() => findMatches(rows, criteria), [rows, criteria]);

  // Reset state when the sheet closes / re-opens. Without this the
  // previously-expanded row would still be open the next time the
  // receptionist opens the picker.
  useEffect(() => {
    if (!open) {
      setExpandedKey(null);
      setSearch('');
    }
  }, [open]);

  // Filter rows by case-insensitive substring across name + description
  // + sku. Search overrides the suggested + grouped layout to a flat
  // list — when staff are searching they want results, not categories.
  const trimmedSearch = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!trimmedSearch) return rows;
    return rows.filter((r) => {
      const haystack = `${r.name} ${r.description ?? ''} ${r.code}`.toLowerCase();
      return haystack.includes(trimmedSearch);
    });
  }, [rows, trimmedSearch]);

  const grouped = useMemo(() => {
    const map = new Map<string, CatalogueRow[]>();
    for (const r of filtered) {
      const list = map.get(r.category) ?? [];
      list.push(r);
      map.set(r.category, list);
    }
    return [...map.entries()];
  }, [filtered]);

  const handleAdded = () => {
    setExpandedKey(null);
    setToast({ tone: 'success', title: 'Added to bag' });
    onItemAdded();
  };

  const renderRow = (row: CatalogueRow) => (
    <li key={row.id}>
      <ProductRow
        row={row}
        expanded={expandedKey === row.id}
        onToggle={() => setExpandedKey(expandedKey === row.id ? null : row.id)}
        cartId={cartId ?? null}
        onStage={onStage}
        onAdded={handleAdded}
        onError={(msg) => setToast({ tone: 'error', title: msg })}
      />
    </li>
  );

  return (
    <>
      <BottomSheet
        open={open}
        onClose={onClose}
        title="Choose product"
        description={
          trimmedSearch
            ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'}`
            : 'Tap a product to set arch, shade and quantity, then add it to the bag.'
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          <SearchField value={search} onChange={setSearch} />

          {error ? (
            <p style={{ margin: 0, color: theme.color.alert }}>Could not load catalogue: {error}</p>
          ) : loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              <Skeleton height={64} radius={14} />
              <Skeleton height={64} radius={14} />
              <Skeleton height={64} radius={14} />
            </div>
          ) : filtered.length === 0 ? (
            <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
              No products match "{trimmedSearch}".
            </p>
          ) : trimmedSearch ? (
            <ul style={listStyle}>{filtered.map(renderRow)}</ul>
          ) : (
            <>
              {suggestions.length > 0 ? (
                <Section title="Suggested for this booking" accent>
                  <ul style={listStyle}>{suggestions.map(renderRow)}</ul>
                </Section>
              ) : null}
              {grouped.map(([category, categoryRows]) => (
                <Section key={category} title={category}>
                  <ul style={listStyle}>{categoryRows.map(renderRow)}</ul>
                </Section>
              ))}
            </>
          )}
        </div>
      </BottomSheet>

      {toast ? (
        <div
          style={{
            position: 'fixed',
            bottom: theme.space[6],
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1100,
          }}
        >
          <Toast
            tone={toast.tone}
            title={toast.title}
            duration={2000}
            onDismiss={() => setToast(null)}
          />
        </div>
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Search field — borderless search-style input that lives at the top
// of the modal. Dedicated component so the icon + clear button + input
// rules don't bleed into the row markup.
// ─────────────────────────────────────────────────────────────────────────────

function SearchField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        height: 44,
        padding: `0 ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: theme.color.bg,
        border: `1px solid ${theme.color.border}`,
        cursor: 'text',
      }}
    >
      <Search size={16} color={theme.color.inkSubtle} aria-hidden style={{ flexShrink: 0 }} />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder="Search products"
        aria-label="Search products"
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
            background: 'transparent',
            border: 'none',
            color: theme.color.inkSubtle,
            cursor: 'pointer',
            padding: theme.space[1],
            display: 'inline-flex',
          }}
        >
          <X size={14} />
        </button>
      ) : null}
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section — sentence-case heading + optional accent eyebrow + ul slot.
// ─────────────────────────────────────────────────────────────────────────────

function Section({
  title,
  accent = false,
  children,
}: {
  title: string;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <header
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[2],
        }}
      >
        {accent ? <Sparkles size={14} color={theme.color.accent} aria-hidden /> : null}
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: accent ? theme.color.accent : theme.color.inkMuted,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {title}
        </h3>
      </header>
      {children}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ProductRow — the accordion's atomic unit.
//
// Header (always visible): thumbnail + name + price + caret.
// Body (visible when expanded): qty + arch + shade + notes + Add CTA.
// CSS Grid trick: grid-template-rows transitions from 0fr → 1fr to give
// a smooth height animation without measuring DOM. Inner div has
// overflow: hidden so the content clips during the transition.
// ─────────────────────────────────────────────────────────────────────────────

function ProductRow({
  row,
  expanded,
  onToggle,
  cartId,
  onStage,
  onAdded,
  onError,
}: {
  row: CatalogueRow;
  expanded: boolean;
  onToggle: () => void;
  cartId: string | null;
  onStage?: (row: CatalogueRow, qty: number, options: CatalogueAddOptions) => void;
  onAdded: () => void;
  onError: (msg: string) => void;
}) {
  const headerId = `picker-row-header-${row.id}`;
  const panelId = `picker-row-panel-${row.id}`;

  const [qty, setQty] = useState(1);
  const [arch, setArch] = useState<'upper' | 'lower' | null>(null);
  const [shade, setShade] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset the per-line form whenever the row collapses so the next
  // expansion starts clean.
  useEffect(() => {
    if (!expanded) {
      setQty(1);
      setArch(null);
      setShade('');
      setNotes('');
      setBusy(false);
    }
  }, [expanded]);

  const askArch = row.arch_match === 'single';
  const archForLine: 'upper' | 'lower' | 'both' | null =
    row.arch_match === 'both' ? 'both' : askArch ? arch : null;

  const canAdd =
    (cartId != null || onStage != null) && qty >= 1 && (!askArch || arch !== null);

  const submit = async () => {
    if (!canAdd) return;
    const opts: CatalogueAddOptions = {
      arch: archForLine,
      shade: shade.trim() || null,
      notes: notes.trim() || null,
    };
    if (onStage) {
      onStage(row, qty, opts);
      onAdded();
      return;
    }
    if (!cartId) return;
    setBusy(true);
    try {
      await addCatalogueItemsToCart(cartId, row, qty, opts);
      onAdded();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not add item');
    } finally {
      setBusy(false);
    }
  };

  const lineTotal = totalForQty(row, qty);

  return (
    <article
      style={{
        borderRadius: theme.radius.card,
        border: `1px solid ${expanded ? theme.color.ink : theme.color.border}`,
        background: theme.color.surface,
        overflow: 'hidden',
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      <button
        type="button"
        id={headerId}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        style={{
          appearance: 'none',
          width: '100%',
          textAlign: 'left',
          background: 'transparent',
          border: 'none',
          padding: theme.space[3],
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        <Thumb src={row.image_url} alt={row.name} />
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
            {row.name}
          </p>
          {row.description ? (
            <p
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {row.description}
            </p>
          ) : null}
        </div>
        <span
          style={{
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          £{row.unit_price.toFixed(2)}
        </span>
        <ChevronDown
          size={18}
          color={theme.color.inkSubtle}
          aria-hidden
          style={{
            flexShrink: 0,
            transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </button>

      {/* Animated panel — the grid-template-rows trick lets the
          height transition smoothly without JS measurement. */}
      <div
        id={panelId}
        role="region"
        aria-labelledby={headerId}
        style={{
          display: 'grid',
          gridTemplateRows: expanded ? '1fr' : '0fr',
          transition: `grid-template-rows ${theme.motion.duration.base}ms ${theme.motion.easing.spring}`,
        }}
      >
        <div style={{ overflow: 'hidden' }}>
          <div
            style={{
              padding: `0 ${theme.space[3]}px ${theme.space[3]}px`,
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[4],
            }}
          >
            <div style={{ height: 1, background: theme.color.border }} />

            <Stepper
              label={row.unit_label ? `Quantity (${row.unit_label})` : 'Quantity'}
              value={qty}
              onChange={setQty}
            />

            {askArch ? (
              <FieldBlock label="Arch" required>
                <div style={{ display: 'flex', gap: theme.space[2] }}>
                  <ArchPick value="upper" current={arch} onClick={() => setArch('upper')} />
                  <ArchPick value="lower" current={arch} onClick={() => setArch('lower')} />
                </div>
              </FieldBlock>
            ) : null}

            <FieldBlock label="Shade" optional>
              <PlainInput
                value={shade}
                onChange={setShade}
                placeholder="e.g. A2"
              />
            </FieldBlock>

            <FieldBlock label="Notes" optional>
              <PlainInput
                value={notes}
                onChange={setNotes}
                placeholder="e.g. matched to upper canine"
              />
            </FieldBlock>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: theme.space[3],
                paddingTop: theme.space[2],
                borderTop: `1px solid ${theme.color.border}`,
              }}
            >
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                  Line total
                </span>
                <span
                  style={{
                    fontSize: theme.type.size.lg,
                    fontWeight: theme.type.weight.semibold,
                    fontVariantNumeric: 'tabular-nums',
                    color: theme.color.ink,
                  }}
                >
                  £{lineTotal.toFixed(2)}
                </span>
              </span>
              <Button
                variant="primary"
                onClick={submit}
                disabled={!canAdd || busy}
                loading={busy}
                showArrow={!busy}
              >
                Add to bag
              </Button>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Field block — wraps a row of options with a small muted label.
// ─────────────────────────────────────────────────────────────────────────────

function FieldBlock({
  label,
  required = false,
  optional = false,
  children,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.inkMuted,
          letterSpacing: theme.type.tracking.wide,
          textTransform: 'uppercase',
        }}
      >
        {label}
        {required ? (
          <span style={{ color: theme.color.alert, marginLeft: 4 }}>*</span>
        ) : optional ? (
          <span
            style={{
              color: theme.color.inkSubtle,
              fontWeight: theme.type.weight.medium,
              textTransform: 'none',
              letterSpacing: 0,
              marginLeft: 6,
            }}
          >
            optional
          </span>
        ) : null}
      </p>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stepper — minus / count / plus, tabular-nums.
// ─────────────────────────────────────────────────────────────────────────────

function Stepper({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <FieldBlock label={label}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
        <StepperButton aria="Decrease" onClick={() => onChange(Math.max(1, value - 1))}>
          <Minus size={16} />
        </StepperButton>
        <span
          style={{
            minWidth: 32,
            textAlign: 'center',
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value}
        </span>
        <StepperButton aria="Increase" onClick={() => onChange(value + 1)}>
          <Plus size={16} />
        </StepperButton>
      </div>
    </FieldBlock>
  );
}

function StepperButton({
  aria,
  children,
  onClick,
}: {
  aria: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={aria}
      onClick={onClick}
      style={{
        appearance: 'none',
        width: 36,
        height: 36,
        borderRadius: theme.radius.pill,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        color: theme.color.ink,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

function ArchPick({
  value,
  current,
  onClick,
}: {
  value: 'upper' | 'lower';
  current: 'upper' | 'lower' | null;
  onClick: () => void;
}) {
  const selected = current === value;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        flex: 1,
        height: 44,
        borderRadius: theme.radius.input,
        background: selected ? theme.color.ink : theme.color.surface,
        color: selected ? theme.color.surface : theme.color.ink,
        border: selected ? 'none' : `1px solid ${theme.color.border}`,
        fontFamily: 'inherit',
        fontSize: theme.type.size.base,
        fontWeight: selected ? theme.type.weight.semibold : theme.type.weight.medium,
        cursor: 'pointer',
        textTransform: 'capitalize',
      }}
    >
      {value}
    </button>
  );
}

function PlainInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  return (
    <input
      ref={ref}
      type="text"
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      placeholder={placeholder}
      style={{
        appearance: 'none',
        height: 44,
        padding: `0 ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        border: `1px solid ${focused ? theme.color.ink : theme.color.border}`,
        outline: 'none',
        fontFamily: 'inherit',
        fontSize: theme.type.size.base,
        color: theme.color.ink,
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Thumb — square thumbnail with rounded clip + subtle border. Falls back
// to a Package glyph on a tinted background when the catalogue row has
// no image_url. Local to this file so the picker stays self-contained.
// ─────────────────────────────────────────────────────────────────────────────

function Thumb({ src, alt, size = 48 }: { src: string | null; alt: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: 10,
        overflow: 'hidden',
        background: src ? theme.color.surface : 'rgba(14, 20, 20, 0.04)',
        border: `1px solid ${theme.color.border}`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: theme.color.inkSubtle,
      }}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={(e) => {
            (e.currentTarget as HTMLElement).style.display = 'none';
          }}
        />
      ) : (
        <Package size={Math.round(size * 0.4)} />
      )}
    </span>
  );
}

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: theme.space[2],
};

// ─────────────────────────────────────────────────────────────────────────────
// Criteria-from-appointment helper — unchanged from the previous
// version. Maps an appointment's intake answers + Calendly event type
// to MatchCriteria for the catalogue match function.
// ─────────────────────────────────────────────────────────────────────────────

export function criteriaFromAppointment(
  intake: IntakeAnswer[] | null,
  eventTypeLabel: string | null
): MatchCriteria {
  const filtered = filterCareIntake(intake);
  const service_type = inferServiceType(eventTypeLabel);

  const repairAns = filtered.find((a) =>
    /\brepair[\s_]*type\b/i.test(a.question ?? '')
  );
  const repair_variant = repairAns?.answer.split(/\r?\n+/)[0]?.trim() || null;

  const subjectAns = filtered.find((a) =>
    /\b(appliance|product|service|treatment)\b/i.test(a.question ?? '')
  );
  const product_key = subjectAns ? normaliseProductKey(subjectAns.answer) : null;

  const archAns = filtered.find((a) =>
    /\b(arch|jaw|upper\s*or\s*lower|top\s*or\s*bottom)\b/i.test(a.question ?? '')
  );
  const archLabel = archAns ? archToAnatomy(archAns.answer) : undefined;
  const arch =
    archLabel === 'Upper'
      ? 'upper'
      : archLabel === 'Lower'
        ? 'lower'
        : archLabel === 'Upper and Lower'
          ? 'both'
          : null;

  return { service_type, product_key, repair_variant, arch };
}

function inferServiceType(label: string | null): string | null {
  if (!label) return null;
  const l = label.toLowerCase();
  if (/denture\s+repair|repair/i.test(l)) return 'denture_repair';
  if (/click[\s-]?in\s+veneer|veneer/i.test(l)) return 'click_in_veneers';
  if (/same[\s-]?day\s+appliance|appliance|impression|aligner|retainer|guard|whitening/i.test(l))
    return 'same_day_appliance';
  return null;
}

function normaliseProductKey(answer: string): string | null {
  const a = answer.split(/\r?\n+/)[0]?.toLowerCase().trim() ?? '';
  if (!a) return null;
  if (/retainer/.test(a)) return 'retainer';
  if (/aligner/.test(a)) return 'aligner';
  if (/night[\s-]?guard/.test(a)) return 'night_guard';
  if (/day[\s-]?guard/.test(a)) return 'day_guard';
  if (/whitening\s*kit/.test(a)) return 'whitening_kit';
  if (/whitening/.test(a)) return 'whitening_tray';
  if (/missing\s*tooth/.test(a)) return 'missing_tooth';
  if (/click[\s-]?in\s*veneer|veneer/.test(a)) return 'click_in_veneers';
  return null;
}
