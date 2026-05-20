import { useEffect } from 'react';

// useScrollLock
//
// Locks the page scroll while a modal-style surface is open AND
// compensates for the disappearing scrollbar width so the page
// content doesn't visibly shift sideways when the lock engages.
//
// Lounge pins document.body for iOS rubber-band (see globalStyles),
// so the actual scroll surface is #root. Toggling overflow:hidden on
// #root causes the scrollbar gutter to collapse the moment the
// modal mounts; without compensation, the centred portals + any
// fixed-position chrome (header, top bar, ribbons) jump ~7-8 px to
// the right in the same paint frame the modal slides in. That jump
// is the "flicker" / "glitch" staff reports when sheets and dialogs
// open.
//
// The compensation pads #root by the exact scrollbar width measured
// at lock time (window.innerWidth - documentElement.clientWidth).
// On systems with overlay scrollbars (macOS by default, mobile) the
// measured width is 0, so the pad is skipped — no behavioural cost
// on platforms where the bug doesn't exist.
//
// Every modal surface (BottomSheet, Dialog, NotificationsSheet,
// PhotoLightbox, PhotoGallery, CapturePopup, DateRangePicker, and
// any new bottom-up sheet built later) MUST route through this hook
// instead of toggling overflow inline. The original inline copies
// drifted out of sync with the BottomSheet fix and were the source
// of the cross-app glitch reports. Anyone adding a new modal:
// import { useScrollLock } from '@/lib/useScrollLock' and pass the
// open boolean. Do NOT inline overflow toggling in a useEffect.

export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const root = document.getElementById('root');
    if (!root) return;
    const prevOverflow = root.style.overflow;
    const prevPaddingRight = root.style.paddingRight;
    // Measure the scrollbar width BEFORE the lock — once overflow
    // flips to hidden the scrollbar collapses and the difference
    // becomes 0, so the pad has to come from the pre-lock layout.
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    if (scrollbarWidth > 0) {
      root.style.paddingRight = `${scrollbarWidth}px`;
    }
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = prevOverflow;
      root.style.paddingRight = prevPaddingRight;
    };
  }, [active]);
}
