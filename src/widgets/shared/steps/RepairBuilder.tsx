import { useState } from 'react';
import { Check, Minus, Plus } from 'lucide-react';
import {
  useRepairCatalogueRows,
  type RepairCatalogueRow,
} from '../data.ts';
import type { BookingStateApi } from '../state.ts';
import { QUIZ } from '../quizTokens.ts';
import { useCanHover } from '../useCanHover.ts';

// Denture-repair step components, arch-first.
//
//   Step 1 — RepairArchStep  : "Which denture needs fixing?"
//                              Three big tiles: Top / Bottom / Both.
//   Step 2 — RepairLinesStep : "What needs fixing on your <top/bottom>
//                              denture?" Multi-select repair tiles
//                              with an inline −/+ quantity stepper on
//                              per-tooth tiles.
//
// "Both" runs RepairLinesStep twice, once for each arch. Each tile is
// labelled with the arch baked into the copy ("Snapped top denture",
// "Reline bottom denture") so an elderly patient never has to remember
// which page they're on.
//
// Built for older users:
//   • Big tap targets (130px min tiles, 52px stepper buttons).
//   • Plain English copy. No dental jargon, no "select arch" labels.
//   • One question per page. The multi-select page only ever asks "what
//     needs work on THIS denture?" — never both at the same time.
//   • Selection state is unambiguous: a navy border, a filled tick in
//     the corner, and the price preview turns navy too.

// ─────────────────────────────────────────────────────────────────────
// Step 1 — Which denture needs fixing?
// ─────────────────────────────────────────────────────────────────────

export function RepairArchStep({
  api,
  accent = QUIZ.ACCENT,
}: {
  api: BookingStateApi;
  accent?: string;
}) {
  const selected = api.state.axes.arch;
  return (
    // No extra marginTop — StepTitle's own bottom margin
    // (STEP_TITLE_BOTTOM_SPACE) provides the gap. Parent flex gap
    // also tightened from 32 → 16 so the trio of arch tiles sits
    // close to the title on mobile without dropping below the fold.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 0 }}>
      <div
        className="vlounge-stagger"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 16,
          margin: '0 auto',
          maxWidth: 800,
          width: '100%',
        }}
      >
        {ARCH_TILES.map((tile) => (
          <ArchTile
            key={tile.value}
            title={tile.title}
            subtitle={tile.subtitle}
            selected={selected === tile.value}
            anySelected={!!selected}
            accent={accent}
            onSelect={() => api.setRepairArch(tile.value)}
          />
        ))}
      </div>
    </div>
  );
}

const ARCH_TILES: ReadonlyArray<{
  value: 'upper' | 'lower' | 'both';
  title: string;
  subtitle: string;
}> = [
  { value: 'upper', title: 'Top', subtitle: 'Just my top denture' },
  { value: 'lower', title: 'Bottom', subtitle: 'Just my bottom denture' },
  { value: 'both', title: 'Both', subtitle: 'Top and bottom dentures' },
];

