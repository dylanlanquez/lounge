import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Clock, X } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { useIsMobile } from '../../lib/useIsMobile.ts';

// TimePicker — single time-of-day picker, sibling to DatePicker.
//
// Visual model:
//   Desktop (≥ 720px): floating popover anchored to a caller-supplied
//                      trigger ref. A bold selected-time display tops
//                      the panel; below it a scrollable column of
//                      slots stepped every `step` minutes from
//                      `startHour` to `endHour`. The current value
//                      sits in a soft accent pill so the eye lands on
//                      it the moment the panel opens.
//   Mobile  (< 720px): bottom sheet with the same header + slot list.
//
// Interaction is click-to-commit. Picking a time is a navigation /
// form-fill action, not a filter; staged-then-Apply would just slow
// it down. The popover auto-scrolls the current value into view on
// open so a re-pick lands on the existing selection rather than
// startHour every time.

export interface TimePickerProps {
  open: boolean;
  onClose: () => void;
  // 'HH:MM' 24-hour. Drives the bold header display and the in-list
  // selected pill. Does not need to land exactly on a slot grid mark
  // — non-step values still render in the header but won't have a
  // matching pill in the list.
  value: string;
  onChange: (time: string) => void;
  anchorRef: RefObject<HTMLElement | null>;
  // Slot granularity in minutes. Default 15 — matches the booking
  // conflict checker's 15-minute grid.
  step?: number;
  // Inclusive lower bound, exclusive upper bound, both 24-hour. The
  // popover renders every slot in [startHour:00, endHour:00). Default
  // 6 → 22 covers a generous clinic day; the booking sheet narrows
  // this to the picked day's working hours so off-hours slots aren't
  // even reachable from the picker.
  startHour?: number;
  endHour?: number;
  // Optional header label for the mobile sheet. Defaults to 'Pick a
  // time' but the desktop popover doesn't render this — it shows the
  // selected time as its header instead, matching the iOS-style
  // reference design.
  title?: string;
}

const POPOVER_PAD = 16;
const SLOT_HEIGHT = 48;
const POPOVER_WIDTH = 240;
const VISIBLE_SLOTS = 6;

