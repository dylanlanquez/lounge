import { theme } from './index.ts';

export function applyGlobalStyles(): void {
  if (document.getElementById('lng-global-styles')) return;
  const style = document.createElement('style');
  style.id = 'lng-global-styles';
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; }
    html, body, #root { margin: 0; padding: 0; height: 100%; background: ${theme.color.bg}; }
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
    input, textarea, select { font-family: inherit; font-size: inherit; }
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
