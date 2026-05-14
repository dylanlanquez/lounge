import { Check } from 'lucide-react';
import type { BookingStateApi } from '../state.ts';
import type { WidgetUpgrade } from '../data.ts';
import { formatPrice } from '../state.ts';
import { QUIZ } from '../quizTokens.ts';

// Upgrades step — addon-style checkbox cards mirroring
// `.addon-item-vt` + `.addon-content-vt` from the retainer-cart
// template (lines 56–70).
//
// Multi-pick: the patient ticks zero, one, or several. Selection
// only updates state; navigation is footer-driven.
//
// Layout: vertical stack of cards (`.addons-grid-vt` flex-direction
// column gap 12). Each card: white surface, 2px transparent border
// activating to navy on hover/checked, 12px radius, soft lift on
// hover, scale(1.01) when checked. Title + description on the left;
// price (lavender #6f86ff bold) + 22px rounded-corner checkbox
// indicator on the right.

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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
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
          />
        ))}
      </div>
    </div>
  );
}

function UpgradeCard({
  upgrade,
  archIsBoth,
  checked,
  onToggle,
  accent,
}: {
  upgrade: WidgetUpgrade;
  archIsBoth: boolean;
  checked: boolean;
  onToggle: () => void;
  accent: string;
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
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
        background: QUIZ.SURFACE,
        border: `2px solid ${checked ? accent : QUIZ.BORDER}`,
        borderRadius: QUIZ.R_CARD,
        padding: '16px 20px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        transform: checked ? 'scale(1.01)' : 'none',
        boxShadow: 'none',
        transition: `all 0.2s ${QUIZ.EASE_CARD}`,
        animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = accent;
        if (!checked) {
          e.currentTarget.style.transform = 'translateY(-1px)';
          e.currentTarget.style.boxShadow = QUIZ.SHADOW_SOFT;
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = checked ? accent : QUIZ.BORDER;
        if (!checked) {
          e.currentTarget.style.transform = 'none';
          e.currentTarget.style.boxShadow = 'none';
        }
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: 16,
              color: QUIZ.LAVENDER,
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            +{formatPrice(price)}
          </span>
        </div>
        <h3
          style={{
            margin: 0,
            fontSize: 16,
            fontWeight: 600,
            color: QUIZ.INK,
            letterSpacing: '-0.005em',
            lineHeight: 1.3,
          }}
        >
          {upgrade.name}
        </h3>
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
    </button>
  );
}