export function TimePicker({
  open,
  onClose,
  value,
  onChange,
  anchorRef,
  step = 15,
  startHour = 6,
  endHour = 22,
  title = 'Pick a time',
}: TimePickerProps) {
  const isMobile = useIsMobile(720);
  const slots = useMemo(
    () => buildSlots(startHour, endHour, step),
    [startHour, endHour, step],
  );
  const animId = useId().replace(/:/g, '');

  // ─── Desktop popover positioning ─────────────────────────────────
  // Auto-flip and adaptive max-height. When the trigger sits near
  // the bottom of the viewport, the popover would otherwise extend
  // past the visible area — instead we either cap the list height
  // to the available space below the trigger, or flip up entirely
  // if there's substantially more room above.
  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left?: number;
    right?: number;
    listMaxHeight: number;
    transformOrigin: string;
  } | null>(null);
  useLayoutEffect(() => {
    if (!open || isMobile) return;
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const fitsOnRight =
        rect.left + POPOVER_WIDTH <= window.innerWidth - POPOVER_PAD;
      const horizontal = fitsOnRight
        ? { left: rect.left }
        : { right: window.innerWidth - rect.right };

      // Header + paddings + list. The list is the only flexible piece;
      // everything else is roughly HEADER_H tall. We cap the list so
      // the panel as a whole stays inside the viewport.
      const HEADER_AND_PADDING = 76;
      const MIN_LIST_HEIGHT = SLOT_HEIGHT * 3;
      const PREFERRED_LIST_HEIGHT = SLOT_HEIGHT * VISIBLE_SLOTS;
      const spaceBelow = window.innerHeight - rect.bottom - 8 - POPOVER_PAD;
      const spaceAbove = rect.top - 8 - POPOVER_PAD;
      const availBelow = Math.max(0, spaceBelow - HEADER_AND_PADDING);
      const availAbove = Math.max(0, spaceAbove - HEADER_AND_PADDING);

      // Prefer rendering below; flip up only when below can't fit a
      // useful list AND above can fit a bigger one.
      const flipUp =
        availBelow < MIN_LIST_HEIGHT && availAbove > availBelow;
      const listMaxHeight = flipUp
        ? Math.min(PREFERRED_LIST_HEIGHT, availAbove)
        : Math.min(PREFERRED_LIST_HEIGHT, availBelow || PREFERRED_LIST_HEIGHT);

      const top = flipUp
        ? rect.top - 8 - HEADER_AND_PADDING - listMaxHeight
        : rect.bottom + 8;
      const transformOrigin = flipUp
        ? fitsOnRight
          ? 'bottom left'
          : 'bottom right'
        : fitsOnRight
        ? 'top left'
        : 'top right';
      setPopoverPos({
        top,
        ...horizontal,
        listMaxHeight: Math.max(MIN_LIST_HEIGHT, listMaxHeight),
        transformOrigin,
      });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, isMobile, anchorRef]);

  // ─── Esc to close ────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // ─── Auto-scroll selected slot into view on open ─────────────────
  // Without this the user lands on startHour every reopen, which
  // hides their actual selection one or two screens down.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const idx = slots.indexOf(value);
    if (idx < 0) return;
    const raf = requestAnimationFrame(() => {
      // Centre the selected slot vertically — sit it 2 slots from
      // the top so the user sees a couple of earlier options for
      // context as well.
      list.scrollTop = Math.max(0, idx * SLOT_HEIGHT - SLOT_HEIGHT * 2);
    });
    return () => cancelAnimationFrame(raf);
  }, [open, value, slots]);

  if (!open) return null;

  const handlePick = (slot: string) => {
    onChange(slot);
    onClose();
  };

  const headerDisplay = value || '--:--';

  // ─── Desktop popover ─────────────────────────────────────────────
  if (!isMobile) {
    if (!popoverPos) return null;
    return createPortal(
      <>
        <div
          aria-hidden
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'transparent',
            zIndex: 8999,
          }}
        />
        <div
          role="dialog"
          aria-label={title}
          style={{
            position: 'fixed',
            top: popoverPos.top,
            left: popoverPos.left,
            right: popoverPos.right,
            zIndex: 9000,
            background: theme.color.surface,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.card,
            boxShadow: theme.shadow.overlay,
            width: POPOVER_WIDTH,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            // Subtle pop-in animation. Translate + fade keyed on a
            // unique anim id so multiple pickers on the same page
            // don't share the keyframe and de-sync.
            animation: `lng-time-pop-${animId} ${theme.motion.duration.base}ms ${theme.motion.easing.spring}`,
            transformOrigin: popoverPos.transformOrigin,
          }}
        >
          <PopoverHeader
            display={headerDisplay}
            onClose={onClose}
          />
          <SlotList
            ref={listRef}
            slots={slots}
            value={value}
            onPick={handlePick}
            maxHeight={popoverPos.listMaxHeight}
          />
          <style>{`
            @keyframes lng-time-pop-${animId} {
              from { opacity: 0; transform: translateY(-6px) scale(0.985); }
              to   { opacity: 1; transform: translateY(0) scale(1); }
            }
          `}</style>
        </div>
      </>,
      document.body,
    );
  }

  // ─── Mobile bottom sheet ─────────────────────────────────────────
  return createPortal(
    <>
      <div
        aria-hidden
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.45)',
          zIndex: 999,
        }}
      />
      <div
        role="dialog"
        aria-label={title}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: '70vh',
          background: theme.color.surface,
          borderTopLeftRadius: theme.radius.card,
          borderTopRightRadius: theme.radius.card,
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: theme.shadow.overlay,
        }}
      >
        <SheetHeader
          display={headerDisplay}
          title={title}
          onClose={onClose}
        />
        <SlotList
          ref={listRef}
          slots={slots}
          value={value}
          onPick={handlePick}
          maxHeight={undefined}
        />
      </div>
    </>,
    document.body,
  );
}

// ─── Header (desktop) ──────────────────────────────────────────────
//
// Big bold display of the currently-selected time, mirroring the iOS
// reference design. The current value reads at a glance and the
// scrollable list below is the act of changing it. Close button on
// the right is styled as a soft pill icon button.

function PopoverHeader({
  display,
  onClose,
}: {
  display: string;
  onClose: () => void;
}) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        borderBottom: `1px solid ${theme.color.border}`,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[3],
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: theme.radius.pill,
            background: theme.color.accentBg,
            color: theme.color.accent,
            flexShrink: 0,
          }}
        >
          <Clock size={14} aria-hidden />
        </span>
        <span
          style={{
            fontSize: theme.type.size.xl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1,
          }}
        >
          {display}
        </span>
      </span>
      <CloseButton onClose={onClose} />
    </header>
  );
}

