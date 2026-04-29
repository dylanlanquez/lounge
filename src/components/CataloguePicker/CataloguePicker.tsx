import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Minus, Package, Plus, Search, ShoppingBag, Sparkles, X } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Checkbox } from '../Checkbox/Checkbox.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { Toast } from '../Toast/Toast.tsx';
import { theme } from '../../theme/index.ts';
import {
  type CatalogueRow,
  useCatalogueActive,
} from '../../lib/queries/catalogue.ts';
import {
  findMatches,
  type MatchCriteria,
  totalForQtyWithArch,
} from '../../lib/catalogueMatch.ts';
import {
  type IntakeAnswer,
  archToAnatomy,
  filterCareIntake,
} from '../../lib/queries/appointments.ts';
import {
  addCatalogueItemsToCart,
  type AppliedUpgrade,
  type CatalogueAddOptions,
} from '../../lib/queries/carts.ts';
import {
  useAllUpgradeLinks,
  useUpgradesActive,
  type UpgradeLinkRow,
  type UpgradeRow,
} from '../../lib/queries/upgrades.ts';

// ─────────────────────────────────────────────────────────────────────────────
// CataloguePicker — a single-screen accordion modal.
//
// Each catalogue row renders as a collapsed tile (thumbnail + name +
// price + caret). Tapping the tile expands it inline to reveal the
// per-line options (qty + arch + shade + upgrades) and an "Add to bag"
// action. Form-less rows (no arch, no shade, no upgrades) skip the
// dropdown entirely and add to the bag straight from the header tap.
// Only one row is expanded at a time; tapping another collapses the
// previous and opens the new one. After adding, the row collapses and
// the receptionist can pick another product without bouncing between
// screens. Per-line notes don't live here — the page-level staff
// notes textarea is the single source for technician guidance, which
// flows onto the LWO.
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
  const { rows: upgrades } = useUpgradesActive();
  const { links: upgradeLinks } = useAllUpgradeLinks();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string } | null>(null);

  // Upgrade lookup by id — small map keeps ProductRow render cheap.
  const upgradeById = useMemo(() => {
    const m = new Map<string, UpgradeRow>();
    for (const u of upgrades) m.set(u.id, u);
    return m;
  }, [upgrades]);

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

  // Top-level grouping: Services on top, Products underneath, driven by
  // the lwo_catalogue.is_service flag. Bootstrap migration 03 backfills
  // the flag for existing denture-repair and impression rows so the
  // grouping continues to look right on first paint.
  const { servicesGrouped, productsGrouped } = useMemo(() => {
    const services: CatalogueRow[] = [];
    const products: CatalogueRow[] = [];
    for (const r of filtered) {
      if (r.is_service) {
        services.push(r);
      } else {
        products.push(r);
      }
    }
    return {
      servicesGrouped: groupByCategory(services),
      productsGrouped: groupByCategory(products),
    };
  }, [filtered]);

  const handleAdded = () => {
    setExpandedKey(null);
    setToast({ tone: 'success', title: 'Added to bag' });
    onItemAdded();
    // Slide the picker away after a successful add. The toast lives
    // outside the BottomSheet portal so it stays on screen as the
    // sheet slides down. If the receptionist needs another item, the
    // parent page surfaces an "Add another" affordance next to the
    // staged items.
    onClose();
  };

  const renderRow = (row: CatalogueRow) => {
    // Resolve the upgrade options applicable to this row by joining the
    // global links list against the upgrades registry. Keeps the
    // ProductRow itself focused on rendering — it doesn't talk to
    // Supabase directly.
    const linksForRow = upgradeLinks.filter((l) => l.catalogue_id === row.id);
    const rowUpgrades = linksForRow
      .map((l) => {
        const u = upgradeById.get(l.upgrade_id);
        return u && u.active ? { upgrade: u, link: l } : null;
      })
      .filter((x): x is { upgrade: UpgradeRow; link: UpgradeLinkRow } => x !== null)
      .sort((a, b) => a.upgrade.sort_order - b.upgrade.sort_order);
    return (
      <li key={row.id}>
        <ProductRow
          row={row}
          rowUpgrades={rowUpgrades}
          expanded={expandedKey === row.id}
          onToggle={() => setExpandedKey(expandedKey === row.id ? null : row.id)}
          cartId={cartId ?? null}
          onStage={onStage}
          onAdded={handleAdded}
          onError={(msg) => setToast({ tone: 'error', title: msg })}
        />
      </li>
    );
  };

  return (
    <>
      <BottomSheet
        open={open}
        onClose={onClose}
        title="Choose product or service"
        description={
          trimmedSearch
            ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'}`
            : 'Tap a product or service to set arch, shade and quantity, then add it to the bag.'
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
            <ul className="lng-picker-list" style={listStyle}>{filtered.map(renderRow)}</ul>
          ) : (
            <>
              {suggestions.length > 0 ? (
                <Section title="Suggested for this booking" accent>
                  <ul className="lng-picker-list" style={listStyle}>{suggestions.map(renderRow)}</ul>
                </Section>
              ) : null}
              {servicesGrouped.length > 0 ? (
                <TopGroup title="Services">
                  {/* One flat <ul> per TopGroup so :last-child matches
                      only the actually-last row in the group. Splitting
                      by category would mark the last row of every
                      category as :last-child, dropping its borderBottom
                      and producing visible "gaps" between categories
                      (no line between Relining and Impression, etc). */}
                  <ul className="lng-picker-list" style={listStyle}>
                    {servicesGrouped.flatMap(([, rows]) => rows).map(renderRow)}
                  </ul>
                </TopGroup>
              ) : null}
              {servicesGrouped.length > 0 && productsGrouped.length > 0 ? (
                <hr
                  style={{
                    margin: 0,
                    border: 'none',
                    borderTop: `1px solid ${theme.color.border}`,
                  }}
                />
              ) : null}
              {productsGrouped.length > 0 ? (
                <TopGroup title="Products">
                  <ul className="lng-picker-list" style={listStyle}>
                    {productsGrouped.flatMap(([, rows]) => rows).map(renderRow)}
                  </ul>
                </TopGroup>
              ) : null}
            </>
          )}
        </div>
      </BottomSheet>

      {toast ? (
        <div
          style={{
            position: 'fixed',
            // 7.5px gap above the bottom footer. Footer height is 96px
            // (Arrival's ActionBar; matches BottomNav's chrome on
            // routes that show it). 96 + 7.5 = 103.5 below the safe-
            // area-aware footer, anchored from the viewport bottom.
            bottom: `calc(env(safe-area-inset-bottom, 0px) + 103.5px)`,
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

      {/* Hairline + hover rules for ProductRow. Inline-style props
          can't express :last-child or :hover, so we inject the
          minimal CSS once at the picker root. Inert when the picker
          is closed because the rows aren't in the DOM. The borderBottom
          is set here (not inline on the article) so the
          li:last-child override actually wins — inline styles outrank
          a CSS :last-child rule, which would leave a doubled hairline
          right above the Services / Products <hr>. */}
      <style>{`
        .lng-picker-list > li:not(:last-child) > .lng-product-row { border-bottom: 1px solid ${theme.color.border}; }
        .lng-product-row:not(.lng-product-row--expanded):hover { background: rgba(14, 20, 20, 0.025); }
      `}</style>
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

// Pure helper — reused for both top-level buckets so a category that
// straddles services and products doesn't accidentally collapse into
// one list.
function groupByCategory(rows: CatalogueRow[]): [string, CatalogueRow[]][] {
  const map = new Map<string, CatalogueRow[]>();
  for (const r of rows) {
    const list = map.get(r.category) ?? [];
    list.push(r);
    map.set(r.category, list);
  }
  return [...map.entries()];
}

// Top-level "Services" / "Products" container. Larger eyebrow heading
// than the inner category Section so the two layers of grouping read
// as distinct.
function TopGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
      <h2
        style={{
          margin: 0,
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

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
// Body (visible when expanded): qty + arch + shade + upgrades + Add CTA.
// CSS Grid trick: grid-template-rows transitions from 0fr → 1fr to give
// a smooth height animation without measuring DOM. Inner div has
// overflow: hidden so the content clips during the transition.
// ─────────────────────────────────────────────────────────────────────────────

// Click-in veneers picker shade options. Restricted set per Dylan's
// build brief — anything else just hides the field. If the clinic
// adds new shades later, extend this list (or move it to lng_settings).
const CLICK_IN_VENEER_SHADES = ['BL1', 'A1', 'A2'] as const;

function ProductRow({
  row,
  rowUpgrades,
  expanded,
  onToggle,
  cartId,
  onStage,
  onAdded,
  onError,
}: {
  row: CatalogueRow;
  rowUpgrades: { upgrade: UpgradeRow; link: UpgradeLinkRow }[];
  expanded: boolean;
  onToggle: () => void;
  cartId: string | null;
  onStage?: (row: CatalogueRow, qty: number, options: CatalogueAddOptions) => void;
  onAdded: () => void;
  onError: (msg: string) => void;
}) {
  const headerId = `picker-row-header-${row.id}`;
  const panelId = `picker-row-panel-${row.id}`;
  const articleRef = useRef<HTMLElement | null>(null);

  const [qty, setQty] = useState(1);
  const [arch, setArch] = useState<'upper' | 'lower' | 'both' | null>(null);
  const [shade, setShade] = useState('');
  const [selectedUpgradeIds, setSelectedUpgradeIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  // Reset the per-line form whenever the row collapses so the next
  // expansion starts clean.
  useEffect(() => {
    if (!expanded) {
      setQty(1);
      setArch(null);
      setShade('');
      setSelectedUpgradeIds(new Set());
      setBusy(false);
    }
  }, [expanded]);

  // When a row expands, scroll it into the centre of the BottomSheet's
  // scroll viewport. Without this, opening a card near the bottom of
  // the list leaves the form below the fold and the user has to chase
  // the content. We wait one frame so the panel's grid-rows transition
  // has begun expanding before we measure — otherwise scrollIntoView
  // targets the still-collapsed (zero-height) bounding box and lands
  // short.
  useEffect(() => {
    if (!expanded) return;
    const el = articleRef.current;
    if (!el) return;
    const id = window.requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => window.cancelAnimationFrame(id);
  }, [expanded]);

  // arch_match='single' means the receptionist is picking the arch.
  // 'both' on a row means it's preset (legacy duplicate row); the
  // picker shows it as a fixed both-arches selection. 'any' is non-arch.
  const askArch = row.arch_match === 'single';
  const hasBothArchesPrice = row.both_arches_price != null;
  const archForLine: 'upper' | 'lower' | 'both' | null =
    row.arch_match === 'both' ? 'both' : askArch ? arch : null;
  const isBothArches = archForLine === 'both';

  // Shade is a constrained dropdown, only on click-in veneers. Other
  // products don't expose a shade field at all per Dylan's spec.
  const showShade = row.service_type === 'click_in_veneers';

  // Upgrades — resolve each selected upgrade to its arch-tier price so
  // the displayed total and the staged options carry the same numbers
  // the cart will eventually persist.
  const appliedUpgrades: AppliedUpgrade[] = useMemo(() => {
    const list: AppliedUpgrade[] = [];
    for (const { upgrade, link } of rowUpgrades) {
      if (!selectedUpgradeIds.has(upgrade.id)) continue;
      const pricePounds =
        isBothArches && link.both_arches_price != null
          ? link.both_arches_price
          : link.price;
      list.push({
        upgrade_id: upgrade.id,
        code: upgrade.code,
        name: upgrade.name,
        price_pence: Math.round(pricePounds * 100),
      });
    }
    return list;
  }, [rowUpgrades, selectedUpgradeIds, isBothArches]);

  // Per-instance upgrade cost in pounds. Upgrades ride every quantity
  // tick (matches the cart write — one upgrade snapshot per cart_item),
  // so 2× a Scalloped retainer charges Scalloped twice.
  const upgradePerInstance = appliedUpgrades.reduce((sum, u) => sum + u.price_pence, 0) / 100;

  const baseLineTotal = totalForQtyWithArch(row, qty, archForLine);
  const lineTotal = baseLineTotal + upgradePerInstance * qty;

  // Header price hint: row's lowest possible per-instance price. Lets
  // the receptionist see "From £X" for arch-priced rows without
  // expanding the row first.
  const minHeaderPrice =
    askArch && hasBothArchesPrice
      ? Math.min(row.unit_price, row.both_arches_price ?? row.unit_price)
      : row.arch_match === 'both' && row.both_arches_price != null
        ? row.both_arches_price
        : row.unit_price;
  const showFromPrefix = askArch && hasBothArchesPrice && row.unit_price !== row.both_arches_price;

  const canAdd =
    (cartId != null || onStage != null) &&
    qty >= 1 &&
    (!askArch || arch !== null) &&
    (!showShade || shade.trim() !== '');

  // Form-less rows have nothing to configure: no arch pick, no shade
  // pick, no upgrades, and quantity_enabled=false on the row so the
  // Quantity stepper is hidden too. Tapping the header adds them
  // straight to the bag. Schema-driven via the explicit
  // quantity_enabled flag (admin-controlled), not inferred from
  // unit_label.
  const isFormless =
    !askArch && !showShade && rowUpgrades.length === 0 && !row.quantity_enabled;

  const submit = async () => {
    if (!canAdd) return;
    const opts: CatalogueAddOptions = {
      arch: archForLine,
      shade: showShade ? shade.trim() || null : null,
      notes: null,
      upgrades: appliedUpgrades,
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

  const toggleUpgrade = (upgradeId: string) => {
    setSelectedUpgradeIds((prev) => {
      const next = new Set(prev);
      if (next.has(upgradeId)) next.delete(upgradeId);
      else next.add(upgradeId);
      return next;
    });
  };

  const handleHeaderClick = () => {
    if (busy) return;
    if (isFormless) {
      void submit();
      return;
    }
    onToggle();
  };

  return (
    <article
      ref={articleRef}
      className={
        expanded
          ? 'lng-product-row lng-product-row--expanded'
          : 'lng-product-row'
      }
      style={{
        // borderBottom is set in CSS, not inline — inline styles
        // outrank a CSS :last-child override, which would leave a
        // doubled hairline next to the Services / Products <hr>.
        background: expanded ? theme.color.bg : 'transparent',
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        // overflow:hidden keeps the grid-rows expansion animation from
        // bleeding outside the row before the panel settles.
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        id={headerId}
        aria-expanded={isFormless ? undefined : expanded}
        aria-controls={isFormless ? undefined : panelId}
        onClick={handleHeaderClick}
        style={{
          appearance: 'none',
          width: '100%',
          textAlign: 'left',
          background: 'transparent',
          border: 'none',
          padding: theme.space[4],
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[4],
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
          {showFromPrefix ? 'From ' : ''}£{minHeaderPrice.toFixed(2)}
        </span>
        <RowActionBox
          isFormless={isFormless}
          expanded={expanded}
          busy={busy}
        />
      </button>

      {/* Animated panel — grid-template-rows transition. */}
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
              padding: `0 ${theme.space[4]}px ${theme.space[3]}px`,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {row.quantity_enabled ? (
              <ConfigRow label={row.unit_label ? `Quantity (${row.unit_label})` : 'Quantity'}>
                <CompactStepper value={qty} onChange={setQty} />
              </ConfigRow>
            ) : null}

            {askArch ? (
              <ConfigRow label="Arch" required>
                <Segmented
                  value={arch}
                  onChange={setArch}
                  options={
                    hasBothArchesPrice
                      ? [
                          { value: 'upper', label: 'Upper' },
                          { value: 'lower', label: 'Lower' },
                          { value: 'both', label: 'Both' },
                        ]
                      : [
                          { value: 'upper', label: 'Upper' },
                          { value: 'lower', label: 'Lower' },
                        ]
                  }
                />
              </ConfigRow>
            ) : null}

            {showShade ? (
              <ConfigRow label="Shade" required>
                <Segmented
                  value={shade}
                  onChange={setShade}
                  options={CLICK_IN_VENEER_SHADES.map((s) => ({ value: s, label: s }))}
                />
              </ConfigRow>
            ) : null}

            {rowUpgrades.length > 0 ? (
              <ConfigRow label="Upgrades" hint="optional" stack>
                <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
                  {rowUpgrades.map(({ upgrade, link }) => {
                    const checked = selectedUpgradeIds.has(upgrade.id);
                    const tierPrice =
                      isBothArches && link.both_arches_price != null
                        ? link.both_arches_price
                        : link.price;
                    return (
                      <label
                        key={upgrade.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: theme.space[3],
                          padding: `${theme.space[2]}px ${theme.space[2]}px`,
                          borderRadius: theme.radius.input,
                          background: checked ? theme.color.accentBg : 'transparent',
                          cursor: 'pointer',
                          transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
                        }}
                      >
                        <Checkbox
                          checked={checked}
                          onChange={() => toggleUpgrade(upgrade.id)}
                          ariaLabel={upgrade.name}
                        />
                        <span
                          style={{
                            flex: 1,
                            fontSize: theme.type.size.base,
                            fontWeight: theme.type.weight.medium,
                            color: theme.color.ink,
                          }}
                        >
                          {upgrade.name}
                        </span>
                        <span
                          style={{
                            fontSize: theme.type.size.sm,
                            color: theme.color.inkMuted,
                            fontVariantNumeric: 'tabular-nums',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          +£{tierPrice.toFixed(2)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </ConfigRow>
            ) : null}

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: theme.space[3],
                marginTop: theme.space[3],
                paddingTop: theme.space[3],
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
// ConfigRow — `label-left | control-right` row used inside the
// expansion panel. Replaces the FieldBlock pattern (uppercase tracked
// eyebrow + content stacked below) with a single-line layout that
// matches Linear / Stripe / Notion configurators. Hairline below
// every row except the last.
// ─────────────────────────────────────────────────────────────────────────────

function ConfigRow({
  label,
  required = false,
  hint,
  stack = false,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  // When the control is taller than a single row (e.g. the upgrades
  // checkbox list), stack the label above instead of side-by-side.
  stack?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: stack ? 'column' : 'row',
        alignItems: stack ? 'stretch' : 'center',
        justifyContent: stack ? 'flex-start' : 'space-between',
        gap: stack ? theme.space[2] : theme.space[3],
        padding: `${theme.space[3]}px 0`,
        borderBottom: `1px solid ${theme.color.border}`,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[2],
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.medium,
          color: theme.color.inkMuted,
        }}
      >
        <span>{label}</span>
        {required ? (
          <span aria-hidden style={{ color: theme.color.alert, fontWeight: theme.type.weight.semibold }}>
            *
          </span>
        ) : null}
        {hint ? (
          <span style={{ color: theme.color.inkSubtle, fontWeight: theme.type.weight.regular, fontSize: theme.type.size.xs }}>
            {hint}
          </span>
        ) : null}
      </span>
      <div style={{ display: stack ? 'block' : 'flex', alignItems: 'center', minWidth: 0 }}>
        {children}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Segmented — single rounded container, internal pill segments,
// selected segment fills ink. Used for arch + shade pickers in the
// product expansion panel.
// ─────────────────────────────────────────────────────────────────────────────

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T | null | '';
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <div
      role="radiogroup"
      style={{
        display: 'inline-flex',
        padding: 2,
        borderRadius: theme.radius.pill,
        background: theme.color.bg,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            style={{
              appearance: 'none',
              border: 'none',
              padding: `${theme.space[2]}px ${theme.space[4]}px`,
              borderRadius: theme.radius.pill,
              background: selected ? theme.color.ink : 'transparent',
              color: selected ? theme.color.surface : theme.color.ink,
              fontFamily: 'inherit',
              fontSize: theme.type.size.sm,
              fontWeight: selected ? theme.type.weight.semibold : theme.type.weight.medium,
              cursor: 'pointer',
              transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
              minWidth: 56,
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CompactStepper — tighter than the FieldBlock'd Stepper above; lives
// on a single row next to its label.
// ─────────────────────────────────────────────────────────────────────────────

function CompactStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const button: CSSProperties = {
    appearance: 'none',
    width: 32,
    height: 32,
    borderRadius: theme.radius.pill,
    border: `1px solid ${theme.color.border}`,
    background: theme.color.surface,
    color: theme.color.ink,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'inherit',
  };
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
      <button
        type="button"
        aria-label="Decrease"
        onClick={() => onChange(Math.max(1, value - 1))}
        style={button}
      >
        <Minus size={14} />
      </button>
      <span
        style={{
          minWidth: 28,
          textAlign: 'center',
          fontSize: theme.type.size.base,
          fontWeight: theme.type.weight.semibold,
          fontVariantNumeric: 'tabular-nums',
          color: theme.color.ink,
        }}
      >
        {value}
      </span>
      <button
        type="button"
        aria-label="Increase"
        onClick={() => onChange(value + 1)}
        style={button}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RowActionBox — the small bordered icon at the end of every product
// row. Same chrome (36 square, 1px border, 10px radius) for both
// affordances; the icon and a tiny background tint signal which is
// which.
//
//   - Form-required (askArch / showShade / has upgrades / unit_label):
//     ChevronDown, neutral surface. Border tightens to ink + chevron
//     rotates 180° when the row is expanded.
//   - Form-less (Impression Appointment et al): ShoppingBag, accent
//     icon over a 5%-alpha accent wash. Just enough warmth to read
//     as "this is the action", no shouting.
//
// Renders as a <span> rather than a <button> — the parent row header
// is already a button, and nesting buttons is invalid HTML. The whole
// row is the click target; this is purely the visual cue.
// ─────────────────────────────────────────────────────────────────────────────

function RowActionBox({
  isFormless,
  expanded,
  busy,
}: {
  isFormless: boolean;
  expanded: boolean;
  busy: boolean;
}) {
  const tightBorder = expanded && !isFormless;
  return (
    <span
      aria-hidden
      style={{
        width: 36,
        height: 36,
        borderRadius: 10,
        border: `1px solid ${tightBorder ? theme.color.ink : theme.color.border}`,
        background: isFormless ? 'rgba(31, 77, 58, 0.05)' : theme.color.surface,
        color: isFormless ? theme.color.accent : theme.color.inkSubtle,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        opacity: busy ? 0.6 : 1,
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      {isFormless ? (
        <ShoppingBag size={18} aria-hidden />
      ) : (
        <ChevronDown
          size={18}
          aria-hidden
          style={{
            transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      )}
    </span>
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
  // No gap — rows sit flush and use the per-row borderBottom (with
  // a :last-child override in the global <style>) for the hairline
  // dividers between them. Cleaner read than stacked bordered cards.
  gap: 0,
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
