// Denture Services brand tokens — what the customer sees when the
// modal opens on a denture-services.co.uk page. Brand visuals here,
// layout + behaviour live in shared/ and the per-step components.
//
// Two-bundle architecture: identical structure to widgets/venneir/
// brand.ts but with separate logo, accent, copy. The two bundles
// can diverge freely on visuals while still pulling behaviour from
// widgets/shared/* so common bug fixes land on both at once.

export const brand = {
  id: 'denture' as const,
  // Customer-facing name. Used in modal aria-label + body copy.
  name: 'Denture Services',
  tagline: 'Book your appointment',
  // Placeholder navy until denture-services.co.uk publishes its
  // own brand spec. Same hue as Venneir so the cross-storefront
  // visual language stays continuous; flip to the denture-specific
  // primary once Dylan supplies it. The widget reads brand.accent
  // for option-card selected borders, footer Next button, terms
  // checkbox accent, and trust signal icons.
  accent: '#083758',
  accentBg: 'rgba(8, 55, 88, 0.08)',
  // Logo for the modal header. Absolute URL because the bundle
  // runs on the host page (denture-services.co.uk) — relative
  // path would 404 against the wrong origin. Replace with a
  // denture-services-branded asset once it lands; for now we
  // share the Venneir mark so the bundle has something to render.
  logoSrc: 'https://lounge.venneir.com/black-venneir-logo.png',
  logoAlt: 'Denture Services',
};

export type Brand = typeof brand;
