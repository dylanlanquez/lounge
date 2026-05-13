// Venneir brand tokens — what the customer sees when the modal
// opens on a venneir.com Shopify page. Brand visuals here, layout
// + behaviour live in shared/ and the per-step components below.
//
// Two-bundle architecture (this file's twin is widgets/denture/brand.ts):
// the per-brand bundles can diverge in any visual or copy direction
// without porting back, but both still pull behaviour from
// widgets/shared/* so a slot-picker bug fix lands on both at once.

export const brand = {
  id: 'venneir' as const,
  // Customer-facing brand name. Used in modal aria-label, confirmation
  // copy, email greetings rendered client-side.
  name: 'Venneir',
  // Default tagline shown above the first step. Admin can override
  // via lng_widget_copy at runtime; this is the fallback.
  tagline: 'Book your appointment',
  // Accent colour for primary CTAs, focus rings, the on-brand chrome.
  // Mirrors theme.color.accent (#1F4D3A) so the modal contents feel
  // continuous with the rest of the Lounge surfaces.
  accent: '#1F4D3A',
  accentBg: 'rgba(31, 77, 58, 0.08)',
  // Logo for the modal header. Served from the lounge.venneir.com
  // public folder so the customer's browser caches it across all
  // venneir.com landing pages they bounce between.
  logoSrc: '/black-venneir-logo.png',
  logoAlt: 'Venneir',
};

export type Brand = typeof brand;
