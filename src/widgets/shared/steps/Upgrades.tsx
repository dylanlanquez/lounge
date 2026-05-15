import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Info, X } from 'lucide-react';
import type { BookingStateApi } from '../state.ts';
import type { WidgetUpgrade } from '../data.ts';
import { formatPrice } from '../state.ts';
import { QUIZ } from '../quizTokens.ts';
import { INCLUDED_PERKS } from '../includedPerks.ts';
import { useCanHover } from '../useCanHover.ts';

// Upgrades step — port of the retainer-cart `.addons-grid-vt` (lines
// 55–70 of /Users/dylan/Downloads/retainer-cart.liquid).
//
// Card layout (vertical, not the cramped horizontal I had before):
//   • Price row at top — old-price strikethrough (when applicable)
//     + lavender new-price bold.
//   • Title in 19px bold black, with an inline (i) info button on
//     upgrades that carry helper content (Scalloped today).
//   • Description in 13px muted grey.
//   • 22px rounded-square checkbox indicator on the right.
//
// Below the cards: an "Included at no extra cost" card per service
// (sourced from includedPerks.ts) so the customer sees the value
// already baked into the price before deciding on extras.
//
// Scalloped Edge has a [i] popup with a video + four-benefit list
// + "Who is this for?" note, ported verbatim from
// /Users/dylan/Downloads/retainer-cart.liquid lines 640–694.

export function UpgradesStep({
  api,
  upgrades,
  accent = QUIZ.ACCENT,
}: {
  api: BookingStateApi;
  upgrades: WidgetUpgrade[];
  accent?: string;
}) {
  const archIsBoth = api.state.axes.arch === 'both';
  const [scallopedOpen, setScallopedOpen] = useState(false);
  const serviceType = api.state.service?.serviceType ?? '';
  const perks = INCLUDED_PERKS[serviceType] ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      <p
        style={{
          margin: '0 auto',
          fontSize: 14,
          color: QUIZ.MUTED_2,
          lineHeight: 1.45,
          maxWidth: 600,
          textAlign: 'center',
        }}
      >
        Anything you'd like to add? Pick as many as you want, or none. You can
        always change your mind in clinic.
      </p>

      <div
        className="vlounge-stagger"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          maxWidth: 700,
          margin: '0 auto',
          width: '100%',
        }}
      >
        {upgrades.map((upgrade) => (
          <UpgradeCard
            key={upgrade.id}
            upgrade={upgrade}
            archIsBoth={archIsBoth}
            checked={api.state.upgradeIds.includes(upgrade.id)}
            onToggle={() => api.toggleUpgrade(upgrade.id)}
            accent={accent}
            onInfoClick={
              isScalloped(upgrade) ? () => setScallopedOpen(true) : undefined
            }
          />
        ))}
      </div>

      {perks.length > 0 ? <IncludedPerksCard perks={perks} accent={accent} /> : null}

      {scallopedOpen
        ? createPortal(
            <ScallopedInfoPopup onClose={() => setScallopedOpen(false)} accent={accent} />,
            document.body,
          )
        : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Upgrade card
// ─────────────────────────────────────────────────────────────────

function UpgradeCard({
  upgrade,
  archIsBoth,
  checked,
  onToggle,
  accent,
  onInfoClick,
}: {
  upgrade: WidgetUpgrade;
  archIsBoth: boolean;
  checked: boolean;
  onToggle: () => void;
  accent: string;
  onInfoClick?: () => void;
}) {
  const canHover = useCanHover();
  const price =
    archIsBoth && upgrade.bothArchesPricePence !== null
      ? upgrade.bothArchesPricePence
      : upgrade.unitPricePence;

  return (
    <label
      style={{
        cursor: 'pointer',
        background: QUIZ.SURFACE,
        border: `2px solid ${checked ? accent : QUIZ.BORDER}`,
        borderRadius: QUIZ.R_CARD,
        padding: '16px 20px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        transform: checked ? 'scale(1.01)' : 'none',
        transition: `all 0.2s ${QUIZ.EASE_CARD}`,
        animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
      }}
      // Hover handlers only attached on devices with a real hovering
      // pointer. On touch (phone / tablet) iOS Safari's sticky hover
      // would otherwise repaint the border with the accent and the
      // customer couldn't tell the checked state apart from a stale
      // hover state.
      onMouseEnter={canHover ? (e) => {
        if (checked) return;
        e.currentTarget.style.borderColor = accent;
        e.currentTarget.style.transform = 'translateY(-1px)';
        e.currentTarget.style.boxShadow = QUIZ.SHADOW_SOFT;
      } : undefined}
      onMouseLeave={canHover ? (e) => {
        if (checked) return;
        e.currentTarget.style.borderColor = QUIZ.BORDER;
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = 'none';
      } : undefined}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        style={{
          position: 'absolute',
          opacity: 0,
          pointerEvents: 'none',
          width: 1,
          height: 1,
        }}
      />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          // Price → title gets 8px breathing room; title → sub
          // tightens to 2px below so the description reads as a
          // direct continuation of the title rather than a
          // separate row. (Was uniform 6px which left an awkward
          // gap under the upgrade name.)
          gap: 2,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 6,
          }}
        >
          <span
            style={{
              fontSize: 16,
              color: QUIZ.LAVENDER,
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '0.02em',
            }}
          >
            +{formatPrice(price)}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <h3
            style={{
              margin: 0,
              // 16px / 600 / #333 mirrors `.addon-title-vt` (line 69
              // of retainer-cart.liquid). The earlier 19px was the
              // option-card spec — wrong rule for addons.
              fontSize: 16,
              fontWeight: 600,
              color: QUIZ.INK,
              letterSpacing: '-0.005em',
              lineHeight: 1.3,
            }}
          >
            {upgrade.name}
          </h3>
          {onInfoClick ? (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                onInfoClick();
              }}
              aria-label={`What is ${upgrade.name}?`}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                color: QUIZ.LAVENDER,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 18,
                height: 18,
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'scale(1.15)';
                e.currentTarget.style.color = QUIZ.LAVENDER_HOVER;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'scale(1)';
                e.currentTarget.style.color = QUIZ.LAVENDER;
              }}
            >
              <Info size={16} aria-hidden />
            </button>
          ) : null}
        </div>
        {upgrade.description ? (
          <p
            style={{
              margin: 0,
              fontSize: 13,
              color: QUIZ.MUTED_2,
              lineHeight: 1.45,
            }}
          >
            {upgrade.description}
          </p>
        ) : null}
      </div>
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          border: `2px solid ${checked ? accent : QUIZ.SUBTLE_2}`,
          background: checked ? accent : QUIZ.SURFACE,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          flexShrink: 0,
          transform: checked ? 'scale(1.1)' : 'scale(1)',
          transition: `all 0.2s ${QUIZ.EASE_CARD}`,
        }}
      >
        {checked ? <Check size={14} aria-hidden strokeWidth={3} /> : null}
      </span>
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────
// Included at no extra cost
// ─────────────────────────────────────────────────────────────────

