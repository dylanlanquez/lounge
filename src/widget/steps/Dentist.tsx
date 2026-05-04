import { Check, Users } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import type { BookingStateApi } from '../state.ts';
import { WIDGET_DENTISTS } from '../data.ts';

// Step 3 — Dentist.
//
// Conditional: only appears when the chosen service's
// `allowStaffPick` is true (data.ts). Otherwise the engine drops
// this step and the patient goes straight from Service to Time.
//
// "Any available" is always the first option — most patients don't
// have a strong preference, and picking it widens the time-grid in
// Step 4 (since slots can come from any clinician).

export function DentistStep({ api }: { api: BookingStateApi }) {
  const select = (next: 'any' | (typeof WIDGET_DENTISTS)[number]) => {
    api.setState((prev) => ({ ...prev, dentist: next }));
    api.goNext();
  };

  const selectedId =
    api.state.dentist === 'any'
      ? 'any'
      : api.state.dentist?.id ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <DentistCard
        avatar={
          <span
            aria-hidden
            style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              background: theme.color.bg,
              color: theme.color.ink,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Users size={20} aria-hidden />
          </span>
        }
        name="Any available dentist"
        role="We'll match you with whoever has the soonest opening"
        selected={selectedId === 'any'}
        onClick={() => select('any')}
      />
      {WIDGET_DENTISTS.map((d) => (
        <DentistCard
          key={d.id}
          avatar={<DentistAvatar name={d.name} avatarUrl={d.avatarUrl} />}
          name={d.name}
          role={d.role}
          selected={selectedId === d.id}
          onClick={() => select(d)}
        />
      ))}
    </div>
  );
}

function DentistCard({
  avatar,
  name,
  role,
  selected,
  onClick,
}: {
  avatar: React.ReactNode;
  name: string;
  role: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        textAlign: 'left',
        fontFamily: 'inherit',
        cursor: 'pointer',
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        borderRadius: theme.radius.card,
        background: theme.color.surface,
        border: `1px solid ${selected ? theme.color.accent : theme.color.border}`,
        boxShadow: selected ? theme.shadow.card : 'none',
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[4],
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
      onMouseEnter={(e) => {
        if (selected) return;
        e.currentTarget.style.borderColor = theme.color.ink;
      }}
      onMouseLeave={(e) => {
        if (selected) return;
        e.currentTarget.style.borderColor = theme.color.border;
      }}
    >
      {avatar}
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
          <span dangerouslySetInnerHTML={{ __html: name }} />
        </p>
        {role ? (
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: theme.type.leading.snug,
            }}
          >
            <span dangerouslySetInnerHTML={{ __html: role }} />
          </p>
        ) : null}
      </div>
      {selected ? (
        <span
          aria-hidden
          style={{
            width: 24,
            height: 24,
            borderRadius: '50%',
            background: theme.color.accent,
            color: theme.color.surface,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Check size={14} aria-hidden />
        </span>
      ) : null}
    </button>
  );
}

function DentistAvatar({ name, avatarUrl }: { name: string; avatarUrl: string }) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        aria-hidden
        style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
      />
    );
  }
  const initials = name
    .split(/\s+/)
    .filter((w) => /[A-Za-z]/.test(w[0] ?? ''))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <span
      aria-hidden
      style={{
        width: 44,
        height: 44,
        borderRadius: '50%',
        background: theme.color.accentBg,
        color: theme.color.accent,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.semibold,
        flexShrink: 0,
      }}
    >
      {initials || '·'}
    </span>
  );
}