// ─── Header (mobile sheet) ─────────────────────────────────────────

function SheetHeader({
  display,
  title,
  onClose,
}: {
  display: string;
  title: string;
  onClose: () => void;
}) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        borderBottom: `1px solid ${theme.color.border}`,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.wide,
            textTransform: 'uppercase',
            color: theme.color.inkMuted,
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: theme.type.size.xxl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1.1,
          }}
        >
          {display}
        </span>
      </div>
      <CloseButton onClose={onClose} />
    </header>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close"
      onClick={onClose}
      style={{
        appearance: 'none',
        border: 'none',
        background: theme.color.bg,
        color: theme.color.inkMuted,
        cursor: 'pointer',
        width: 32,
        height: 32,
        borderRadius: theme.radius.pill,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = theme.color.border;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = theme.color.bg;
      }}
    >
      <X size={16} aria-hidden />
    </button>
  );
}

// ─── Slot list ─────────────────────────────────────────────────────
//
// Each row is a 48px button with the time centred-left at 16px. The
// selected slot fills with accentBg and prints its time in the accent
// colour, semibold — visible at a glance even mid-scroll. A faint
// hairline crowns every hour boundary so the eye can scan to "the
// 14:00 row" without counting half-hours. The custom scrollbar
// styling keeps the panel feeling part of the app rather than the
// browser; native scrollbars are suppressed in favour of a thin ink-
// tinted track that only shows on hover or active scroll.

const SlotList = ({
  ref,
  slots,
  value,
  onPick,
  maxHeight,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  slots: string[];
  value: string;
  onPick: (slot: string) => void;
  maxHeight: number | undefined;
}) => {
  return (
    <div
      ref={ref}
      role="listbox"
      aria-label="Available times"
      className="lng-time-list"
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: `${theme.space[2]}px ${theme.space[2]}px`,
        maxHeight,
        scrollBehavior: 'smooth',
      }}
    >
      {slots.map((slot) => (
        <SlotRow
          key={slot}
          slot={slot}
          isSelected={slot === value}
          onPick={onPick}
        />
      ))}
      <style>{`
        .lng-time-list::-webkit-scrollbar {
          width: 6px;
        }
        .lng-time-list::-webkit-scrollbar-track {
          background: transparent;
        }
        .lng-time-list::-webkit-scrollbar-thumb {
          background: ${theme.color.border};
          border-radius: 999px;
        }
        .lng-time-list::-webkit-scrollbar-thumb:hover {
          background: ${theme.color.inkSubtle};
        }
        .lng-time-list {
          scrollbar-width: thin;
          scrollbar-color: ${theme.color.border} transparent;
        }
      `}</style>
    </div>
  );
};

function SlotRow({
  slot,
  isSelected,
  onPick,
}: {
  slot: string;
  isSelected: boolean;
  onPick: (slot: string) => void;
}) {
  const isHourBoundary = slot.endsWith(':00');

  const buttonStyle: CSSProperties = {
    appearance: 'none',
    width: '100%',
    height: SLOT_HEIGHT,
    border: 'none',
    background: isSelected ? theme.color.accentBg : 'transparent',
    color: isSelected ? theme.color.accent : theme.color.ink,
    fontFamily: 'inherit',
    fontSize: theme.type.size.md,
    fontWeight: isSelected
      ? theme.type.weight.semibold
      : isHourBoundary
      ? theme.type.weight.medium
      : theme.type.weight.regular,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: theme.type.tracking.tight,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    padding: `0 ${theme.space[4]}px`,
    borderRadius: theme.radius.input,
    transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
  };

  return (
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      onClick={() => onPick(slot)}
      onMouseEnter={(e) => {
        if (isSelected) return;
        e.currentTarget.style.background = theme.color.bg;
      }}
      onMouseLeave={(e) => {
        if (isSelected) return;
        e.currentTarget.style.background = 'transparent';
      }}
      style={buttonStyle}
    >
      {slot}
    </button>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────

function buildSlots(startHour: number, endHour: number, step: number): string[] {
  const slots: string[] = [];
  const startMin = startHour * 60;
  const endMin = endHour * 60;
  for (let m = startMin; m < endMin; m += step) {
    const hh = Math.floor(m / 60);
    const mm = m % 60;
    slots.push(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  }
  return slots;
}
