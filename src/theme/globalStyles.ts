import { theme } from './index.ts';

export function applyGlobalStyles(): void {
  if (document.getElementById('lng-global-styles')) return;
  const style = document.createElement('style');
  style.id = 'lng-global-styles';
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: ${theme.color.bg}; }
    /* The KioskStatusBar and BottomNav are position:fixed. iPadOS
       Safari rubber-bands the document body when the user pulls
       past the top or bottom — and crucially, drags every fixed
       child up/down with it, including those bars. overscroll-
       behavior:none alone doesn't kill the body bounce on iOS; the
       only reliable fix is to take the body out of the scroll
       picture entirely.

       Body is pinned to the layout viewport (position:fixed,
       inset:0). The real scroll container is #root, which has
       overscroll-behavior-y:contain so its own bottom/top can't
       chain a bounce up to the body either. Fixed children stay
       anchored because nothing moves underneath them. */
    html, body {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      overscroll-behavior: none;
    }
    #root {
      width: 100%;
      height: 100%;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior-y: contain;
      -webkit-overflow-scrolling: touch;
    }
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
    /* Suppress Safari/WebKit's native clear button on type="search"
       inputs — every search input in the app paints its own X on the
       right, and the native one was rendering alongside ours as a
       visible duplicate. */
    input[type="search"]::-webkit-search-cancel-button,
    input[type="search"]::-webkit-search-decoration,
    input[type="search"]::-webkit-search-results-button,
    input[type="search"]::-webkit-search-results-decoration {
      -webkit-appearance: none;
      appearance: none;
    }
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
