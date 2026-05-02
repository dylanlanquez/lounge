import {
  type RefObject,
  useEffect,
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
// Shape:
//   Desktop (≥ 720px): floating popover anchored to a caller-supplied
//                      trigger ref. Holds a scrollable column of
//                      time slots — every `step` minutes from
//                      `startHour` to `endHour`.
//   Mobile  (< 720px): bottom sheet with the same scrollable slot
//                      column.
//
// Interaction: click to commit. Same model as DatePicker — picking a
// time is a navigation / form-fill action, not a filter, so a
// staged-then-Apply flow would just slow it down.
//
// API mirrors DatePicker: caller owns `open` + `onClose`, picker
// anchors to a ref, value is the currently-selected time as a
// `HH:MM` 24-hour string.

export interface TimePickerProps {
  open: boolean;
  onClose: () => void;
  value: string;
  onChange: (time: string) => void;
  anchorRef: RefObject<HTMLElement | null>;
  // Slot granularity in minutes. Defaults to 15 — matches the
  // booking conflict checker's granularity and the Schedule grid's
  // half-hour gridlines doubled.
  step?: number;
  // Inclusive lower bound, exclusive upper bound, both 24-hour. The
  // popover renders every slot in [startHour:00, endHour:00). Default
  // 6 → 22 covers a generous clinic day; the booking type's working
  // hours hint already lives in the parent, so this is just the
  // popover's scrollable range.
  startHour?: number;
  endHour?: number;
  // Optional header label shown in the popover and the mobile sheet.
  title?: string;
}

const POPOVER_PAD = 16;
const SLOT_HEIGHT = 40;

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

  // Position the desktop popover relative to the trigger; right-align
  // when it would overflow. Same approach as DatePicker.
  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left?: number;
    right?: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!open || isMobile) return;
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const APPROX_W = 200;
      const fitsOnRight = rect.left + APPROX_W <= window.innerWidth - POPOVER_PAD;
      setPopoverPos(
        fitsOnRight
          ? { top: rect.bottom + 6, left: rect.left }
          : { top: rect.bottom + 6, right: window.innerWidth - rect.right },
      );
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, isMobile, anchorRef]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Centre the currently-selected slot when the popover opens, so the
  // user lands on their current selection rather than 06:00 every
  // time. Without this the visual "selected" state is invisible
  // until they scroll.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const idx = slots.indexOf(value);
    if (idx < 0) return;
    // Defer one frame so the list has rendered when we scroll.
    const raf = requestAnimationFrame(() => {
      list.scrollTop = Math.max(0, idx * SLOT_HEIGHT - SLOT_HEIGHT * 2);
    });
    return () => cancelAnimationFrame(raf);
  }, [open, value, slots]);

  if (!open) return null;

  const handlePick = (slot: string) => {
    onChange(slot);
    onClose();
  };

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
            width: 200,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <SlotList
            ref={listRef}
            slots={slots}
            value={value}
            onPick={handlePick}
            maxHeight={SLOT_HEIGHT * 7}
          />
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
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: `${theme.space[3]}px ${theme.space[5]}px`,
            borderBottom: `1px solid ${theme.color.border}`,
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
            <Clock size={16} aria-hidden style={{ color: theme.color.inkMuted }} />
            <h2
              style={{
                margin: 0,
                fontSize: theme.type.size.md,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
              }}
            >
              {title}
            </h2>
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              appearance: 'none',
              background: 'transparent',
              border: 'none',
              padding: theme.space[2],
              color: theme.color.inkMuted,
              cursor: 'pointer',
            }}
          >
            <X size={20} aria-hidden />
          </button>
        </header>
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

// ─── Slot list ──────────────────────────────────────────────────────
//
// Scrollable column of time buttons. Each slot is a 40px row with
// the time label centred. Selected slot fills the accent disc; today's
// "now" minute would highlight if it falls on a slot, but for the
// typical clinic case the scheduler doesn't need that, so we skip it.
// Hairline gridlines on the hour boundary make the list scannable
// without separators between every quarter-hour.

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
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: `${theme.space[2]}px 0`,
        maxHeight,
      }}
    >
      {slots.map((slot) => {
        const isSelected = slot === value;
        const isHourBoundary = slot.endsWith(':00');
        return (
          <button
            key={slot}
            type="button"
            role="option"
            aria-selected={isSelected}
            onClick={() => onPick(slot)}
            style={{
              appearance: 'none',
              width: '100%',
              height: SLOT_HEIGHT,
              border: 'none',
              borderTop: isHourBoundary ? `1px solid ${theme.color.border}` : 'none',
              background: isSelected ? theme.color.accentBg : 'transparent',
              color: isSelected ? theme.color.accent : theme.color.ink,
              fontFamily: 'inherit',
              fontSize: theme.type.size.sm,
              fontWeight: isSelected
                ? theme.type.weight.semibold
                : isHourBoundary
                ? theme.type.weight.medium
                : theme.type.weight.regular,
              fontVariantNumeric: 'tabular-nums',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: `background 100ms ${theme.motion.easing.standard}, color 100ms ${theme.motion.easing.standard}`,
            }}
          >
            {slot}
          </button>
        );
      })}
    </div>
  );
};

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