function IncludedPerksCard({
  perks,
  accent,
}: {
  perks: typeof INCLUDED_PERKS[string];
  accent: string;
}) {
  return (
    <div
      style={{
        background: QUIZ.SOFT_BG,
        border: `2px solid #dee9ec`,
        borderRadius: QUIZ.R_CARD,
        padding: '20px 20px 8px',
        maxWidth: 700,
        margin: '0 auto',
        width: '100%',
        animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
      }}
    >
      <h3
        style={{
          margin: '0 0 6px',
          fontSize: 17,
          fontWeight: 700,
          color: accent,
          letterSpacing: '-0.01em',
        }}
      >
        Included at no extra cost
      </h3>
      {perks.map((perk, i) => {
        const Icon = perk.icon;
        return (
          <div
            key={perk.title}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '14px 0',
              borderBottom:
                i === perks.length - 1
                  ? 'none'
                  : `1px solid #e9ecef`,
            }}
          >
            <span
              aria-hidden
              style={{
                color: accent,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 24,
                height: 24,
                flexShrink: 0,
              }}
            >
              <Icon size={20} aria-hidden />
            </span>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: 15,
                    fontWeight: 600,
                    color: QUIZ.INK,
                    lineHeight: 1.3,
                  }}
                >
                  {perk.title}
                </p>
                {perk.subtitle ? (
                  <p
                    style={{
                      margin: '4px 0 0',
                      fontSize: 13,
                      color: QUIZ.SUBTLE,
                      fontStyle: 'italic',
                      lineHeight: 1.3,
                    }}
                  >
                    {perk.subtitle}
                  </p>
                ) : null}
              </div>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: QUIZ.LAVENDER,
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                Included
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Scalloped Edge info popup — verbatim port from retainer-cart.liquid
// ─────────────────────────────────────────────────────────────────
//
// Source: /Users/dylan/Downloads/retainer-cart.liquid lines 640–694.
// Video + four-benefit list + "Who is this for?" info-note.
//
// Rendered via React Portal to document.body so the popup escapes
// the modal's stacking context. Backdrop covers everything (z-index
// above modal). Esc + backdrop click + × all close.

const SCALLOPED_VIDEO_URL =
  'https://cdn.shopify.com/videos/c/o/v/28dea3634eb4472ab2bc9fb92ef06df7.mp4';

const SCALLOPED_BENEFITS: Array<{ heading: string; description: string }> = [
  {
    heading: 'Superior Comfort',
    description:
      'The edge is precisely shaped to follow your natural gumline, reducing irritation and eliminating sharp plastic edges that can press against your gums.',
  },
  {
    heading: 'More Discreet Design',
    description:
      "Lower profile with less gum coverage creates a barely-there look that's perfect for daytime wear and social situations.",
  },
  {
    heading: 'Perfect Fit & Retention',
    description:
      'Custom-shaped to match your unique gum contours, ensuring the retainer snaps securely into place over just the visible part of your teeth.',
  },
  {
    heading: 'Professional Finish',
    description:
      'Each edge is carefully shaped and polished by hand to create smooth, rounded margins that feel completely natural in your mouth.',
  },
];

function ScallopedInfoPopup({
  onClose,
  accent,
}: {
  onClose: () => void;
  accent: string;
}) {
  return (
    <PopupShell
      title="What is a Scalloped Edge?"
      onClose={onClose}
      accent={accent}
    >
      <div
        style={{
          width: '100%',
          marginBottom: 24,
        }}
      >
        <video
          src={SCALLOPED_VIDEO_URL}
          autoPlay
          loop
          muted
          playsInline
          style={{
            width: '100%',
            height: 'auto',
            display: 'block',
            objectFit: 'cover',
            aspectRatio: '1.6',
          }}
        />
      </div>
      <ul style={{ margin: '0 0 24px', padding: 0, listStyle: 'none' }}>
        {SCALLOPED_BENEFITS.map((b, i) => (
          <li
            key={b.heading}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              padding: '12px 0',
              borderBottom:
                i === SCALLOPED_BENEFITS.length - 1
                  ? 'none'
                  : `1px solid ${QUIZ.BORDER_SOFT}`,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 20,
                height: 20,
                flexShrink: 0,
                color: QUIZ.LAVENDER,
                marginTop: 2,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Check size={20} strokeWidth={2.5} aria-hidden />
            </span>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: QUIZ.INK,
                  margin: '0 0 4px',
                  lineHeight: 1.3,
                }}
              >
                {b.heading}
              </div>
              <p
                style={{
                  fontSize: 13,
                  color: QUIZ.MUTED_2,
                  lineHeight: 1.5,
                  margin: 0,
                }}
              >
                {b.description}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <div
        style={{
          background: QUIZ.SOFT_BG,
          borderLeft: `4px solid ${QUIZ.LAVENDER}`,
          padding: '14px 16px',
          borderRadius: 8,
          fontSize: 13,
          color: QUIZ.MUTED,
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: QUIZ.INK, fontWeight: 600 }}>
          Who is this for?
        </strong>{' '}
        Scalloped edges are especially popular among those who wear retainers
        during the day or prefer a more refined, comfortable fit. The
        additional attention to detail ensures you get a specialist-quality
        finish.
      </div>
    </PopupShell>
  );
}

// Generic popup chrome — backdrop + centred card + close button.
// Built once here; if more upgrades need their own popups in v2 we
// promote this to a shared component.

function PopupShell({
  title,
  onClose,
  accent: _accent,
  children,
}: {
  title: string;
  onClose: () => void;
  accent: string;
  children: ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        zIndex: 2147483648,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        animation: `vlounge-fadeIn 0.2s ease`,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: QUIZ.SURFACE,
          borderRadius: 16,
          maxWidth: 540,
          width: '100%',
          maxHeight: '85vh',
          // Outer card is a flex column with overflow hidden; the
          // header is a flex-shrink:0 sibling and the body owns the
          // scroll. Stops the elastic over-scroll bounce Dylan
          // flagged where content peeks underneath the header on
          // trackpad rubber-band.
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          animation: `vlounge-popupSlideIn 0.3s ${QUIZ.EASE_BOUNCE}`,
          position: 'relative',
          color: QUIZ.INK,
        }}
      >
        <header
          style={{
            flexShrink: 0,
            padding: '28px 28px 20px',
            borderBottom: `2px solid ${QUIZ.BORDER_SOFT}`,
            position: 'relative',
          }}
        >
          <h3
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: QUIZ.ACCENT,
              margin: 0,
              paddingRight: 30,
              letterSpacing: '-0.01em',
              lineHeight: 1.2,
            }}
          >
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              position: 'absolute',
              top: 24,
              right: 24,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: QUIZ.SUBTLE,
              lineHeight: 1,
              padding: 0,
              width: 28,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#f5f5f5';
              e.currentTarget.style.color = QUIZ.INK;
              e.currentTarget.style.transform = 'rotate(90deg)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = QUIZ.SUBTLE;
              e.currentTarget.style.transform = 'rotate(0deg)';
            }}
          >
            <X size={20} aria-hidden />
          </button>
        </header>
        <div
          className="vlounge-scroll"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            // `contain` only blocks scroll-chaining to parents — the
            // rubber-band bounce still fires on macOS/iOS. `none`
            // kills both, which is what we actually want for a
            // popup body that should feel flat-bottomed.
            overscrollBehavior: 'none',
            WebkitOverflowScrolling: 'touch',
            padding: '24px 28px 28px',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function isScalloped(upgrade: WidgetUpgrade): boolean {
  // Match by name (case-insensitive substring). The seed migration
  // ships the name "Scalloped"; admins occasionally rename to
  // "Scalloped Edge" or similar — substring keeps the dispatch
  // robust against those rewrites.
  return /scalloped/i.test(upgrade.name);
}
