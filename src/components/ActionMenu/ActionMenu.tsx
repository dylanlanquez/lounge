import { cloneElement, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { theme } from '../../theme/index.ts';

// ActionMenu
//
// Button-anchored popover for secondary actions that would
// otherwise crowd a primary CTA row. Click the trigger button
// to open, click an item to fire, click outside / press Esc to
// close. Each item renders an icon + label + optional muted hint;
// disabled items still show but don't dispatch.
//
// Styling mirrors the rest of the app's dropdown / sheet language
// — surface fill, hairline border, soft shadow, pill radius. No
// fancy slide animation, just a 120ms fade so the popover lands
// without competing with whatever the user is about to do.
//
// Portal-mounted so a parent with overflow:hidden / transform
// doesn't clip the popover the moment it lands. Position is
// computed from the trigger's bounding rect at open time and
// kept in sync on scroll / resize while the menu is open.

export interface ActionMenuItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  /** Soft note under the label, e.g. "card payment, this can't
   *  be undone". Optional. */
  hint?: string;
  /** Tone the row reads in. 'alert' tints the icon + label red
   *  for irreversible / destructive actions like End visit early. */
  tone?: 'neutral' | 'alert';
  onClick: () => void;
  disabled?: boolean;
}

export interface ActionMenuProps {
  trigger: React.ReactElement;
  items: ActionMenuItem[];
  /** Side the popover opens on relative to the trigger. Defaults
   *  to 'bottom-end' so the menu's right edge aligns with the
   *  trigger's right edge — sensible for a More button at the
   *  end of an action row. */
  align?: 'bottom-end' | 'top-end';
  /** Optional aria-label on the popover for screen readers.
   *  Defaults to "More actions". */
  ariaLabel?: string;
}

export function ActionMenu({
  trigger,
  items,
  align = 'bottom-end',
  ariaLabel = 'More actions',
}: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const triggerWrapRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Recompute position on open + on scroll/resize while open.
  // Cheap (one getBoundingClientRect) and avoids the popover
  // drifting away when the user scrolls underneath it.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const el = triggerWrapRef.current?.firstElementChild as HTMLElement | null;
      if (el) setRect(el.getBoundingClientRect());
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  // Outside-click + Esc close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      const tgt = e.target as Node | null;
      if (!tgt) return;
      if (popoverRef.current?.contains(tgt)) return;
      if (triggerWrapRef.current?.contains(tgt)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    // 'click' (not 'mousedown') so the trigger's own onClick can
    // toggle the menu before the document handler tears it down.
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [open]);

  // Clone the trigger so we can wire its onClick to toggle the
  // menu without forcing the caller to import a Button variant
  // they don't already use. The caller's own onClick (if any)
  // still runs first.
  const wrappedTrigger = useMemo(() => {
    return (
      <span
        ref={triggerWrapRef}
        style={{ display: 'inline-flex' }}
        onClick={(e) => {
          // Let the original trigger's onClick run if it has one,
          // then toggle. cloneElement re-wires onClick below so
          // the outer span here is purely a positioning anchor.
          void e;
        }}
      >
        {wireTriggerClick(trigger, () => setOpen((v) => !v))}
      </span>
    );
  }, [trigger]);

  const popover =
    open && rect
      ? createPortal(
          <div
            ref={popoverRef}
            role="menu"
            aria-label={ariaLabel}
            style={getPopoverStyle(rect, align)}
          >
            {items.map((it, idx) => (
              <button
                key={it.key}
                role="menuitem"
                type="button"
                disabled={it.disabled}
                onClick={() => {
                  if (it.disabled) return;
                  setOpen(false);
                  it.onClick();
                }}
                style={{
                  appearance: 'none',
                  border: 'none',
                  background: 'transparent',
                  width: '100%',
                  textAlign: 'left',
                  padding: `${theme.space[3]}px ${theme.space[4]}px`,
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: theme.space[3],
                  cursor: it.disabled ? 'not-allowed' : 'pointer',
                  opacity: it.disabled ? 0.5 : 1,
                  borderTop: idx === 0 ? 'none' : `1px solid ${theme.color.border}`,
                  color: it.tone === 'alert' ? theme.color.alert : theme.color.ink,
                  fontFamily: 'inherit',
                  fontSize: theme.type.size.sm,
                  transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
                }}
                onMouseEnter={(e) => {
                  if (it.disabled) return;
                  (e.currentTarget as HTMLButtonElement).style.background = theme.color.bg;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                }}
              >
                <span
                  aria-hidden
                  style={{
                    color: it.tone === 'alert' ? theme.color.alert : theme.color.inkMuted,
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    paddingTop: 2,
                  }}
                >
                  {it.icon}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span
                    style={{
                      fontWeight: theme.type.weight.medium,
                      letterSpacing: theme.type.tracking.tight,
                    }}
                  >
                    {it.label}
                  </span>
                  {it.hint ? (
                    <span
                      style={{
                        fontSize: theme.type.size.xs,
                        color: theme.color.inkMuted,
                        lineHeight: theme.type.leading.snug,
                      }}
                    >
                      {it.hint}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {wrappedTrigger}
      {popover}
      {/* Keyframes mounted inside the component so the fade plays
          consistently whether or not any other modal surface has
          declared its own keyframes higher up the tree. */}
      <style>{`
        @keyframes lng-menu-fade {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </>
  );
}

function wireTriggerClick(
  trigger: React.ReactElement,
  toggle: () => void,
): React.ReactElement {
  // Pull the trigger's existing onClick (if any) and run it
  // before toggling, so a caller that wants e.g. analytics on
  // open keeps working without having to re-wire here.
  const props = (trigger.props ?? {}) as {
    onClick?: (e: React.MouseEvent) => void;
  };
  const prevOnClick = props.onClick;
  return cloneElement(trigger, {
    'aria-haspopup': 'menu',
    onClick: (e: React.MouseEvent) => {
      prevOnClick?.(e);
      toggle();
    },
  } as Partial<typeof props> & { 'aria-haspopup': 'menu' });
}

function getPopoverStyle(
  rect: DOMRect,
  align: 'bottom-end' | 'top-end',
): React.CSSProperties {
  const MIN_WIDTH = 240;
  const MAX_WIDTH = 320;
  const GAP = 8;
  // Compute the right-edge anchor (align both layouts to the
  // trigger's right edge so a More button at the end of an action
  // row drops its menu directly underneath, not floating off to
  // one side).
  const right = Math.max(8, window.innerWidth - rect.right);
  const base: React.CSSProperties = {
    position: 'fixed',
    right,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    background: theme.color.surface,
    borderRadius: theme.radius.card,
    border: `1px solid ${theme.color.border}`,
    boxShadow: theme.shadow.overlay,
    overflow: 'hidden',
    zIndex: 1100,
    animation: 'lng-menu-fade 120ms ease-out',
  };
  if (align === 'top-end') {
    return { ...base, bottom: window.innerHeight - rect.top + GAP };
  }
  return { ...base, top: rect.bottom + GAP };
}
