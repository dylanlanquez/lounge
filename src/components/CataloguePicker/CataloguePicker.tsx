import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { totalForQtyWithArch } from '../../lib/catalogueMatch.ts';
import {
  addCatalogueItemsToCart,
  formatPounds,
  type AppliedUpgrade,
  type CatalogueAddOptions,
} from '../../lib/queries/carts.ts';
import {
  useAllActiveUpgrades,
  type UpgradeRow,
} from '../../lib/queries/upgrades.ts';
import {
  resolveCartSuggestions,
  useAllSuggestions,
} from '../../lib/queries/suggestions.ts';

// Vertical travel for the close-button slide. Same value applied
// in opposite signs to the rest-state and inline X so they appear
// to be one element gliding from the popup's top-right down into
// the sticky search row (and back up). Picked to read as a real
// motion without being so far that the user tracks two distinct
// objects.
const CLOSE_SLIDE_DISTANCE = 28;

// Shared base style for the picker's two close buttons (rest-state
// in the title block, scrolled-state inline with the search). Width
// and height are fixed at 44 to hit the iOS HIG minimum tap target;
// the inline button overrides width to 0 when collapsed so the
// search field can claim the full row.
const CLOSE_BUTTON_BASE: CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  color: theme.color.ink,
  cursor: 'pointer',
  height: 44,
  width: 44,
  borderRadius: theme.radius.pill,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  WebkitTapHighlightColor: 'transparent',
  padding: 0,
};

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
  // Catalogue ids already in the basket (cart lines on the visit page,
  // staged items in the arrival wizard). Drives the "Suggested for this
  // booking" carousel: companions configured against these items, or
  // every active row when the basket is empty.
  cartCatalogueIds: string[];
  onItemAdded: () => void;
  // Restrict the picker to products only (is_service=false), hiding the
  // Services group entirely. Used by Quick Sale, which is retail-only.
  // Suggestions are already products-only, so the carousel is unaffected.
  productsOnly?: boolean;
}

