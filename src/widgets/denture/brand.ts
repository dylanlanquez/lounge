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
  // Accent colour chosen distinct enough from venneir's deep green
  // that an internal team member glancing at a screenshot can tell
  // the brands apart. Same satin-finish character though so the
  // visual language family stays recognisable.
  accent: '#1F4D3A',
  accentBg: 'rgba(31, 77, 58, 0.08)',
  // Logo for the modal header. Replace with denture-services
  // branding once the assets land — currently falls back to the
  // shared venneir mark so the bundle compiles before the brand
  // assets arrive.
  logoSrc: '/black-venneir-logo.png',
  logoAlt: 'Denture Services',
};

export type Brand = typeof brand;