function ArchTile({
  title,
  subtitle,
  selected,
  anySelected,
  accent,
  onSelect,
}: {
  title: string;
  subtitle: string;
  selected: boolean;
  anySelected: boolean;
  accent: string;
  onSelect: () => void;
}) {
  const canHover = useCanHover();
  const [hovered, setHovered] = useState(false);
  const dimmed = anySelected && !selected;
  // Hover state only engages on devices with a real hovering pointer
  // (mouse / trackpad). Touch devices skip it entirely — iOS Safari's
  // sticky hover state was painting tapped-but-not-selected tiles
  // with the accent border, which read as a false selection.
  const showLift = canHover && hovered && !selected;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${title}, ${subtitle}`}
      onMouseEnter={canHover ? () => setHovered(true) : undefined}
      onMouseLeave={canHover ? () => setHovered(false) : undefined}
      style={{
        position: 'relative',
        background: QUIZ.SURFACE,
        // Border ONLY follows selected (or mouse-hover on desktop).
        // canHover gates the hover branch so touch devices never
        // paint an accent border without a real selection.
        border: `2px solid ${selected ? accent : canHover && hovered ? accent : 'transparent'}`,
        borderRadius: QUIZ.R_CARD,
        // Shorter tiles so three of them fit above the fold on phones
        // alongside the step heading + sticky header. Padding tightens
        // proportionally so the text still breathes inside.
        padding: '16px 16px',
        minHeight: 86,
        textAlign: 'center',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: `all 0.2s ${QUIZ.EASE_CARD}, transform 0.15s ${QUIZ.EASE_CARD}`,
        transform: selected ? 'scale(1.01)' : showLift ? 'translateY(-2px)' : 'none',
        boxShadow: showLift ? QUIZ.SHADOW_LIFT : 'none',
        opacity: dimmed ? 0.6 : 1,
        animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
      }}
    >
      <span
        style={{
          fontSize: 19,
          fontWeight: 600,
          color: QUIZ.INK,
          letterSpacing: '-0.01em',
          lineHeight: 1.2,
        }}
      >
        {title}
      </span>
      <span
        style={{
          fontSize: 13,
          color: selected ? accent : QUIZ.MUTED,
          fontWeight: 500,
          lineHeight: 1.4,
        }}
      >
        {subtitle}
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step 2 — Multi-select repair tiles for one arch
// ─────────────────────────────────────────────────────────────────────

export function RepairLinesStep({
  api,
  arch,
  accent = QUIZ.ACCENT,
}: {
  api: BookingStateApi;
  arch: 'upper' | 'lower';
  accent?: string;
}) {
  const rowsResult = useRepairCatalogueRows();
  const selectedHere = api.state.repairItems.filter((r) => r.arch === arch);
  const archWord = arch === 'upper' ? 'top denture' : 'bottom denture';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <StickyArchHeader arch={arch} accent={accent} />
      {/* Inline step title — StepBody skips its own title render for
          these steps so the sticky chip above can be first in the
          DOM. Styling matches StepTitle so the look is consistent.
          The arch words are wrapped in an accent-coloured bold span
          so even on desktop (where the chip is hidden) the patient
          can see at a glance which arch they're answering for. */}
      <h2
        style={{
          // Top margin = clearance from the StickyArchHeader chip
          // pinned above. Bottom margin sourced from the global
          // STEP_TITLE_BOTTOM_SPACE token so this inline title and
          // the shell-rendered StepTitle stay in sync. Both halved
          // from the previous 32px so the tiles surface above the
          // fold on phones.
          margin: `16px auto ${QUIZ.STEP_TITLE_BOTTOM_SPACE}px`,
          maxWidth: 720,
          textAlign: 'center',
          fontSize: 24,
          lineHeight: 1.25,
          fontWeight: 500,
          color: QUIZ.INK,
          letterSpacing: '-0.01em',
          animation: `vlounge-fadeInDown 0.3s ${QUIZ.EASE_BOUNCE}`,
        }}
      >
        What needs fixing on your{' '}
        <span style={{ color: accent, fontWeight: 700 }}>{archWord}</span>?
      </h2>
      {rowsResult.loading ? (
        <SkeletonTiles />
      ) : rowsResult.error ? (
        <ErrorCard message={rowsResult.error} />
      ) : !rowsResult.data || rowsResult.data.length === 0 ? (
        <EmptyCard />
      ) : (
        <LineGrid
          rows={rowsResult.data}
          arch={arch}
          accent={accent}
          api={api}
        />
      )}
      {selectedHere.length > 0 ? (
        <p
          style={{
            margin: 0,
            fontSize: 14,
            color: QUIZ.MUTED_2,
            textAlign: 'center',
          }}
        >
          You've picked {selectedHere.length}{' '}
          {selectedHere.length === 1 ? 'repair' : 'repairs'} for your{' '}
          {arch === 'upper' ? 'top' : 'bottom'} denture.
        </p>
      ) : null}
    </div>
  );
}

function LineGrid({
  rows,
  arch,
  accent,
  api,
}: {
  rows: RepairCatalogueRow[];
  arch: 'upper' | 'lower';
  accent: string;
  api: BookingStateApi;
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
      {rows.map((row) => {
        const line = api.state.repairItems.find(
          (r) => r.arch === arch && r.code === row.code,
        );
        return (
          <RepairLineTile
            key={row.id}
            row={row}
            selected={!!line}
            quantity={line?.quantity ?? 1}
            accent={accent}
            onToggle={() =>
              api.setRepairSelected({
                arch,
                catalogueId: row.id,
                code: row.code,
                repairVariant: row.repairVariant,
                name: row.name,
                unitLabel: row.unitLabel,
                unitPricePence: row.unitPricePence,
                bothArchesPricePence: row.bothArchesPricePence,
                selected: !line,
              })
            }
            onQuantityChange={(q) => api.setRepairQuantity(arch, row.code, q)}
          />
        );
      })}
    </div>
  );
}

function RepairLineTile({
  row,
  selected,
  quantity,
  accent,
  onToggle,
  onQuantityChange,
}: {
  row: RepairCatalogueRow;
  selected: boolean;
  quantity: number;
  accent: string;
  onToggle: () => void;
  onQuantityChange: (next: number) => void;
}) {
  const canHover = useCanHover();
  const [hovered, setHovered] = useState(false);
  const isPerTooth = row.unitLabel === 'per tooth';
  const title = friendlyTitle(row);
  // Hover gated on canHover so touch devices never enter the hovered
  // state. iOS Safari's sticky hover would otherwise leave a tapped
  // tile in the accent-bordered "hover" look, ambiguous with selected.
  const hoverActive = canHover && hovered;
  // The whole tile is the toggle target. The stepper sits inside but
  // stops propagation so its own taps don't accidentally deselect.
  return (
    <div
      style={{
        position: 'relative',
        background: QUIZ.SURFACE,
        border: `2px solid ${selected ? accent : hoverActive ? accent : 'transparent'}`,
        borderRadius: QUIZ.R_CARD,
        transition: `all 0.2s ${QUIZ.EASE_CARD}, transform 0.15s ${QUIZ.EASE_CARD}`,
        transform: selected
          ? 'scale(1.01)'
          : hoverActive
            ? 'translateY(-2px)'
            : 'none',
        boxShadow: hoverActive && !selected ? QUIZ.SHADOW_LIFT : 'none',
        animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
        overflow: 'hidden',
      }}
      onMouseEnter={canHover ? () => setHovered(true) : undefined}
      onMouseLeave={canHover ? () => setHovered(false) : undefined}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={selected}
        aria-label={title}
        style={{
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          padding: '20px 20px 18px',
          paddingRight: 52, // room for the corner tick indicator
          width: '100%',
          textAlign: 'left',
          cursor: 'pointer',
          fontFamily: 'inherit',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          minHeight: 84,
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
          {title}
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
        <TickIndicator selected={selected} accent={accent} />
      </button>

      {selected && isPerTooth ? (
        <div
          style={{
            borderTop: `1px solid ${QUIZ.BORDER_SOFT}`,
            padding: '12px 16px 14px',
            background: QUIZ.SOFT_BG,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
          // Stop clicks bubbling up so tapping the stepper doesn't
          // toggle the tile off. Same trick as the cart × button on
          // the earlier draft.
          onClick={(e) => e.stopPropagation()}
        >
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: QUIZ.INK,
            }}
          >
            How many teeth?
          </span>
          <InlineStepper
            value={quantity}
            min={1}
            max={14}
            onChange={onQuantityChange}
            accent={accent}
          />
        </div>
      ) : null}
    </div>
  );
}

function TickIndicator({
  selected,
  accent,
}: {
  selected: boolean;
  accent: string;
}) {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        width: 24,
        height: 24,
        borderRadius: '50%',
        border: `2px solid ${selected ? accent : QUIZ.SUBTLE_2}`,
        background: selected ? accent : QUIZ.SURFACE,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        transition: `all 0.18s ${QUIZ.EASE_CARD}`,
      }}
    >
      <Check
        size={14}
        strokeWidth={3.5}
        style={{
          opacity: selected ? 1 : 0,
          transform: selected ? 'scale(1)' : 'scale(0.4)',
          transition: `all 0.18s ${QUIZ.EASE_CARD}`,
        }}
      />
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Inline stepper for per-tooth tiles
// ─────────────────────────────────────────────────────────────────────

function InlineStepper({
  value,
  min,
  max,
  onChange,
  accent,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  accent: string;
}) {
  const canDec = value > min;
  const canInc = value < max;
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <StepperButton
        onClick={() => canDec && onChange(value - 1)}
        disabled={!canDec}
        ariaLabel="Fewer teeth"
        accent={accent}
      >
        <Minus size={18} aria-hidden />
      </StepperButton>
      <span
        aria-live="polite"
        aria-label={`${value} teeth`}
        style={{
          minWidth: 28,
          textAlign: 'center',
          fontSize: 20,
          fontWeight: 700,
          color: QUIZ.INK,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
      <StepperButton
        onClick={() => canInc && onChange(value + 1)}
        disabled={!canInc}
        ariaLabel="More teeth"
        accent={accent}
      >
        <Plus size={18} aria-hidden />
      </StepperButton>
    </div>
  );
}

function StepperButton({
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
        appearance: 'none',
        border: 'none',
        width: 44,
        height: 44,
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
// Arch-context chip — persistent reminder of which arch this step is
// asking about. Wrapped in StickyArchHeader so it pins right under
// the header progress bar as the patient scrolls through the tiles —
// they never lose track of which page they're on.
// ─────────────────────────────────────────────────────────────────────

function StickyArchHeader({
  arch,
  accent,
}: {
  arch: 'upper' | 'lower';
  accent: string;
}) {
  // The step body has padding '8px 20px 24px' on its inner container
  // (see Widget.tsx ChromeShell). Negative margins absorb that
  // padding so the sticky bar:
  //   • sits flush against the header (no 8px gap above)
  //   • bleeds its background to the full scroll width (no 20px
  //     left/right gutter where the underlying tiles would show
  //     through as they scroll past)
  // Internal padding restores the 20px horizontal alignment for the
  // chip itself so it stays in the same column as the tiles.
  // Hidden on desktop (≥768px viewport) via the .vlounge-arch-sticky
  // class + media query in quizTokens. On wider screens the title's
  // bold accent-coloured arch span carries the same context without
  // a separate chip taking up vertical space.
  return (
    <div
      className="vlounge-arch-sticky"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 3,
        marginTop: -8,
        marginLeft: -20,
        marginRight: -20,
        paddingTop: 10,
        paddingBottom: 12,
        paddingLeft: 20,
        paddingRight: 20,
        background: QUIZ.BG,
        display: 'flex',
        justifyContent: 'flex-start',
      }}
    >
      <ArchContextChip arch={arch} accent={accent} />
    </div>
  );
}

function ArchContextChip({
  arch,
  accent,
}: {
  arch: 'upper' | 'lower';
  accent: string;
}) {
  const label = arch === 'upper' ? 'My top denture' : 'My bottom denture';
  // Plain inline chip — navy filled circle with a white tick, then
  // the label in accent navy italic bold. No pill background, no
  // border. Sits at the left of the sticky bar so it reads as an
  // answer the patient has already given (the choice they made on
  // the previous step).
  return (
    <span
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 15,
        fontWeight: 700,
        fontStyle: 'italic',
        color: accent,
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: accent,
          color: '#fff',
          flexShrink: 0,
        }}
      >
        <Check size={14} strokeWidth={3.5} aria-hidden />
      </span>
      {label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Copy helpers
// ─────────────────────────────────────────────────────────────────────

// Conversational, first-person tile title. We deliberately avoid the
// arch in the wording — the chip at the top of the step ("My top
// denture") carries that context. Without arch noise the tile reads
// the way an elderly patient would describe the problem out loud:
// "it's snapped", "I've broken a tooth". Less to parse, more
// intuitive.
//
// Keyed by lwo_catalogue.code so a future catalogue addition without
// a friendly mapping falls back to the original name (defensive — the
// admin's clinical phrasing is at least always correct, just less
// friendly).
const FRIENDLY_TITLE: Record<string, string> = {
  den_snapped: "It's snapped",
  den_cracked: "It's cracked",
  den_broken_tooth: "I've broken a tooth",
  den_add_tooth: "I'm missing a tooth",
  den_reline: "It feels loose",
};

function friendlyTitle(row: RepairCatalogueRow): string {
  return FRIENDLY_TITLE[row.code] ?? row.name;
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
      <div
        style={{
          marginTop: 8,
          fontSize: 14,
          color: QUIZ.MUTED_2,
        }}
      >
        Refresh the page, or call us if it sticks. ({message})
      </div>
    </div>
  );
}