export function CataloguePicker({
  open,
  onClose,
  cartId,
  onStage,
  cartCatalogueIds,
  onItemAdded,
  productsOnly = false,
}: CataloguePickerProps) {
  const { rows, loading, error } = useCatalogueActive();
  const { rows: upgrades } = useAllActiveUpgrades();
  const { rows: suggestionRules } = useAllSuggestions();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // The suggestion carousel's open configurator. Tracked separately
  // from `expandedKey` (the main accordion list) so the two never
  // collide on a shared catalogue id: tapping a suggested card opens
  // ONLY its own configurator, never the duplicate row in the list
  // below, and never triggers that row's scroll-into-view.
  const [activeSuggestedId, setActiveSuggestedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string } | null>(null);

  // Sticky-header plumbing. When the sheet's scroll moves the title
  // block out of view, we want a subtle hairline under the sticky
  // search to communicate the collapsed state — iOS's large-title
  // pattern in the Human Interface Guidelines. A 1px sentinel sits at
  // the top of the scroll content; when it leaves the viewport,
  // `stuck` flips on. Rooting the observer on the BottomSheet's
  // scroll container (not the document) is essential because the
  // sheet itself doesn't scroll the page.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!open) {
      setStuck(false);
      return;
    }
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setStuck(!entry.isIntersecting);
      },
      { root, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [open]);

  // Group active upgrades by their owning catalogue row so each
  // ProductRow can pull its list with one map lookup. Upgrades are
  // already sorted by sort_order from the query.
  const upgradesByCatalogue = useMemo(() => {
    const m = new Map<string, UpgradeRow[]>();
    for (const u of upgrades) {
      const list = m.get(u.catalogue_id) ?? [];
      list.push(u);
      m.set(u.catalogue_id, list);
    }
    return m;
  }, [upgrades]);

  // Cart-aware suggestions. With items in the basket, show the
  // companions an admin configured for those items (deduped, basket
  // items themselves excluded). With an empty basket, show every active
  // row so the carousel still gives the receptionist a fast way in.
  const suggestions = useMemo(
    () => resolveCartSuggestions(rows, suggestionRules, cartCatalogueIds),
    [rows, suggestionRules, cartCatalogueIds]
  );

  // Reset state when the sheet closes / re-opens. Without this the
  // previously-expanded row would still be open the next time the
  // receptionist opens the picker.
  useEffect(() => {
    if (!open) {
      setExpandedKey(null);
      setActiveSuggestedId(null);
      setSearch('');
    }
  }, [open]);

  // One configurator open at a time across the whole sheet. Opening a
  // main-list row closes the suggestion configurator; opening a
  // suggestion closes the main-list row.
  const toggleMainRow = useCallback((id: string) => {
    setActiveSuggestedId(null);
    setExpandedKey((cur) => (cur === id ? null : id));
  }, []);
  const selectSuggestion = useCallback((id: string | null) => {
    setExpandedKey(null);
    setActiveSuggestedId(id);
  }, []);

  // Filter rows by case-insensitive substring across name + description
  // + sku. Search overrides the suggested + grouped layout to a flat
  // list — when staff are searching they want results, not categories.
  const trimmedSearch = search.trim().toLowerCase();
  // Products-only callers (Quick Sale) never see services anywhere in
  // the sheet — scope the source rows up front so search, grouping and
  // counts all agree.
  const scopedRows = useMemo(
    () => (productsOnly ? rows.filter((r) => !r.is_service) : rows),
    [rows, productsOnly],
  );
  const filtered = useMemo(() => {
    if (!trimmedSearch) return scopedRows;
    return scopedRows.filter((r) => {
      const haystack = `${r.name} ${r.description ?? ''} ${r.code}`.toLowerCase();
      return haystack.includes(trimmedSearch);
    });
  }, [scopedRows, trimmedSearch]);

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
    // Each catalogue row owns its own upgrade rows now — one lookup,
    // already sorted, already filtered to active.
    const rowUpgrades = upgradesByCatalogue.get(row.id) ?? [];
    return (
      <li key={row.id}>
        <ProductRow
          row={row}
          rowUpgrades={rowUpgrades}
          expanded={expandedKey === row.id}
          onToggle={() => toggleMainRow(row.id)}
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
        bareContent
        hideHeader
        contentRef={scrollRef}
      >
        {/* Sentinel — a zero-height marker at the top of the scroll
            content. When it leaves the viewport (root = scrollRef),
            the sticky row has collapsed up against the sheet's drag
            handle and the hairline below it switches on. */}
        <div ref={sentinelRef} aria-hidden style={{ height: 1, marginBottom: -1 }} />

        {/* Large title block — scrolls away with the list, iOS HIG
            "large title" pattern. Top padding gives air beneath the
            drag handle now that BottomSheet's chrome header is
            suppressed (hideHeader). position: relative anchors the
            rest-state close button at the popup's top-right; that
            button cross-fades with the inline one in the sticky row
            as the user scrolls past the sentinel. */}
        <div
          style={{
            position: 'relative',
            padding: `${theme.space[5]}px ${theme.space[6]}px ${theme.space[4]}px`,
          }}
        >
          {/* Title text gets right padding to keep it clear of the
              floating close button so long titles don't run into it. */}
          <div style={{ paddingRight: 52 }}>
            <h2
              style={{
                margin: 0,
                fontSize: theme.type.size.xl,
                fontWeight: theme.type.weight.semibold,
                letterSpacing: theme.type.tracking.tight,
                color: theme.color.ink,
              }}
            >
              {productsOnly ? 'Choose a product' : 'Choose product or service'}
            </h2>
            <p
              style={{
                margin: `${theme.space[2]}px 0 0`,
                color: theme.color.inkMuted,
                fontSize: theme.type.size.base,
                lineHeight: 1.5,
              }}
            >
              {trimmedSearch
                ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'}`
                : productsOnly
                  ? 'Tap a product to set options and quantity, then add it to the bag.'
                  : 'Tap a product or service to set arch, shade and quantity, then add it to the bag.'}
            </p>
          </div>
          {/* Rest-state close button: lives in the title block's
              top-right corner. Right offset matches the inline X's
              horizontal position so the eye reads the two as the
              same element handing off. As the user scrolls past the
              sentinel, this X slides DOWN (translateY) and fades —
              while the inline X below slides DOWN into place from
              above. Both move together in the same direction so the
              motion reads as one X gliding into the search row,
              not two cross-fading. Reverses on scroll-back-up. */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            tabIndex={stuck ? -1 : 0}
            style={{
              ...CLOSE_BUTTON_BASE,
              position: 'absolute',
              top: theme.space[2],
              right: theme.space[6],
              opacity: stuck ? 0 : 1,
              transform: stuck ? `translateY(${CLOSE_SLIDE_DISTANCE}px)` : 'translateY(0)',
              pointerEvents: stuck ? 'none' : 'auto',
              transition: [
                `transform ${theme.motion.duration.slow}ms ${theme.motion.easing.spring}`,
                `opacity ${theme.motion.duration.base}ms ${theme.motion.easing.standard}`,
              ].join(', '),
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Sticky row: SearchField + a close button that grows from
            zero width to 44px once the title has scrolled away. At
            rest the search takes the row's full width; in the stuck
            state the X reveals on the right and the search shortens
            to compensate. Hairline below only appears in the stuck
            state — at rest there's nothing to separate the row
            from, and an always-on border reads as a stray rule. */}
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 2,
            background: theme.color.surface,
            padding: `${theme.space[2]}px ${theme.space[6]}px ${theme.space[3]}px`,
            boxShadow: stuck ? `inset 0 -1px 0 ${theme.color.border}` : 'none',
            transition: `box-shadow ${theme.motion.duration.base}ms ${theme.motion.easing.standard}`,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <SearchField value={search} onChange={setSearch} />
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              tabIndex={stuck ? 0 : -1}
              style={{
                ...CLOSE_BUTTON_BASE,
                width: stuck ? 44 : 0,
                marginLeft: stuck ? theme.space[2] : 0,
                opacity: stuck ? 1 : 0,
                // Slide DOWN into place from above when the row
                // collapses — same direction as the rest-state X's
                // exit, so the two reads as one continuous motion.
                transform: stuck ? 'translateY(0)' : `translateY(-${CLOSE_SLIDE_DISTANCE}px)`,
                pointerEvents: stuck ? 'auto' : 'none',
                overflow: 'hidden',
                transition: [
                  `transform ${theme.motion.duration.slow}ms ${theme.motion.easing.spring}`,
                  `width ${theme.motion.duration.base}ms ${theme.motion.easing.standard}`,
                  `margin-left ${theme.motion.duration.base}ms ${theme.motion.easing.standard}`,
                  `opacity ${theme.motion.duration.base}ms ${theme.motion.easing.standard}`,
                ].join(', '),
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* List content. Padding mirrors what BottomSheet's inner
            container used to apply (now zeroed via bareContent),
            with a slightly tighter top so the search-to-list rhythm
            doesn't double the gap. */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[5],
            padding: `${theme.space[3]}px ${theme.space[6]}px ${theme.space[6]}px`,
          }}
        >
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
                <SuggestionSection
                  rows={suggestions}
                  upgradesByCatalogue={upgradesByCatalogue}
                  activeId={activeSuggestedId}
                  onSelect={selectSuggestion}
                  cartId={cartId ?? null}
                  onStage={onStage}
                  onAdded={handleAdded}
                  onError={(msg) => setToast({ tone: 'error', title: msg })}
                />
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
        /* Suggestion carousel: hide the scrollbar (swipe / trackpad only)
           and give the cards a calm press response. */
        .lng-sug-scroll { scrollbar-width: none; -ms-overflow-style: none; }
        .lng-sug-scroll::-webkit-scrollbar { display: none; }
        .lng-sug-card { transition:
          transform ${theme.motion.duration.fast}ms ${theme.motion.easing.spring},
          box-shadow ${theme.motion.duration.base}ms ${theme.motion.easing.standard},
          border-color ${theme.motion.duration.base}ms ${theme.motion.easing.standard}; }
        .lng-sug-card:active { transform: scale(0.975); }
        @media (hover: hover) {
          .lng-sug-card:not(.lng-sug-card--active):hover { border-color: rgba(14, 20, 20, 0.16); }
        }
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared line helpers — used by the accordion rows, the suggestion
// cards, and the suggestion configurator so the "add to bag" semantics
// stay identical everywhere.
// ─────────────────────────────────────────────────────────────────────────────

// Click-in veneers picker shade options. Restricted set per Dylan's
// build brief — anything else just hides the field. If the clinic
// adds new shades later, extend this list (or move it to lng_settings).
const CLICK_IN_VENEER_SHADES = ['BL1', 'A1', 'A2'] as const;

const FORMLESS_OPTIONS: CatalogueAddOptions = {
  arch: null,
  shade: null,
  notes: null,
  upgrades: [],
};

// Where a line commits to: stage it (arrival wizard, no cart yet) or
// write it straight to the open cart (visit page).
interface LineCommitCtx {
  cartId: string | null;
  onStage?: (row: CatalogueRow, qty: number, options: CatalogueAddOptions) => void;
}

async function commitLine(
  row: CatalogueRow,
  qty: number,
  options: CatalogueAddOptions,
  ctx: LineCommitCtx
): Promise<void> {
  if (ctx.onStage) {
    ctx.onStage(row, qty, options);
    return;
  }
  if (!ctx.cartId) throw new Error('No cart to add to');
  await addCatalogueItemsToCart(ctx.cartId, row, qty, options);
}

// A row with nothing to configure (no arch question, no shade, no
// upgrades, qty stepper disabled) adds straight to the bag on a single
// tap — no expansion, no configurator.
function isFormlessRow(row: CatalogueRow, rowUpgrades: UpgradeRow[]): boolean {
  const askArch = row.arch_match === 'single';
  const showShade = row.service_type === 'click_in_veneers';
  return !askArch && !showShade && rowUpgrades.length === 0 && !row.quantity_enabled;
}

// Lowest per-instance price for a row + whether it needs a "From "
// prefix (arch-priced rows where upper/lower and both differ).
function headerPrice(row: CatalogueRow): { price: number; fromPrefix: boolean } {
  const askArch = row.arch_match === 'single';
  const hasBoth = row.both_arches_price != null;
  const price =
    askArch && hasBoth
      ? Math.min(row.unit_price, row.both_arches_price ?? row.unit_price)
      : row.arch_match === 'both' && row.both_arches_price != null
        ? row.both_arches_price
        : row.unit_price;
  const fromPrefix = askArch && hasBoth && row.unit_price !== row.both_arches_price;
  return { price, fromPrefix };
}

// Direct-add for form-less rows. Owns a tiny busy flag so the tap
// target can dim while the write lands; the picker closes on success
// so the flag rarely lingers.
function useFormlessAdd(
  row: CatalogueRow,
  ctx: LineCommitCtx,
  { onAdded, onError }: { onAdded: () => void; onError: (msg: string) => void }
) {
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await commitLine(row, 1, FORMLESS_OPTIONS, ctx);
      onAdded();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not add item');
    } finally {
      setBusy(false);
    }
  };
  return { busy, add };
}

// ─────────────────────────────────────────────────────────────────────────────
// LineConfigurator — the per-line form: qty + arch + shade + upgrades +
// Total/Add footer. Owns its own draft state and the add submit. Used
// both inside the accordion ProductRow (active = expanded; resets when
// the row collapses) and standalone under the suggestion carousel
// (mounted fresh per pick, so it starts clean).
// ─────────────────────────────────────────────────────────────────────────────

function LineConfigurator({
  row,
  rowUpgrades,
  cartId,
  onStage,
  onAdded,
  onError,
  active,
}: {
  row: CatalogueRow;
  rowUpgrades: UpgradeRow[];
  cartId: string | null;
  onStage?: (row: CatalogueRow, qty: number, options: CatalogueAddOptions) => void;
  onAdded: () => void;
  onError: (msg: string) => void;
  active: boolean;
}) {
  const [qty, setQty] = useState(1);
  const [arch, setArch] = useState<'upper' | 'lower' | 'both' | null>(null);
  const [shade, setShade] = useState('');
  const [selectedUpgradeIds, setSelectedUpgradeIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  // Reset the draft whenever the line goes inactive (the accordion row
  // collapsed) so the next activation starts clean. Standalone use
  // mounts fresh per pick, so this is a no-op there.
  useEffect(() => {
    if (!active) {
      setQty(1);
      setArch(null);
      setShade('');
      setSelectedUpgradeIds(new Set());
      setBusy(false);
    }
  }, [active]);

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
    for (const upgrade of rowUpgrades) {
      if (!selectedUpgradeIds.has(upgrade.id)) continue;
      const pricePounds =
        isBothArches && upgrade.both_arches_price != null
          ? upgrade.both_arches_price
          : upgrade.price;
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

  const canAdd =
    (cartId != null || onStage != null) &&
    qty >= 1 &&
    (!askArch || arch !== null) &&
    (!showShade || shade.trim() !== '');

  const submit = async () => {
    if (!canAdd || busy) return;
    const opts: CatalogueAddOptions = {
      arch: archForLine,
      shade: showShade ? shade.trim() || null : null,
      notes: null,
      upgrades: appliedUpgrades,
    };
    setBusy(true);
    try {
      await commitLine(row, qty, opts, { cartId, onStage });
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

  // Which configurator section renders first? The first one drops its
  // top border so it sits flush against the panel's top whitespace
  // instead of doubling against the header.
  const firstSection: 'qty' | 'arch' | 'shade' | 'upgrades' | null =
    row.quantity_enabled
      ? 'qty'
      : askArch
        ? 'arch'
        : showShade
          ? 'shade'
          : rowUpgrades.length > 0
            ? 'upgrades'
            : null;

  return (
    <div
      style={{
        padding: `${theme.space[1]}px ${theme.space[5]}px ${theme.space[4]}px`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {row.quantity_enabled ? (
        <ConfigRow
          label={row.unit_label ? `Quantity (${row.unit_label})` : 'Quantity'}
          first={firstSection === 'qty'}
        >
          <PillStepper value={qty} onChange={setQty} />
        </ConfigRow>
      ) : null}

      {askArch ? (
        <ConfigRow label="Arch" required first={firstSection === 'arch'}>
          <Segmented
            ariaLabel="Arch"
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
        <ConfigRow label="Shade" required first={firstSection === 'shade'}>
          <Segmented
            ariaLabel="Shade"
            value={shade}
            onChange={setShade}
            options={CLICK_IN_VENEER_SHADES.map((s) => ({ value: s, label: s }))}
          />
        </ConfigRow>
      ) : null}

      {rowUpgrades.length > 0 ? (
        <ConfigRow label="Upgrades" hint="optional" stack first={firstSection === 'upgrades'}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rowUpgrades.map((upgrade, i) => {
              const checked = selectedUpgradeIds.has(upgrade.id);
              const tierPrice =
                isBothArches && upgrade.both_arches_price != null
                  ? upgrade.both_arches_price
                  : upgrade.price;
              return (
                <label
                  key={upgrade.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.space[3],
                    padding: `${theme.space[3]}px 0`,
                    borderTop: i === 0 ? 'none' : `1px solid ${theme.color.border}`,
                    cursor: 'pointer',
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
                    +{formatPounds(tierPrice)}
                  </span>
                </label>
              );
            })}
          </div>
        </ConfigRow>
      ) : null}

      {/* Footer — calm summary on the left, primary action on the
          right. Matches the Wise/Stripe summary-then-CTA pattern:
          small "Total" eyebrow + a single big tabular value that
          doesn't compete with the button label. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[4],
          marginTop: theme.space[2],
          paddingTop: theme.space[4],
          borderTop: `1px solid ${theme.color.border}`,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span
            style={{
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              fontWeight: theme.type.weight.medium,
              letterSpacing: 0,
            }}
          >
            Total
          </span>
          <span
            style={{
              fontSize: theme.type.size.xl,
              fontWeight: theme.type.weight.semibold,
              fontVariantNumeric: 'tabular-nums',
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
              lineHeight: 1,
            }}
          >
            {formatPounds(lineTotal)}
          </span>
        </div>
        <Button
          variant="primary"
          size="md"
          onClick={submit}
          disabled={!canAdd || busy}
          loading={busy}
          showArrow={!busy}
        >
          Add to bag
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ProductRow — the accordion's atomic unit (the grouped Services /
// Products lists below the suggestion carousel).
//
// Header (always visible): thumbnail + name + price + caret.
// Body (visible when expanded): the shared LineConfigurator.
// CSS Grid trick: grid-template-rows transitions from 0fr → 1fr to give
// a smooth height animation without measuring DOM. Inner div has
// overflow: hidden so the content clips during the transition.
// ─────────────────────────────────────────────────────────────────────────────

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
  rowUpgrades: UpgradeRow[];
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

  const isFormless = isFormlessRow(row, rowUpgrades);
  const { busy: formlessBusy, add: formlessAdd } = useFormlessAdd(
    row,
    { cartId, onStage },
    { onAdded, onError }
  );
  const { price: minHeaderPrice, fromPrefix: showFromPrefix } = headerPrice(row);

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

  const handleHeaderClick = () => {
    if (formlessBusy) return;
    if (isFormless) {
      void formlessAdd();
      return;
    }
    onToggle();
  };

  return (
    <article
      ref={articleRef}
      className={
        expanded ? 'lng-product-row lng-product-row--expanded' : 'lng-product-row'
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
          {showFromPrefix ? 'From ' : ''}{formatPounds(minHeaderPrice)}
        </span>
        <RowActionBox isFormless={isFormless} expanded={expanded} busy={formlessBusy} />
      </button>

      {/* Animated panel — grid-template-rows transition. Form-less rows
          have no panel; they add straight from the header tap. */}
      {!isFormless ? (
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
            <LineConfigurator
              row={row}
              rowUpgrades={rowUpgrades}
              cartId={cartId}
              onStage={onStage}
              onAdded={onAdded}
              onError={onError}
              active={expanded}
            />
          </div>
        </div>
      ) : null}
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SuggestionSection — accent eyebrow + swipable card carousel + an
// inline configurator that opens directly beneath the cards. Keeping
// the configurator here (not in the grouped lists below) means tapping
// a suggested card never expands the duplicate row further down and
// never scrolls the sheet away from the top.
// ─────────────────────────────────────────────────────────────────────────────

interface SuggestionHandlers {
  cartId: string | null;
  onStage?: (row: CatalogueRow, qty: number, options: CatalogueAddOptions) => void;
  onAdded: () => void;
  onError: (msg: string) => void;
}

function SuggestionSection({
  rows,
  upgradesByCatalogue,
  activeId,
  onSelect,
  cartId,
  onStage,
  onAdded,
  onError,
}: {
  rows: CatalogueRow[];
  upgradesByCatalogue: Map<string, UpgradeRow[]>;
  activeId: string | null;
  onSelect: (id: string | null) => void;
} & SuggestionHandlers) {
  const handlers: SuggestionHandlers = { cartId, onStage, onAdded, onError };
  const activeRow = activeId ? rows.find((r) => r.id === activeId) ?? null : null;
  const activeUpgrades = activeRow ? upgradesByCatalogue.get(activeRow.id) ?? [] : [];

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3], minWidth: 0 }}>
      <header style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
        <Sparkles size={14} color={theme.color.accent} aria-hidden />
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.accent,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Suggested for this booking
        </h3>
      </header>

      <SuggestionCarousel
        rows={rows}
        upgradesByCatalogue={upgradesByCatalogue}
        activeId={activeId}
        onSelect={onSelect}
        {...handlers}
      />

      {/* Inline configurator — slides open beneath the cards. */}
      <div
        style={{
          display: 'grid',
          gridTemplateRows: activeRow ? '1fr' : '0fr',
          transition: `grid-template-rows ${theme.motion.duration.base}ms ${theme.motion.easing.spring}`,
        }}
      >
        <div style={{ overflow: 'hidden' }}>
          {activeRow ? (
            <SuggestionConfigurator
              key={activeRow.id}
              row={activeRow}
              rowUpgrades={activeUpgrades}
              onClose={() => onSelect(null)}
              {...handlers}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

// Card width / image height — tuned so ~3 cards plus a peek of the
// fourth are visible on an iPad sheet, signalling the row swipes.
const SUGGESTION_CARD_WIDTH = 168;
const SUGGESTION_CARD_IMAGE_HEIGHT = 112;

function SuggestionCarousel({
  rows,
  upgradesByCatalogue,
  activeId,
  onSelect,
  cartId,
  onStage,
  onAdded,
  onError,
}: {
  rows: CatalogueRow[];
  upgradesByCatalogue: Map<string, UpgradeRow[]>;
  activeId: string | null;
  onSelect: (id: string | null) => void;
} & SuggestionHandlers) {
  const handlers: SuggestionHandlers = { cartId, onStage, onAdded, onError };
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Edge fades: on when there's hidden content in that direction, so
  // the carousel quietly advertises that it scrolls without a
  // permanent scrollbar.
  const [edges, setEdges] = useState({ start: false, end: false });
  const updateEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const start = el.scrollLeft > 2;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);
  // Re-measure when the card set changes (cart edits change suggestions).
  useEffect(() => {
    updateEdges();
  }, [rows, updateEdges]);

  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <div
        ref={scrollRef}
        className="lng-sug-scroll"
        onScroll={updateEdges}
        style={{
          display: 'flex',
          gap: theme.space[3],
          overflowX: 'auto',
          scrollSnapType: 'x mandatory',
          // Vertical breathing room so the cards' shadows and the
          // active card's accent ring aren't clipped by the row.
          padding: `${theme.space[1]}px 0 ${theme.space[2]}px`,
        }}
      >
        {rows.map((r) => (
          <SuggestionCard
            key={r.id}
            row={r}
            rowUpgrades={upgradesByCatalogue.get(r.id) ?? []}
            active={activeId === r.id}
            onSelect={() => onSelect(r.id)}
            {...handlers}
          />
        ))}
      </div>
      <CarouselFade side="left" show={edges.start} />
      <CarouselFade side="right" show={edges.end} />
    </div>
  );
}

// Soft surface-to-transparent gradient over each carousel edge. The
// transparent stop must use the surface colour at alpha 0 (not the
// `transparent` keyword) to avoid the grey-fade artefact some engines
// produce when interpolating to transparent-black.
function CarouselFade({ side, show }: { side: 'left' | 'right'; show: boolean }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        [side]: 0,
        width: 40,
        pointerEvents: 'none',
        background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, ${theme.color.surface}, rgba(255, 255, 255, 0))`,
        opacity: show ? 1 : 0,
        transition: `opacity ${theme.motion.duration.base}ms ${theme.motion.easing.standard}`,
      }}
    />
  );
}

// A single swipable suggestion card: hero image + accent add badge,
// then name + price. Form-less products add on tap; configurable ones
// open the inline configurator below the carousel.
function SuggestionCard({
  row,
  rowUpgrades,
  active,
  onSelect,
  cartId,
  onStage,
  onAdded,
  onError,
}: {
  row: CatalogueRow;
  rowUpgrades: UpgradeRow[];
  active: boolean;
  onSelect: () => void;
} & SuggestionHandlers) {
  const formless = isFormlessRow(row, rowUpgrades);
  const { busy, add } = useFormlessAdd(row, { cartId, onStage }, { onAdded, onError });
  const { price, fromPrefix } = headerPrice(row);

  const handleClick = () => {
    if (busy) return;
    if (formless) void add();
    else onSelect();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={active ? 'lng-sug-card lng-sug-card--active' : 'lng-sug-card'}
      aria-pressed={formless ? undefined : active}
      aria-label={formless ? `Add ${row.name} to bag` : `Configure ${row.name}`}
      style={{
        appearance: 'none',
        fontFamily: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        flexShrink: 0,
        width: SUGGESTION_CARD_WIDTH,
        scrollSnapAlign: 'start',
        display: 'flex',
        flexDirection: 'column',
        padding: 0,
        background: theme.color.surface,
        border: `1px solid ${active ? theme.color.accent : theme.color.border}`,
        borderRadius: theme.radius.card,
        boxShadow: active ? theme.shadow.raised : theme.shadow.card,
        overflow: 'hidden',
        opacity: busy ? 0.7 : 1,
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {/* Hero image */}
      <span
        style={{
          position: 'relative',
          display: 'block',
          width: '100%',
          height: SUGGESTION_CARD_IMAGE_HEIGHT,
          background: row.image_url ? theme.color.surface : 'rgba(14, 20, 20, 0.04)',
        }}
      >
        {row.image_url ? (
          <img
            src={row.image_url}
            alt={row.name}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            onError={(e) => {
              (e.currentTarget as HTMLElement).style.display = 'none';
            }}
          />
        ) : (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: theme.color.inkSubtle,
            }}
          >
            <Package size={28} />
          </span>
        )}
        {/* Add badge — accent circle, white glyph. Form-less adds on
            tap; configurable opens options. */}
        <span
          aria-hidden
          style={{
            position: 'absolute',
            right: theme.space[2],
            bottom: theme.space[2],
            width: 34,
            height: 34,
            borderRadius: theme.radius.pill,
            background: theme.color.accent,
            color: theme.color.surface,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 6px rgba(14, 20, 20, 0.18)',
          }}
        >
          {formless ? <ShoppingBag size={17} /> : <Plus size={18} strokeWidth={2.5} />}
        </span>
      </span>

      {/* Body */}
      <span
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[1],
          padding: theme.space[3],
        }}
      >
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            lineHeight: 1.3,
            // Two-line clamp with a fixed min-height so every card in
            // the row is the same height (symmetry across the carousel).
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            minHeight: 36,
          }}
        >
          {row.name}
        </span>
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {fromPrefix ? 'From ' : ''}
          {formatPounds(price)}
        </span>
      </span>
    </button>
  );
}

// Standalone configurator shown beneath the carousel when a
// configurable suggested card is tapped. A compact identity header
// (thumb + name + close) sits above the shared LineConfigurator.
function SuggestionConfigurator({
  row,
  rowUpgrades,
  cartId,
  onStage,
  onAdded,
  onError,
  onClose,
}: {
  row: CatalogueRow;
  rowUpgrades: UpgradeRow[];
  onClose: () => void;
} & SuggestionHandlers) {
  const { price, fromPrefix } = headerPrice(row);
  return (
    <div
      style={{
        marginTop: theme.space[1],
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        background: theme.color.bg,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          padding: `${theme.space[4]}px ${theme.space[4]}px 0`,
        }}
      >
        <Thumb src={row.image_url} alt={row.name} size={40} />
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
          <p
            style={{
              margin: `2px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {fromPrefix ? 'From ' : ''}
            {formatPounds(price)}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close options"
          style={{
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            color: theme.color.inkSubtle,
            cursor: 'pointer',
            height: 36,
            width: 36,
            borderRadius: theme.radius.pill,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <X size={18} />
        </button>
      </div>
      <LineConfigurator
        row={row}
        rowUpgrades={rowUpgrades}
        cartId={cartId}
        onStage={onStage}
        onAdded={onAdded}
        onError={onError}
        active
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ConfigRow — `label-left | control-right` row used inside the
// expansion panel. Hairline ABOVE every row except the first (so the
// last row sits flush against the footer's own divider, no doubled
// line). Generous vertical padding (16) for calm rhythm.
// ─────────────────────────────────────────────────────────────────────────────

function ConfigRow({
  label,
  required = false,
  hint,
  stack = false,
  children,
  first = false,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  stack?: boolean;
  children: React.ReactNode;
  first?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: stack ? 'column' : 'row',
        alignItems: stack ? 'stretch' : 'center',
        justifyContent: stack ? 'flex-start' : 'space-between',
        gap: stack ? theme.space[3] : theme.space[4],
        padding: `${theme.space[4]}px 0`,
        borderTop: first ? 'none' : `1px solid ${theme.color.border}`,
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
// Segmented — iOS-style "lifted pill" control. The container is a
// soft inset on the row (1.5%-ink wash) so the surrounding cream
// stays cream; the selected segment lifts to white surface with a
// subtle 1px shadow, semibold ink. Unselected segments are
// transparent — the eye reads the lifted segment as the answer.
// Used for arch + shade pickers.
// ─────────────────────────────────────────────────────────────────────────────

function Segmented<T extends string>({
  ariaLabel,
  value,
  onChange,
  options,
}: {
  ariaLabel: string;
  value: T | null | '';
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      style={{
        display: 'inline-flex',
        padding: 3,
        borderRadius: theme.radius.pill,
        // Subtle ink wash so the segments float above the cream row
        // bg without introducing a hard border.
        background: 'rgba(14, 20, 20, 0.04)',
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
              background: selected ? theme.color.surface : 'transparent',
              color: selected ? theme.color.ink : theme.color.inkMuted,
              fontFamily: 'inherit',
              fontSize: theme.type.size.sm,
              fontWeight: selected ? theme.type.weight.semibold : theme.type.weight.medium,
              cursor: 'pointer',
              transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
              minWidth: 56,
              // Lifted-pill effect: a tiny shadow on the selected
              // segment so it reads as "in front of" the others
              // without needing a heavy border.
              boxShadow: selected
                ? '0 1px 2px rgba(14, 20, 20, 0.08), 0 0 0 0.5px rgba(14, 20, 20, 0.04)'
                : 'none',
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
// PillStepper — single rounded container, three internal segments
// (minus | value | plus). Same chrome language as Segmented (inset
// wash bg, no internal borders) so the configurator reads as one
// system, not three loose controls. The number lifts to surface
// only by typography weight — no visible background pill behind it.
// ─────────────────────────────────────────────────────────────────────────────

function PillStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const [hover, setHover] = useState<'minus' | 'plus' | null>(null);
  const minDisabled = value <= 1;
  const button = (kind: 'minus' | 'plus', disabled: boolean): CSSProperties => ({
    appearance: 'none',
    width: 32,
    height: 32,
    borderRadius: theme.radius.pill,
    border: 'none',
    background:
      hover === kind && !disabled
        ? 'rgba(14, 20, 20, 0.06)'
        : 'transparent',
    color: disabled ? theme.color.inkSubtle : theme.color.ink,
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'inherit',
    transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
  });
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: 3,
        borderRadius: theme.radius.pill,
        background: 'rgba(14, 20, 20, 0.04)',
        gap: 0,
      }}
    >
      <button
        type="button"
        aria-label="Decrease quantity"
        disabled={minDisabled}
        onClick={() => onChange(Math.max(1, value - 1))}
        onMouseEnter={() => setHover('minus')}
        onMouseLeave={() => setHover(null)}
        style={button('minus', minDisabled)}
      >
        <Minus size={14} strokeWidth={2.5} />
      </button>
      <span
        style={{
          minWidth: 32,
          textAlign: 'center',
          fontSize: theme.type.size.base,
          fontWeight: theme.type.weight.semibold,
          fontVariantNumeric: 'tabular-nums',
          color: theme.color.ink,
          padding: `0 ${theme.space[1]}px`,
        }}
        aria-live="polite"
      >
        {value}
      </span>
      <button
        type="button"
        aria-label="Increase quantity"
        onClick={() => onChange(value + 1)}
        onMouseEnter={() => setHover('plus')}
        onMouseLeave={() => setHover(null)}
        style={button('plus', false)}
      >
        <Plus size={14} strokeWidth={2.5} />
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

