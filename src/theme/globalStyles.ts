import { theme } from './index.ts';

export function applyGlobalStyles(): void {
  if (document.getElementById('lng-global-styles')) return;
  const style = document.createElement('style');
  style.id = 'lng-global-styles';
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; }
    html, body, #root { margin: 0; padding: 0; height: 100%; background: ${theme.color.bg}; }
    /* Kill the iOS / iPadOS rubber-band over-scroll. Without this, the
       fixed kiosk status bar and bottom nav drift up/down when the user
       pulls past the top or bottom of the page — they're meant to be
       anchored. Supported on iOS 16+ and Chrome 63+, so universal on
       any tablet shipping in the last few years. */
    html, body { overscroll-behavior: none; }
    body {
      font-family: ${theme.type.family};
      font-size: ${theme.type.size.base}px;
      line-height: ${theme.type.leading.normal};
      color: ${theme.color.ink};
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
    }
    button { font-family: inherit; }
    /* iOS/iPadOS auto-zooms onto any focused input that's smaller than
       16px. Pin the floor at 16 across input, textarea and select so
       the kiosk never scales the page on focus. Components that want
       larger can override; smaller is what we're locking out. */
    input, textarea, select { font-family: inherit; font-size: 16px; }
    a { color: inherit; text-decoration: none; }
    :focus-visible {
      outline: 2px solid ${theme.color.accent};
      outline-offset: 2px;
      border-radius: 4px;
    }
    /* Tablet: stop accidental text selection on long press; but allow it in inputs */
    button, [role="button"] { user-select: none; -webkit-user-select: none; }
    /* No iOS tap highlight */
    * { -webkit-tap-highlight-color: transparent; }
  `;
  document.head.appendChild(style);
}
