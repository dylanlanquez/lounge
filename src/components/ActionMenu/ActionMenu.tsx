import { cloneElement, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { theme } from '../../theme/index.ts';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';

// ActionMenu
//
// Button-anchored popover OR bottom-sheet for secondary actions
// that would otherwise crowd a primary CTA row. Click the trigger
// button to open, click an item to fire, click outside / press Esc
// to close.
//
// Two presentations:
//   * 'popover' (default) — portal-mounted anchored dropdown, the
//     original tight desktop pattern.
//   * 'sheet' — opens as a BottomSheet from the screen edge. Used
//     on touch surfaces where a giant tap target reads better than
//     a tiny dropdown, and where the May 2026 sheet language is
//     already the dominant idiom (cart / visit pages).
//
// Each item renders an icon + label + optional muted hint; disabled
// items still show but don't dispatch.

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
  /** Popover mode only — side the popover opens on relative to the
   *  trigger. Defaults to 'bottom-end' so the menu's right edge
   *  aligns with the trigger's right edge — sensible for a More
   *  button at the end of an action row. */
  align?: 'bottom-end' | 'top-end';
  /** Optional aria-label on the popover for screen readers.
   *  Defaults to "More actions". */
  ariaLabel?: string;
  /** Default 'popover' (anchored dropdown). Use 'sheet' for touch /
   *  cart-row surfaces where a BottomSheet is the right size for a
   *  More menu. */
  presentation?: 'popover' | 'sheet';
  /** Sheet mode only — title rendered in the BottomSheet header.
   *  Defaults to 'More actions'. */
  sheetTitle?: string;
  /** Sheet mode only — sub-line under the title. */
  sheetDescription?: string;
}

export function ActionMenu({
  trigger,
  items,
  align = 'bottom-end',
  ariaLabel = 'More actions',
  presentation = 'popover',
  sheetTitle = 'More actions',
  sheetDescription,
}: ActionMenuProps) {
  const [open, setOpen] = useState(false);

  // Clone the trigger once so we can wire its onClick to toggle the
  // menu without forcing the caller to import a Button variant
  // they don't already use. The caller's own onClick (if any) still
  // runs first. Wrapped once at this level so both presentations
  // share the exact same trigger node (no double-wrapping).
  const wiredTrigger = useMemo(
    () => wireTriggerClick(trigger, () => setOpen((v) => !v)),
    [trigger],
  );

  if (presentation === 'sheet') {
    return (
      <>
        {wiredTrigger}
        <BottomSheet
          open={open}
          onClose={() => setOpen(false)}
          title={sheetTitle}
          description={sheetDescription}
        >
          <ul
            role="menu"
            aria-label={ariaLabel}
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {items.map((it, idx) => (
              <li
                key={it.key}
                style={{
                  borderTop: idx === 0 ? 'none' : `1px solid ${theme.color.border}`,
                }}
              >
                <SheetActionRow
                  item={it}
                  onClose={() => setOpen(false)}
                />
              </li>
            ))}
          </ul>
        </BottomSheet>
      </>
    );
  }

  return (
    <PopoverActionMenu
      trigger={wiredTrigger}
      items={items}
      ariaLabel={ariaLabel}
      align={align}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

function SheetActionRow({
  item,
  onClose,
}: {
  item: ActionMenuItem;
  onClose: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={item.disabled}
      onClick={() => {
        if (item.disabled) return;
        onClose();
        item.onClick();
      }}
      style={{
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        width: '100%',
        textAlign: 'left',
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
        cursor: item.disabled ? 'not-allowed' : 'pointer',
        opacity: item.disabled ? 0.5 : 1,
        color: item.tone === 'alert' ? theme.color.alert : theme.color.ink,
        fontFamily: 'inherit',
        fontSize: theme.type.size.base,
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
      onMouseEnter={(e) => {
        if (item.disabled) return;
        (e.currentTarget as HTMLButtonElement).style.background = theme.color.bg;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          borderRadius: theme.radius.pill,
          background:
            item.tone === 'alert'
              ? 'rgba(184, 58, 42, 0.08)'
              : theme.color.bg,
          color: item.tone === 'alert' ? theme.color.alert : theme.color.inkMuted,
          border: `1px solid ${theme.color.border}`,
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        {item.icon}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <span
          style={{
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            lineHeight: 1.3,
          }}
        >
          {item.label}
        </span>
        {item.hint ? (
          <span
            style={{
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: theme.type.leading.snug,
            }}
          >
            {item.hint}
          </span>
        ) : null}
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Popover presentation — original anchored dropdown.
// ─────────────────────────────────────────────────────────────────────────────

function PopoverActionMenu({
  trigger,
  items,
  ariaLabel,
  align,
  open,
  onOpenChange,
}: {
  trigger: React.ReactElement;
  items: ActionMenuItem[];
  ariaLabel: string;
  align: 'bottom-end' | 'top-end';
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
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
      if (e.key === 'Escape') onOpenChange(false);
    };
    const onClick = (e: MouseEvent) => {
      const tgt = e.target as Node | null;
      if (!tgt) return;
      if (popoverRef.current?.contains(tgt)) return;
      if (triggerWrapRef.current?.contains(tgt)) return;
      onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [open, onOpenChange]);

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
                  onOpenChange(false);
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
      <span ref={triggerWrapRef} style={{ display: 'inline-flex' }}>
        {trigger}
      </span>
      {popover}
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
