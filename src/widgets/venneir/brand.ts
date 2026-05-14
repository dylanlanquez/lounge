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
  // Pulled from the venneir.com retainer-cart quiz modal (navy blue
  // #083758) so the widget reads as continuous with the storefront
  // the customer just came from — not the Lounge admin's green.
  accent: '#083758',
  accentBg: 'rgba(8, 55, 88, 0.08)',
  // Logo for the modal header. Must be an absolute URL — the bundle
  // runs on the host page (venneir.com or denture-services.co.uk),
  // so a relative path resolves against THAT origin and 404s. The
  // staff-app build serves /black-venneir-logo.png from
  // lounge.venneir.com (public/ → dist/) and the brand bundle
  // points back at it so the asset is shared with the in-app UI.
  logoSrc: 'https://lounge.venneir.com/black-venneir-logo.png',
  logoAlt: 'Venneir',
};

export type Brand = typeof brand;
